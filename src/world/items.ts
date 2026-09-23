import type { Bot } from 'mineflayer'

/** Generic names the strategist may use so plans do not depend on which tree species spawned nearby. */
const GROUPS: Record<string, (name: string) => boolean> = {
  log: (n) => (n.endsWith('_log') || n.endsWith('_stem')) && !n.startsWith('stripped_'),
  planks: (n) => n.endsWith('_planks'),
  coal_any: (n) => n === 'coal' || n === 'charcoal',
  food: (n) => FOOD.has(n),
  pickaxe: (n) => n.endsWith('_pickaxe'),
}

export const FUEL: Record<string, number> = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, lava_bucket: 100 }
export function fuelValue(name: string): number {
  if (FUEL[name]) return FUEL[name]
  if (name.endsWith('_planks') || GROUPS.log(name)) return 1.5
  if (name === 'stick') return 0.5
  return 0
}

/** Edible items, filled from the game registry at spawn. */
export const FOOD = new Set<string>()

/** Hostile and passive creature names, from the registry's entity categories. */
export const HOSTILE = new Set<string>()
export const PASSIVE = new Set<string>()

export function initGameData(bot: Bot) {
  const reg = bot.registry as any
  for (const food of reg.foodsArray ?? []) FOOD.add(food.name)
  for (const e of reg.entitiesArray ?? []) {
    if (e.category === 'Hostile mobs') HOSTILE.add(e.name)
    else if (e.category === 'Passive mobs') PASSIVE.add(e.name)
  }
}

export function isGroup(name: string) {
  return name in GROUPS
}

export function matchesItem(want: string, actual: string) {
  return GROUPS[want] ? GROUPS[want](actual) : want === actual
}

export function countItem(bot: Bot, name: string): number {
  return bot.inventory.items().filter((i) => matchesItem(name, i.name)).reduce((s, i) => s + i.count, 0)
}

export function inventoryMap(bot: Bot): Record<string, number> {
  const inv: Record<string, number> = {}
  for (const item of bot.inventory.items()) inv[item.name] = (inv[item.name] ?? 0) + item.count
  return inv
}

export function knownName(bot: Bot, name: string): boolean {
  return isGroup(name) || !!bot.registry.itemsByName[name] || !!bot.registry.blocksByName[name]
}

const TIERS = ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite']
export function bestTool(bot: Bot, kind: 'pickaxe' | 'axe' | 'sword' | 'shovel'): string | null {
  let best: string | null = null
  let rank = -1
  for (const item of bot.inventory.items()) {
    if (!item.name.endsWith('_' + kind)) continue
    const r = TIERS.indexOf(item.name.split('_')[0])
    if (r > rank) (rank = r), (best = item.name)
  }
  return best
}

export function pickaxeTier(bot: Bot): number {
  const p = bestTool(bot, 'pickaxe')
  return p ? TIERS.indexOf(p.split('_')[0]) : -1
}

/** Remaining durability of the best pickaxe, 0..1, or null without one. */
export function pickaxeHealth(bot: Bot): { name: string; remaining: number } | null {
  const name = bestTool(bot, 'pickaxe')
  if (!name) return null
  const item = bot.inventory.items().filter((i) => i.name === name).sort((a, b) => ((a as any).durabilityUsed ?? 0) - ((b as any).durabilityUsed ?? 0))[0] as any
  const max = bot.registry.items[item.type]?.maxDurability ?? 1
  return { name, remaining: Math.max(0, 1 - (item.durabilityUsed ?? 0) / max) }
}
