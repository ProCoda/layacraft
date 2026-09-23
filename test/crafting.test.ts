import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Crafting } from '../src/world/crafting.ts'
import { validatePlan } from '../src/brain/plan.ts'

const require = createRequire(import.meta.url)
const registry = require('prismarine-registry')('1.21.4')
const Recipe = require('prismarine-recipe')(registry).Recipe

function fakeBot(inventory: Record<string, number> = {}) {
  return {
    registry,
    recipesAll: (id: number) => Recipe.find(id, null),
    inventory: { items: () => Object.entries(inventory).map(([name, count]) => ({ name, count })) },
  } as any
}

test('wooden pickaxe from logs plans planks, table, sticks, pickaxe', () => {
  const plan = new Crafting(fakeBot()).plan([{ item: 'wooden_pickaxe', count: 1 }], false, { birch_log: 3 })
  assert.equal(plan.ok, true)
  assert.equal(plan.steps.filter((s) => s.item === 'birch_planks').reduce((n, s) => n + s.times, 0), 3, 'one log per planks craft, three logs total')
  assert.ok(plan.steps.some((s) => s.item === 'crafting_table'))
  assert.equal(plan.steps.at(-1)!.item, 'wooden_pickaxe')
  assert.ok(plan.steps.every((s) => !s.item.startsWith('oak')), 'uses the species in the inventory')
})

test('two logs are not enough for table plus pickaxe', () => {
  const plan = new Crafting(fakeBot()).plan([{ item: 'wooden_pickaxe', count: 1 }], false, { oak_log: 2 })
  assert.equal(plan.ok, false)
  assert.ok(plan.missing.log > 0, JSON.stringify(plan.missing))
})

test('iron pickaxe reports iron_ingot as missing, sticks resolved from planks', () => {
  const plan = new Crafting(fakeBot()).plan([{ item: 'iron_pickaxe', count: 1 }], true, { oak_planks: 4, iron_ingot: 1 })
  assert.equal(plan.ok, false)
  assert.equal(plan.missing.iron_ingot, 2)
})

test('stone pickaxe with table nearby needs no table step', () => {
  const plan = new Crafting(fakeBot()).plan([{ item: 'stone_pickaxe', count: 1 }], true, { cobblestone: 3, stick: 2 })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.steps.map((s) => s.item), ['stone_pickaxe'])
})

test('plan validation rejects unknown ids', () => {
  const bot = fakeBot()
  const base = { item: null, count: null, y: null, block: null }
  const errors = validatePlan(bot, {
    goal_done_when: { ...base, kind: 'have', item: 'diamond', count: 1 },
    subgoals: [
      { description: 'x', hint: '', done_when: { ...base, kind: 'have', item: 'diamonds', count: 1 } },
      { description: 'y', hint: '', done_when: { ...base, kind: 'have', item: 'log', count: 4 } },
      { description: 'z', hint: '', done_when: { ...base, kind: 'near_block', block: 'diamond_ore' } },
    ],
  })
  assert.equal(errors.length, 1)
  assert.match(errors[0], /diamonds/)
})
