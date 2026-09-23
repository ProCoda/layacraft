/**
 * Structures the bot can build. The strategist designs a blueprint as a few box primitives in relative coordinates;
 * code expands it into cells, derives the bill of materials (which the acquisition planner then gathers), picks a
 * site from the real terrain, and verifies completion block by block. No structure is hand-written here.
 */
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'

export interface Part {
  label: string
  block: string // a placeable block id, or "air" to keep a cell empty (doorways, windows, interior)
  shape: 'fill' | 'walls' | 'hollow'
  from: [number, number, number]
  to: [number, number, number]
}

export interface Blueprint { name: string; description: string; parts: Part[] }

export interface Site {
  blueprint: Blueprint
  origin: { x: number; y: number; z: number } | null
  /** Expanded target: [dx, dy, dz, block]. y = 0 is the first layer above the ground. */
  cells: [number, number, number, string][]
}

export const LIMITS = { size: 13, height: 10, blocks: 450 }

export const BLUEPRINT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'description', 'parts'],
  properties: {
    name: { type: 'string' },
    description: { type: 'string' },
    parts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'block', 'shape', 'from', 'to'],
        properties: {
          label: { type: 'string' },
          block: { type: 'string' },
          shape: { type: 'string', enum: ['fill', 'walls', 'hollow'] },
          from: { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 },
          to: { type: 'array', items: { type: 'integer' }, minItems: 3, maxItems: 3 },
        },
      },
    },
  },
}

/** Blocks that change id when placed against a wall (torch -> wall_torch): compare without the "wall_" part. */
export function sameBlock(actual: string, expected: string) {
  if (actual === expected) return true
  const norm = (n: string) => n.replace('wall_', '')
  return norm(actual) === norm(expected)
}

/** The item that places a block (almost always the same id). */
export function itemFor(bot: Bot, block: string): string | null {
  if (bot.registry.itemsByName[block]) return block
  const plain = block.replace('wall_', '')
  return bot.registry.itemsByName[plain] ? plain : null
}

export function validate(bot: Bot, bp: Blueprint): string[] {
  const errors: string[] = []
  for (const p of bp.parts) {
    if (p.block !== 'air' && (!bot.registry.blocksByName[p.block] || !itemFor(bot, p.block))) errors.push(`${p.label}: "${p.block}" is not a placeable block id`)
    const [x0, y0, z0] = p.from
    const [x1, y1, z1] = p.to
    if ([x0, x1, z0, z1].some((v) => v < 0 || v >= LIMITS.size) || [y0, y1].some((v) => v < 0 || v >= LIMITS.height)) {
      errors.push(`${p.label}: coordinates must stay within x,z 0..${LIMITS.size - 1} and y 0..${LIMITS.height - 1}`)
    }
  }
  const cells = expand(bp)
  const solid = cells.filter((c) => c[3] !== 'air').length
  if (!solid) errors.push('blueprint places no blocks')
  if (solid > LIMITS.blocks) errors.push(`blueprint places ${solid} blocks; keep it under ${LIMITS.blocks}`)
  return errors
}

/** Later parts override earlier ones, so a doorway ("air") can be cut out of a wall. */
export function expand(bp: Blueprint): Site['cells'] {
  const grid = new Map<string, [number, number, number, string]>()
  for (const p of bp.parts) {
    const [xa, ya, za] = p.from
    const [xb, yb, zb] = p.to
    const [x0, x1] = [Math.min(xa, xb), Math.max(xa, xb)]
    const [y0, y1] = [Math.min(ya, yb), Math.max(ya, yb)]
    const [z0, z1] = [Math.min(za, zb), Math.max(za, zb)]
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++) {
          const edgeX = x === x0 || x === x1
          const edgeZ = z === z0 || z === z1
          const edgeY = y === y0 || y === y1
          if (p.shape === 'walls' && !(edgeX || edgeZ)) continue
          if (p.shape === 'hollow' && !(edgeX || edgeZ || edgeY)) continue
          grid.set(`${x},${y},${z}`, [x, y, z, p.block])
        }
  }
  // Doors occupy two cells: the upper half is placed by the game, not by us.
  for (const [x, y, z, block] of [...grid.values()]) {
    if (block.endsWith('_door')) grid.set(`${x},${y + 1},${z}`, [x, y + 1, z, `${block}#top`])
  }
  return [...grid.values()]
}

export function footprint(cells: Site['cells']) {
  let w = 0
  let d = 0
  let h = 0
  for (const [x, y, z] of cells) (w = Math.max(w, x + 1)), (d = Math.max(d, z + 1)), (h = Math.max(h, y + 1))
  return { w, d, h }
}

/** Pick the site near the bot with the most solid ground under the footprint and the least in the way above it. */
export function chooseOrigin(bot: Bot, cells: Site['cells']): Vec3 | null {
  const { w, d, h } = footprint(cells)
  const me = bot.entity.position.floored()
  type Candidate = { pos: Vec3; score: number }
  let best = null as Candidate | null
  for (let r = 2; r <= 18; r += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      for (const dz of [-r, r]) {
        for (const [ox, oz] of [[dx, dz], [dz, dx]]) {
          const base = groundAt(bot, me.x + ox, me.z + oz, me.y)
          if (!base) continue
          let ground = 0
          let blocked = 0
          let liquid = 0
          for (let x = 0; x < w; x++)
            for (let z = 0; z < d; z++) {
              const below = bot.blockAt(base.offset(x, -1, z))
              if (below?.boundingBox === 'block') ground++
              if (below && ['water', 'lava'].includes(below.name)) liquid++
              for (let y = 0; y < h; y++) {
                const b = bot.blockAt(base.offset(x, y, z))
                if (b && b.boundingBox === 'block') blocked++
              }
            }
          if (liquid) continue
          const score = ground / (w * d) - blocked / (w * d * h) * 2
          if (!best || score > best.score) best = { pos: base, score }
        }
      }
    }
    if ((best as Candidate | null) && (best as Candidate).score > 0.9) break
  }
  const found = best as Candidate | null
  return found && found.score > 0.5 ? found.pos : null
}

function groundAt(bot: Bot, x: number, z: number, fromY: number): Vec3 | null {
  for (let y = fromY + 6; y >= fromY - 6; y--) {
    const below = bot.blockAt(new Vec3(x, y - 1, z))
    const here = bot.blockAt(new Vec3(x, y, z))
    if (!below || !here) return null
    if (below.boundingBox === 'block' && here.boundingBox === 'empty' && here.name !== 'water') return new Vec3(x, y, z)
  }
  return null
}

export interface Progress { done: number; total: number; remaining: Site['cells']; missing: Record<string, number> }

/** What is already built, what is left, and which materials the remaining cells still need beyond the inventory. */
export function progress(bot: Bot, site: Site): Progress {
  const cells = site.cells.filter((c) => !c[3].endsWith('#top'))
  const remaining: Site['cells'] = []
  let done = 0
  for (const cell of cells) {
    if (!site.origin) {
      remaining.push(cell)
      continue
    }
    const b = bot.blockAt(new Vec3(site.origin.x + cell[0], site.origin.y + cell[1], site.origin.z + cell[2]))
    const ok = cell[3] === 'air' ? !b || b.boundingBox === 'empty' : !!b && sameBlock(b.name, cell[3])
    if (ok) done++
    else if (b || !site.origin) remaining.push(cell)
  }
  const need: Record<string, number> = {}
  for (const cell of remaining) {
    if (cell[3] === 'air') continue
    const item = itemFor(bot, cell[3])
    if (item) need[item] = (need[item] ?? 0) + 1
  }
  const missing: Record<string, number> = {}
  for (const [item, n] of Object.entries(need)) {
    const have = bot.inventory.items().filter((i) => i.name === item).reduce((s, i) => s + i.count, 0)
    if (have < n) missing[item] = n - have
  }
  return { done, total: cells.length, remaining, missing }
}
