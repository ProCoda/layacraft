/** Persistent memory across runs: places, deaths and strategist lessons. This is what makes the bot adapt over time. */
import fs from 'node:fs'
import path from 'node:path'
import type { Vec3 } from 'vec3'
import type { Site } from './blueprint.ts'

interface Place { x: number; y: number; z: number; t: number }
interface Data {
  places: Record<string, Place[]>
  lessons: string[]
  deaths: { cause: string; y: number; t: number }[]
  explored: Record<string, number>
  visited: Record<string, number>
  sites: Record<string, Site>
}

export class Memory {
  data: Data = { places: {}, lessons: [], deaths: [], explored: {}, visited: {}, sites: {} }
  private file: string

  constructor(scope: string) {
    this.file = path.resolve('memory', `${scope.replace(/[^a-z0-9_.-]/gi, '_')}.json`)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) }
    } catch {}
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2))
  }

  remember(kind: string, pos: Vec3) {
    const list = (this.data.places[kind] ??= [])
    if (list.some((p) => Math.abs(p.x - pos.x) + Math.abs(p.y - pos.y) + Math.abs(p.z - pos.z) < 4)) return
    list.unshift({ x: pos.x, y: pos.y, z: pos.z, t: Date.now() })
    list.length = Math.min(list.length, 8)
    this.save()
  }

  forget(kind: string, pos: Vec3) {
    const list = this.data.places[kind]
    if (!list) return
    this.data.places[kind] = list.filter((p) => !(p.x === pos.x && p.y === pos.y && p.z === pos.z))
    this.save()
  }

  nearest(kind: string, from: Vec3): Place | null {
    const list = this.data.places[kind] ?? []
    return [...list].sort((a, b) => from.distanceTo(a as any) - from.distanceTo(b as any))[0] ?? null
  }

  /** Near-duplicate lessons replace the older version instead of piling up. */
  addLesson(lesson: string) {
    const text = lesson.trim()
    if (!text) return
    const words = wordSet(text)
    this.data.lessons = this.data.lessons.filter((l) => similarity(words, wordSet(l)) < 0.45)
    this.data.lessons.push(text)
    this.data.lessons = this.data.lessons.slice(-12)
    this.save()
  }

  /** Chunks the bot has stood in; drives the "unexplored" part of directional perception. */
  visit(chunk: string) {
    if (this.data.visited[chunk]) return
    this.data.visited[chunk] = Date.now()
    this.save()
  }

  markExplored(direction: string, cell: string) {
    const key = `${cell}:${direction}`
    this.data.explored[key] = (this.data.explored[key] ?? 0) + 1
    this.save()
  }

  exploredCount(direction: string, cell: string) {
    return this.data.explored[`${cell}:${direction}`] ?? 0
  }
}

function wordSet(text: string) {
  return new Set(text.toLowerCase().match(/[a-z_]{4,}/g) ?? [])
}

function similarity(a: Set<string>, b: Set<string>) {
  let shared = 0
  for (const w of a) if (b.has(w)) shared++
  return shared / Math.max(1, Math.min(a.size, b.size))
}
