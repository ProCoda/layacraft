/**
 * Recipe executor planning: the exact sequence of crafts (with intermediates and the crafting table) for a target,
 * from a simulated inventory, plus the raw materials still missing. Arithmetic lives here, never in a model prompt.
 */
import type { Bot } from 'mineflayer'
import { countItem, inventoryMap, isGroup, matchesItem } from './items.ts'

export interface CraftStep { item: string; recipe: any; times: number }
export interface CraftPlan { ok: boolean; steps: CraftStep[]; missing: Record<string, number> }

type Inv = Record<string, number>

export class Crafting {
  constructor(private bot: Bot) {}

  plan(targets: { item: string; count: number }[], hasTable: boolean, inv: Inv = inventoryMap(this.bot)): CraftPlan {
    const sim = { ...inv }
    const steps: CraftStep[] = []
    const missing: Record<string, number> = {}
    let ok = true
    for (const t of targets) {
      const need = t.count
      if (!this.need(this.resolveName(t.item, sim), need, sim, steps, missing, new Set(), 0)) ok = false
    }
    const requiresTable = steps.some((s) => s.recipe.requiresTable)
    if (ok && requiresTable && !hasTable && !countItem(this.bot, 'crafting_table')) {
      // Plan the table first, from the same simulated inventory.
      const tableSim = { ...inv }
      const tableSteps: CraftStep[] = []
      if (!this.need('crafting_table', 1, tableSim, tableSteps, missing, new Set(), 0)) return { ok: false, steps: [], missing }
      tableSim.crafting_table = 0
      const rest: CraftStep[] = []
      for (const t of targets) {
        if (!this.need(this.resolveName(t.item, tableSim), t.count, tableSim, rest, missing, new Set(), 0)) return { ok: false, steps: [], missing }
      }
      return { ok: true, steps: [...tableSteps, ...rest], missing }
    }
    return { ok, steps: ok ? steps : [], missing }
  }

  /** "planks" -> the plank type we can actually make from logs in hand. */
  resolveName(item: string, inv: Inv): string {
    if (item === 'planks') {
      const log = Object.keys(inv).find((n) => inv[n] > 0 && n.endsWith('_log'))
      return log ? log.replace(/_log$/, '_planks') : 'oak_planks'
    }
    return item
  }

  private need(item: string, count: number, inv: Inv, steps: CraftStep[], missing: Record<string, number>, path: Set<string>, depth: number): boolean {
    // Take what we already have (groups accept any member, e.g. any planks for a crafting table recipe variant).
    let remaining = count
    for (const name of Object.keys(inv)) {
      if (remaining <= 0) break
      if (!matchesItem(item, name) || inv[name] <= 0) continue
      const take = Math.min(inv[name], remaining)
      inv[name] -= take
      remaining -= take
    }
    if (remaining <= 0) return true

    const id = this.bot.registry.itemsByName[item]?.id
    const recipes = id === undefined || isGroup(item) || path.has(item) || depth > 5 ? [] : this.bot.recipesAll(id, null, true)
    let firstFailure: Record<string, number> | null = null
    // Prefer recipes whose ingredients we already hold, so spruce logs make spruce planks.
    const ranked = [...recipes].sort((a, b) => this.score(b, inv) - this.score(a, inv))
    for (const recipe of ranked) {
      const times = Math.ceil(remaining / recipe.result.count)
      const trial = { ...inv }
      const trialSteps: CraftStep[] = []
      const trialMissing: Record<string, number> = {}
      const next = new Set(path).add(item)
      let feasible = true
      for (const d of recipe.delta) {
        if (d.count >= 0) continue
        const ingredient = this.bot.registry.items[d.id].name
        if (!this.need(ingredient, -d.count * times, trial, trialSteps, trialMissing, next, depth + 1)) feasible = false
      }
      if (feasible) {
        Object.assign(inv, trial)
        steps.push(...trialSteps, { item, recipe, times })
        const leftover = times * recipe.result.count - remaining
        if (leftover > 0) inv[item] = (inv[item] ?? 0) + leftover
        return true
      }
      firstFailure ??= trialMissing
    }
    if (firstFailure) for (const [k, v] of Object.entries(firstFailure)) missing[k] = (missing[k] ?? 0) + v
    else missing[this.rawName(item)] = (missing[this.rawName(item)] ?? 0) + remaining
    return false
  }

  private rawName(item: string) {
    return item.endsWith('_log') ? 'log' : item
  }

  private score(recipe: any, inv: Inv) {
    let s = 0
    for (const d of recipe.delta) if (d.count < 0 && (inv[this.bot.registry.items[d.id].name] ?? 0) > 0) s++
    return s
  }
}
