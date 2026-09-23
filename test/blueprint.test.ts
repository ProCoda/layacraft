import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { expand, footprint, validate, type Blueprint } from '../src/world/blueprint.ts'

const require = createRequire(import.meta.url)
const bot = { registry: require('prismarine-registry')('1.21.4') } as any

const hut: Blueprint = {
  name: 'hut',
  description: 'small plank hut',
  parts: [
    { label: 'floor', block: 'cobblestone', shape: 'fill', from: [0, 0, 0], to: [4, 0, 4] },
    { label: 'walls', block: 'oak_planks', shape: 'walls', from: [0, 1, 0], to: [4, 3, 4] },
    { label: 'roof', block: 'oak_planks', shape: 'fill', from: [0, 4, 0], to: [4, 4, 4] },
    { label: 'doorway', block: 'air', shape: 'fill', from: [2, 1, 0], to: [2, 2, 0] },
    { label: 'door', block: 'oak_door', shape: 'fill', from: [2, 1, 0], to: [2, 1, 0] },
    { label: 'light', block: 'torch', shape: 'fill', from: [2, 1, 2], to: [2, 1, 2] },
  ],
}

test('expands primitives with later parts overriding earlier ones', () => {
  const cells = expand(hut)
  const at = (x: number, y: number, z: number) => cells.find((c) => c[0] === x && c[1] === y && c[2] === z)?.[3]
  assert.equal(at(0, 2, 0), 'oak_planks')
  assert.equal(at(2, 2, 2), undefined, 'walls are hollow inside')
  assert.equal(at(2, 1, 0), 'oak_door')
  assert.equal(at(2, 2, 0), 'oak_door#top', 'upper door half is placed by the game')
  assert.deepEqual(footprint(cells), { w: 5, d: 5, h: 5 })
  assert.equal(cells.filter((c) => c[3] === 'oak_planks').length, 16 * 3 - 2 + 25 - 0)
})

test('validation rejects unknown blocks and out-of-bounds parts', () => {
  assert.deepEqual(validate(bot, hut), [])
  const bad = { ...hut, parts: [...hut.parts, { label: 'x', block: 'magic_brick', shape: 'fill' as const, from: [0, 0, 0] as [number, number, number], to: [20, 0, 0] as [number, number, number] }] }
  const errors = validate(bot, bad)
  assert.ok(errors.some((e) => /magic_brick/.test(e)))
  assert.ok(errors.some((e) => /coordinates/.test(e)))
})
