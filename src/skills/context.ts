import type { Bot } from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { Crafting } from '../world/crafting.ts'
import type { Knowledge } from '../world/knowledge.ts'
import type { Memory } from '../world/memory.ts'

export const { goals, Movements } = pathfinderPkg as any

export interface SkillContext {
  bot: Bot
  signal: AbortSignal
  crafting: Crafting
  memory: Memory
  knowledge: Knowledge
  /** Items the current subgoal still needs, so skills size their batch without a model doing arithmetic. */
  need: { item: string; count: number } | null
  /** Blocks worth stopping for while exploring or tunnelling. */
  seek: string[]
  /** Creatures worth stopping for while exploring (animals when food is needed). */
  seekEntities?: string[]
}

export interface SkillResult { ok: boolean; message: string }
export const ok = (message: string): SkillResult => ({ ok: true, message })
export const fail = (message: string): SkillResult => ({ ok: false, message })

export class Aborted extends Error {}

export function checkAbort(ctx: SkillContext) {
  if (ctx.signal.aborted) throw new Aborted('interrupted')
}

export function stopEverything(bot: Bot) {
  const b = bot as any
  try { b.pathfinder?.stop() } catch {}
  try { b.pathfinder?.setGoal(null) } catch {}
  try { bot.stopDigging() } catch {}
  bot.clearControlStates()
}

/** Pathfind to a goal; resolves false instead of throwing when no path exists. Honors abort and a timeout. */
export async function go(ctx: SkillContext, goal: any, timeoutMs = 60_000): Promise<boolean> {
  checkAbort(ctx)
  const bot = ctx.bot as any
  if (bot.safeMovements && bot.pathfinder.movements !== bot.safeMovements) bot.pathfinder.setMovements(bot.safeMovements)
  let timer: NodeJS.Timeout | undefined
  const onAbort = () => stopEverything(ctx.bot)
  ctx.signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), timeoutMs))),
    ])
    return true
  } catch (e) {
    checkAbort(ctx)
    stopEverything(ctx.bot)
    return false
  } finally {
    clearTimeout(timer)
    ctx.signal.removeEventListener('abort', onAbort)
  }
}

export function sleep(ctx: SkillContext, ms: number) {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    ctx.signal.addEventListener('abort', () => (clearTimeout(t), reject(new Aborted('interrupted'))), { once: true })
  })
}

/** Place an inventory block on solid ground next to the bot and return the placed block. Digs a nook if boxed in. */
export async function placeNear(ctx: SkillContext, itemName: string): Promise<any | null> {
  const { bot } = ctx
  const base = bot.entity.position.floored()
  const offsets = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [0, 2], [-2, 0], [0, -2]]
  const tryPlace = async (target: Vec3) => {
    const item = bot.inventory.items().find((i) => i.name === itemName)
    const below = bot.blockAt(target.offset(0, -1, 0))
    if (!item || !below || below.boundingBox !== 'block') return null
    try {
      await bot.equip(item, 'hand')
      await bot.lookAt(target.offset(0.5, 0.5, 0.5), true)
      await bot.placeBlock(below, new Vec3(0, 1, 0))
    } catch {}
    const placed = bot.blockAt(target)
    return placed?.name === itemName ? placed : null
  }
  for (const dy of [0, 1, -1]) {
    for (const [dx, dz] of offsets) {
      const target = base.offset(dx, dy, dz)
      const here = bot.blockAt(target)
      if (!here || here.boundingBox !== 'empty' || here.name === 'water' || here.name === 'lava') continue
      const placed = await tryPlace(target)
      if (placed) return placed
    }
  }
  // Boxed in (1x1 shaft or tunnel end): dig out an adjacent block at foot level and place into the gap.
  for (const [dx, dz] of offsets.slice(0, 4)) {
    const target = base.offset(dx, 0, dz)
    const block = bot.blockAt(target)
    if (!block || block.boundingBox !== 'block' || !bot.canDigBlock(block)) continue
    const liquidNear = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]].some((d) => ['water', 'lava'].includes(bot.blockAt(target.offset(d[0], d[1], d[2]))?.name ?? ''))
    if (liquidNear) continue
    try {
      await bot.dig(block, true)
    } catch {
      continue
    }
    const placed = await tryPlace(target)
    if (placed) return placed
  }
  return null
}
