/**
 * World knowledge the bot is not born with. Nothing here is hand-written game strategy:
 * - `priors` and `smelting` come from the strategist LLM once, are validated against the registry, and are cached;
 * - `sightings` are learned from what the bot actually sees, and override priors once there is enough evidence;
 * - `skillStats` are measured outcomes of each skill.
 * The file is shared by every server and seed: Minecraft rules do not depend on the world.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Bot } from 'mineflayer'

export const ABUNDANCE = ['very_common', 'common', 'uncommon', 'rare', 'very_rare'] as const
export type Abundance = (typeof ABUNDANCE)[number]
export interface ResourcePrior { y_min: number; y_max: number; y_best: number; surface: boolean; biomes: string[]; abundance?: Abundance }

interface Sightings { y: Record<string, number>; biomes: Record<string, number>; total: number }

interface Data {
  priors: Record<string, ResourcePrior>
  smelting: Record<string, string> // input -> output
  notSmeltable: string[] // outputs we asked about that no smelting recipe produces
  sightings: Record<string, Sightings>
  mobs: Record<string, number> // creature sightings (distinct entities), learned
  drops: Record<string, { mined: number; items: Record<string, number> }> // measured yields per block broken
  skillStats: Record<string, { ok: number; fail: number; ms: number }>
}

export interface Whereabouts {
  source: 'learned' | 'prior' | 'none'
  yBest: number | null
  yMin: number | null
  yMax: number | null
  surface: boolean
  biomes: string[]
  evidence: number
  abundance: Abundance | null
}

const BUCKET = 8
const LEARNED_AFTER = 12 // sightings needed before observations override the prior

export class Knowledge {
  data: Data = { priors: {}, smelting: {}, notSmeltable: [], sightings: {}, mobs: {}, drops: {}, skillStats: {} }
  private file = path.resolve('memory', 'knowledge.json')
  private counted = new Set<string>()
  private dirty = false

  constructor(private bot: Bot) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }
    } catch {}
    setInterval(() => this.flush(), 10_000).unref()
  }

  flush() {
    if (!this.dirty) return
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 1))
    this.dirty = false
  }

  /** Learn where blocks occur from every observation (each position counted once per session). */
  observe(block: { name: string; position: { x: number; y: number; z: number } }, biome?: string) {
    const key = `${block.position.x},${block.position.y},${block.position.z}`
    if (this.counted.has(key)) return
    this.counted.add(key)
    if (this.counted.size > 200_000) this.counted.clear()
    const s = (this.data.sightings[block.name] ??= { y: {}, biomes: {}, total: 0 })
    const bucket = String(Math.floor(block.position.y / BUCKET) * BUCKET)
    s.y[bucket] = (s.y[bucket] ?? 0) + 1
    if (biome) s.biomes[biome] = (s.biomes[biome] ?? 0) + 1
    s.total++
    this.dirty = true
  }

  private mobsCounted = new Set<number>()

  observeMob(name: string, entityId: number) {
    if (this.mobsCounted.has(entityId)) return
    this.mobsCounted.add(entityId)
    this.data.mobs[name] = (this.data.mobs[name] ?? 0) + 1
    this.dirty = true
  }

  mobSightings(name: string) {
    return this.data.mobs[name] ?? 0
  }

  where(block: string): Whereabouts {
    const s = this.data.sightings[block]
    const prior = this.data.priors[block]
    if (s && s.total >= LEARNED_AFTER) {
      const buckets = Object.entries(s.y).map(([y, n]) => [Number(y), n] as const).sort((a, b) => a[0] - b[0])
      const best = buckets.reduce((a, b) => (b[1] > a[1] ? b : a))
      // 10th..90th percentile of observed heights.
      let acc = 0
      let lo = buckets[0][0]
      let hi = buckets.at(-1)![0]
      for (const [y, n] of buckets) {
        const before = acc
        acc += n
        if (before < s.total * 0.1 && acc >= s.total * 0.1) lo = y
        if (before < s.total * 0.9 && acc >= s.total * 0.9) hi = y + BUCKET
      }
      const biomes = Object.entries(s.biomes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([b]) => b)
      return { source: 'learned', yBest: best[0] + BUCKET / 2, yMin: lo, yMax: hi, surface: prior?.surface ?? false, biomes, evidence: s.total, abundance: prior?.abundance ?? null }
    }
    if (prior) return { source: 'prior', yBest: prior.y_best, yMin: prior.y_min, yMax: prior.y_max, surface: prior.surface, biomes: prior.biomes, evidence: s?.total ?? 0, abundance: prior.abundance ?? null }
    return { source: 'none', yBest: null, yMin: null, yMax: null, surface: false, biomes: [], evidence: s?.total ?? 0, abundance: null }
  }

  describeWhere(block: string): string {
    const w = this.where(block)
    if (w.source === 'none') return `location of ${block} unknown`
    const where = w.surface ? 'on the surface' : `around y ${w.yBest} (y ${w.yMin} to ${w.yMax})`
    const biomes = w.biomes.length ? `, biomes: ${w.biomes.slice(0, 3).join(', ')}` : ''
    return `${block} is found ${where}${biomes} [${w.source === 'learned' ? `learned from ${w.evidence} sightings` : 'prior knowledge'}]`
  }

  smeltOutput(input: string): string | undefined {
    return this.data.smelting[input]
  }

  smeltInputs(output: string): string[] {
    return Object.entries(this.data.smelting).filter(([, out]) => out === output).map(([input]) => input)
  }

  /** Whether we already asked about how `item` is produced by smelting. */
  smeltingKnown(output: string) {
    return this.data.notSmeltable.includes(output) || this.smeltInputs(output).length > 0
  }

  needsFacts(blocks: string[], items: string[]) {
    return {
      blocks: blocks.filter((b) => !this.data.priors[b]),
      items: items.filter((i) => !this.smeltingKnown(i) && !this.data.smelting[i]),
    }
  }

  /** Merge LLM-provided facts, keeping only names the game registry knows. */
  learnFacts(facts: { resources: (Omit<ResourcePrior, 'abundance'> & { block: string; abundance?: string })[]; smelting: { input: string; output: string }[] }, askedItems: string[]) {
    const reg = this.bot.registry
    for (const r of facts.resources) {
      if (!reg.blocksByName[r.block]) continue
      const clamp = (y: number) => Math.max(-64, Math.min(320, Math.round(y)))
      this.data.priors[r.block] = { y_min: clamp(Math.min(r.y_min, r.y_max)), y_max: clamp(Math.max(r.y_min, r.y_max)), y_best: clamp(r.y_best), surface: !!r.surface, biomes: r.biomes.filter((b) => reg.biomesByName?.[b]).slice(0, 6), abundance: ABUNDANCE.includes(r.abundance as Abundance) ? (r.abundance as Abundance) : 'uncommon' }
    }
    for (const s of facts.smelting) {
      if (reg.itemsByName[s.input] && reg.itemsByName[s.output]) this.data.smelting[s.input] = s.output
    }
    for (const item of askedItems) if (!this.smeltInputs(item).length && !this.data.notSmeltable.includes(item)) this.data.notSmeltable.push(item)
    this.dirty = true
    this.flush()
  }

  /** Registry loot tables flatten probabilities (leaves "always" drop apples); measured yields replace them. */
  recordDrop(block: string, gained: Record<string, number>) {
    const d = (this.data.drops[block] ??= { mined: 0, items: {} })
    d.mined++
    for (const [item, n] of Object.entries(gained)) if (n > 0) d.items[item] = (d.items[item] ?? 0) + n
    this.dirty = true
  }

  /** Measured items per block, or null until the block was broken a few times. */
  measuredYield(block: string, item: string): number | null {
    const d = this.data.drops[block]
    if (!d || d.mined < 3) return null
    return (d.items[item] ?? 0) / d.mined
  }

  recordSkill(skill: string, ok: boolean, ms: number) {
    const s = (this.data.skillStats[skill] ??= { ok: 0, fail: 0, ms: 0 })
    ok ? s.ok++ : s.fail++
    s.ms += ms
    this.dirty = true
  }

  skillNote(skill: string): string {
    const s = this.data.skillStats[skill]
    if (!s || s.ok + s.fail < 3) return ''
    const n = s.ok + s.fail
    return ` [past success ${Math.round((100 * s.ok) / n)}% of ${n}, about ${Math.round(s.ms / n / 1000)}s each]`
  }
}
