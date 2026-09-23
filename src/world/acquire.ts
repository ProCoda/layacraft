/**
 * Generic acquisition planner. For ANY item it derives, from game data only, every way to obtain it:
 *   have it | craft it (recipes) | smelt it (learned facts) | mine a block that drops it (with the tool the block needs)
 *   | kill a mob that drops it (loot tables)
 * and picks the cheapest chain. Costs come from the live situation: what is visible, remembered, where blocks were
 * learned to occur, which tools are in hand. Nothing here names a specific item, ore, depth or seed.
 */
import type { Bot } from 'mineflayer'
import type { Crafting } from './crafting.ts'
import { countItem, fuelValue, HOSTILE, inventoryMap, isGroup, matchesItem } from './items.ts'
import type { Knowledge } from './knowledge.ts'
import type { Memory } from './memory.ts'
import type { Perception } from './perception.ts'

export type Kind = 'have' | 'craft' | 'smelt' | 'mine' | 'kill' | 'unknown'

export interface Node {
  item: string
  count: number
  kind: Kind
  /** Total cost: consumed work (`own`) plus each reusable prerequisite (tool, station) counted once. */
  cost: number
  own: number
  durables: Record<string, number>
  children: Node[]
  blocks?: string[]
  mobs?: string[]
}

export type StepAction = 'MINE' | 'CRAFT' | 'SMELT' | 'HUNT' | 'FIND_BLOCK' | 'FIND_MOB'
export interface Step { action: StepAction; target: string; for: string }

export interface Acquisition {
  root: Node
  feasible: boolean
  lines: string[]
  frontier: Step[]
  seekBlocks: string[]
  seekMobs: string[]
}

const MAX_DEPTH = 9
/** Search cost of a block by abundance (seconds-ish); learned sightings discount it. */
const RARITY: Record<string, number> = { very_common: 5, common: 15, uncommon: 40, rare: 90, very_rare: 300 }

export class Acquirer {
  private blockSources = new Map<string, { block: string; yield: number }[]>()
  private mobSources = new Map<string, { mob: string; yield: number }[]>()
  private memo = new Map<string, Node>()
  private visiting = new Set<string>()
  private perception: Perception | null = null
  private tableNearby = false
  private furnaceNearby = false

  constructor(private bot: Bot, private crafting: Crafting, private knowledge: Knowledge, private memory: Memory) {
    const reg = bot.registry as any
    for (const loot of reg.blockLootArray ?? []) {
      for (const d of loot.drops) {
        if (d.silkTouch || !reg.itemsByName[d.item] || !reg.blocksByName[loot.block]) continue
        const avg = ((d.stackSizeRange?.[0] ?? 1) + (d.stackSizeRange?.[1] ?? d.stackSizeRange?.[0] ?? 1)) / 2
        const y = (d.dropChance ?? 1) * Math.max(avg, 0.5)
        if (y < 0.25 || loot.block.startsWith('infested_') || loot.block.includes('suspicious')) continue
        push(this.blockSources, d.item, { block: loot.block, yield: y })
      }
    }
    for (const loot of reg.entityLootArray ?? []) {
      for (const d of loot.drops) {
        if (!reg.itemsByName[d.item] || (d.dropChance ?? 1) < 0.3) continue
        push(this.mobSources, d.item, { mob: loot.entity, yield: (d.dropChance ?? 1) * ((d.stackSizeRange?.[0] ?? 1) + (d.stackSizeRange?.[1] ?? 1)) / 2 })
      }
    }
  }

  /** Every item/block name reachable from `item` through recipes, drops and tool requirements (for fact-finding). */
  closure(items: string[], limit = 150): { items: string[]; blocks: string[] } {
    const reg = this.bot.registry
    const seenItems = new Set<string>()
    const seenBlocks = new Set<string>()
    const queue = [...items]
    while (queue.length && seenItems.size < limit) {
      const item = queue.shift()!
      if (seenItems.has(item)) continue
      seenItems.add(item)
      for (const member of this.members(item).slice(0, 3)) {
        const id = reg.itemsByName[member]?.id
        if (id !== undefined) {
          for (const r of this.bot.recipesAll(id, null, true).slice(0, 2)) {
            for (const d of r.delta) if (d.count < 0) queue.push(reg.items[d.id].name)
          }
        }
        for (const s of (this.blockSources.get(member) ?? []).slice(0, 4)) {
          seenBlocks.add(s.block)
          const tools = Object.keys((reg.blocksByName[s.block] as any)?.harvestTools ?? {}).map((t) => reg.items[Number(t)].name)
          queue.push(...tools.slice(0, 2))
        }
      }
    }
    return { items: [...seenItems].filter((i) => !isGroup(i)), blocks: [...seenBlocks] }
  }

  /** Blocks that drop `item` (by measured yield when known): what to watch for opportunistically. */
  sourceBlocksOf(item: string): string[] {
    return this.members(item).flatMap((m) => (this.blockSources.get(m) ?? [])
      .filter((s) => (this.knowledge.measuredYield(s.block, m) ?? s.yield) >= 0.05)
      .map((s) => s.block))
  }

  plan(item: string, count: number, perception: Perception): Acquisition {
    this.memo.clear()
    this.visiting.clear()
    this.perception = perception
    const reg = this.bot.registry
    this.tableNearby = !!this.bot.findBlock({ matching: reg.blocksByName.crafting_table.id, maxDistance: 24 })
    this.furnaceNearby = !!this.bot.findBlock({ matching: reg.blocksByName.furnace.id, maxDistance: 24 })
    const root = this.best(item, count, 0)
    const frontier: Step[] = []
    const lines: string[] = []
    this.walk(root, frontier, lines, 0)
    const seekBlocks = new Set<string>()
    const seekMobs = new Set<string>()
    for (const s of frontier) {
      if (s.action === 'FIND_BLOCK' || s.action === 'MINE') seekBlocks.add(s.target)
      if (s.action === 'FIND_MOB' || s.action === 'HUNT') seekMobs.add(s.target)
    }
    return { root, feasible: Number.isFinite(root.cost), lines: lines.slice(0, 10), frontier, seekBlocks: [...seekBlocks], seekMobs: [...seekMobs] }
  }

  // ---- cost model -------------------------------------------------------------------------------------------------

  private members(item: string): string[] {
    if (!isGroup(item)) return [item]
    if (item === 'food') return (this.bot.registry as any).foodsArray.map((f: any) => f.name)
    return Object.keys(this.bot.registry.itemsByName).filter((n) => matchesItem(item, n))
  }

  private best(item: string, count: number, depth: number): Node {
    const key = `${item}:${count}`
    const cached = this.memo.get(key)
    if (cached) return cached
    const have = countItem(this.bot, item)
    if (have >= count) return this.remember(key, node(item, count, 'have', 0, {}, []))
    const need = count - have
    if (depth > MAX_DEPTH || this.visiting.has(item)) return impossible(item, need)

    this.visiting.add(item)
    const options: Node[] = []
    for (const member of this.members(item).slice(0, 40)) {
      options.push(this.viaMining(member, need, depth), this.viaKilling(member, need), this.viaSmelting(member, need, depth), this.viaCrafting(member, need, depth))
    }
    this.visiting.delete(item)
    const chosen = options.filter((o) => Number.isFinite(o.cost)).sort((a, b) => a.cost - b.cost)[0]
      ?? impossible(item, need)
    const labelled = isGroup(item) && chosen.item !== item ? { ...chosen, item: `${item} (${chosen.item})` } : chosen
    return this.remember(key, labelled)
  }

  private remember(key: string, node: Node) {
    this.memo.set(key, node)
    return node
  }

  private viaCrafting(item: string, count: number, depth: number): Node {
    const id = this.bot.registry.itemsByName[item]?.id
    if (id === undefined) return impossible(item, count)
    let best: Node = impossible(item, count, 'craft')
    for (const recipe of this.bot.recipesAll(id, null, true).slice(0, 14)) {
      const times = Math.ceil(count / recipe.result.count)
      const children: Node[] = []
      let own = 2 * times
      const durables: Record<string, number> = {}
      for (const d of recipe.delta) {
        if (d.count >= 0) continue
        const child = this.best(this.bot.registry.items[d.id].name, -d.count * times, depth + 1)
        children.push(child)
        own += child.own
        merge(durables, child.durables)
        if (!Number.isFinite(own)) break
      }
      if (recipe.requiresTable && !this.tableNearby && !countItem(this.bot, 'crafting_table') && item !== 'crafting_table') {
        const table = this.best('crafting_table', 1, depth + 1)
        children.push(table)
        merge(durables, asDurable(table))
      }
      const candidate = node(item, count, 'craft', own, durables, children)
      if (candidate.cost < best.cost) best = candidate
    }
    return best
  }

  private viaSmelting(item: string, count: number, depth: number): Node {
    const inputs = this.knowledge.smeltInputs(item)
    let best: Node = impossible(item, count, 'smelt')
    for (const input of inputs) {
      const source = this.best(input, count, depth + 1)
      const children = [source]
      let own = 11 * count + source.own
      const durables = { ...source.durables }
      if (!this.furnaceNearby && !countItem(this.bot, 'furnace')) {
        const furnace = this.best('furnace', 1, depth + 1)
        children.push(furnace)
        merge(durables, asDurable(furnace))
      }
      const hasFuel = this.bot.inventory.items().some((i) => fuelValue(i.name) > 0)
      if (!hasFuel) {
        const fuel = this.best('log', 1, depth + 1)
        children.push(fuel)
        own += fuel.own
        merge(durables, fuel.durables)
      }
      const candidate = node(item, count, 'smelt', own, durables, children)
      if (candidate.cost < best.cost) best = candidate
    }
    return best
  }

  private viaMining(item: string, count: number, depth: number): Node {
    const sources = this.blockSources.get(item) ?? []
    if (!sources.length) return impossible(item, count, 'mine')
    const scored = sources.map((s) => {
      const measured = this.knowledge.measuredYield(s.block, item)
      const yieldPerBlock = measured ?? s.yield
      if (yieldPerBlock < 0.05) return { ...s, tool: null, own: Infinity, durables: {}, cost: Infinity }
      const tool = this.toolNode(s.block, depth)
      const own = this.findBlockCost(s.block) + 3 * Math.ceil(count / yieldPerBlock)
      const durables = tool && tool.kind !== 'have' ? asDurable(tool) : {}
      return { ...s, tool, own, durables, cost: total(own, durables) }
    }).filter((s) => Number.isFinite(s.cost)).sort((a, b) => a.cost - b.cost)
    if (!scored.length) return impossible(item, count, 'mine')
    // Group equivalent sources (iron_ore + deepslate_iron_ore) so any of them can be targeted.
    const top = scored.filter((s) => s.cost <= scored[0].cost * 1.6 + 10).slice(0, 6)
    const first = top[0]
    const children = first.tool && first.tool.kind !== 'have' ? [first.tool] : []
    return { ...node(item, count, 'mine', first.own, first.durables, children), blocks: top.map((s) => s.block) }
  }

  private viaKilling(item: string, count: number): Node {
    const sources = this.mobSources.get(item) ?? []
    let best: Node = impossible(item, count, 'kill')
    for (const s of sources) {
      const visible = this.perception?.entities.some((e) => e.name === s.mob)
      const kills = Math.ceil(count / s.yield)
      // Rarity is learned: creatures seen often are cheap to find, never-seen ones are a last resort.
      const seen = this.knowledge.mobSightings(s.mob)
      const find = visible ? 6 : seen ? 30 + 300 / (seen + 2) : 300
      const danger = HOSTILE.has(s.mob) ? 30 : 0
      const cost = find + (8 + danger) * kills
      if (cost < best.cost) best = { ...node(item, count, 'kill', cost, {}, []), mobs: [s.mob] }
      else if (cost === best.cost) best.mobs!.push(s.mob)
    }
    return best
  }

  private toolNode(block: string, depth: number): Node | null {
    const tools = (this.bot.registry.blocksByName[block] as any)?.harvestTools
    if (!tools) return null
    const names = Object.keys(tools).map((id) => this.bot.registry.items[Number(id)].name)
    const held = names.find((n) => countItem(this.bot, n) > 0)
    if (held) return node(held, 1, 'have', 0, {}, [])
    if (depth > MAX_DEPTH - 2) return impossible(names[0], 1)
    return names.map((n) => this.best(n, 1, depth + 1)).sort((a, b) => a.cost - b.cost)[0]
  }

  /** How expensive finding a block is, from perception, memory and learned whereabouts. */
  private findBlockCost(block: string): number {
    const seen = this.perception?.blocks.get(block)
    if (seen) return 2 + seen.distance / 8
    const me = this.bot.entity.position
    const remembered = this.memory.nearest(block, me)
    if (remembered) return 8 + me.distanceTo(remembered as any) / 8
    const w = this.knowledge.where(block)
    if (w.source === 'none') return 600 // unknown: a last resort, never cheaper than a known chain
    const rarity = RARITY[w.abundance ?? 'uncommon'] * (w.source === 'learned' ? Math.max(0.3, 1 - w.evidence / 200) : 1)
    if (w.surface) return rarity + (me.y > 50 ? 15 : 35)
    const dy = Math.abs(me.y - (w.yBest ?? me.y))
    const inRange = w.yMin !== null && w.yMax !== null && me.y >= w.yMin && me.y <= w.yMax
    return rarity + (inRange ? 0 : 15 + dy / 3)
  }

  // ---- explanation ------------------------------------------------------------------------------------------------

  private walk(node: Node, frontier: Step[], lines: string[], depth: number) {
    if (node.kind === 'have' || depth > 12) return
    const indent = depth ? '  '.repeat(Math.min(depth, 3)) : ''
    const add = (s: Step) => {
      if (!frontier.some((f) => f.action === s.action && f.target === s.target)) frontier.push(s)
    }
    const name = node.item.replace(/ \(.*\)$/, '')
    switch (node.kind) {
      case 'craft': {
        const plan = this.crafting.plan([{ item: this.crafting.resolveName(name, inventoryMap(this.bot)), count: node.count }], this.tableNearby)
        lines.push(`${indent}${node.item} x${node.count}: craft from ${node.children.map((c) => c.item).join(' + ')}${plan.ok ? ' (craftable now)' : ''}`)
        if (plan.ok) add({ action: 'CRAFT', target: name, for: name })
        else for (const c of node.children) this.walk(c, frontier, lines, depth + 1)
        return
      }
      case 'smelt': {
        const input = node.children[0]
        lines.push(`${indent}${node.item} x${node.count}: smelt ${input.item}`)
        const inputName = input.item.replace(/ \(.*\)$/, '')
        if (countItem(this.bot, inputName) > 0 || input.kind === 'have') add({ action: 'SMELT', target: inputName, for: name })
        for (const c of node.children) if (!(c === input && countItem(this.bot, inputName) > 0)) this.walk(c, frontier, lines, depth + 1)
        return
      }
      case 'mine': {
        const tool = node.children[0]
        const blocks = node.blocks ?? []
        const visible = blocks.filter((b) => this.perception?.blocks.has(b))
        const where = visible.length ? 'visible nearby' : this.knowledge.describeWhere(blocks[0])
        lines.push(`${indent}${node.item} x${node.count}: mine ${blocks.slice(0, 3).join(' or ')}${tool ? `, needs ${tool.item} first` : ''}; ${where}`)
        if (tool) this.walk(tool, frontier, lines, depth + 1)
        else if (visible.length) for (const b of visible) add({ action: 'MINE', target: b, for: name })
        else for (const b of blocks) add({ action: 'FIND_BLOCK', target: b, for: name })
        return
      }
      case 'kill': {
        const mobs = node.mobs ?? []
        const visible = mobs.filter((m) => this.perception?.entities.some((e) => e.name === m))
        lines.push(`${indent}${node.item} x${node.count}: kill ${mobs.slice(0, 4).join(' or ')}${visible.length ? ' (visible)' : ''}`)
        for (const m of visible.length ? visible : mobs) add({ action: visible.length ? 'HUNT' : 'FIND_MOB', target: m, for: name })
        return
      }
      default:
        lines.push(`${indent}${node.item} x${node.count}: no known way to obtain it yet`)
    }
  }
}

function node(item: string, count: number, kind: Kind, own: number, durables: Record<string, number>, children: Node[]): Node {
  return { item, count, kind, own, durables, cost: total(own, durables), children }
}

function impossible(item: string, count: number, kind: Kind = 'unknown'): Node {
  return node(item, count, kind, Infinity, {}, [])
}

function total(own: number, durables: Record<string, number>) {
  let sum = own
  for (const v of Object.values(durables)) sum += v
  return sum
}

function merge(into: Record<string, number>, from: Record<string, number>) {
  for (const [k, v] of Object.entries(from)) into[k] = Math.max(into[k] ?? 0, v)
}

/** A tool or station used as a prerequisite: its own work plus its own prerequisites, flattened so each counts once. */
function asDurable(n: Node): Record<string, number> {
  const d = { ...n.durables }
  if (n.kind !== 'have') d[n.item] = Math.max(d[n.item] ?? 0, n.own)
  return d
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const list = map.get(key) ?? []
  list.push(value)
  map.set(key, list)
}
