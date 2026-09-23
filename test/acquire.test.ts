import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { Vec3 } from 'vec3'
import { Acquirer } from '../src/world/acquire.ts'
import { Crafting } from '../src/world/crafting.ts'
import { initGameData } from '../src/world/items.ts'
import { Knowledge } from '../src/world/knowledge.ts'
import type { Perception } from '../src/world/perception.ts'

const require = createRequire(import.meta.url)
const registry = require('prismarine-registry')('1.21.4')
const Recipe = require('prismarine-recipe')(registry).Recipe

function setup(inventory: Record<string, number>, visible: string[] = [], creatures: string[] = [], y = 70) {
  const bot = {
    registry,
    recipesAll: (id: number) => Recipe.find(id, null),
    inventory: { items: () => Object.entries(inventory).map(([name, count]) => ({ name, count, type: registry.itemsByName[name].id })) },
    entity: { position: new Vec3(0, y, 0) },
    findBlock: () => null,
  } as any
  initGameData(bot)
  const knowledge = new Knowledge(bot)
  // Facts the strategist would provide (the registry has no smelting data or generation heights).
  knowledge.data = { priors: {}, smelting: { raw_iron: 'iron_ingot', beef: 'cooked_beef' }, notSmeltable: [], sightings: {}, mobs: { cow: 20 }, drops: {}, skillStats: {} }
  const prior = (y_min: number, y_max: number, y_best: number, surface: boolean, abundance: any) => ({ y_min, y_max, y_best, surface, biomes: [], abundance })
  Object.assign(knowledge.data.priors, {
    iron_ore: prior(-16, 72, 16, false, 'common'),
    deepslate_iron_ore: prior(-64, 0, -16, false, 'common'),
    diamond_ore: prior(-64, 16, -58, false, 'rare'),
    deepslate_diamond_ore: prior(-64, 0, -58, false, 'rare'),
    oak_log: prior(60, 120, 70, true, 'very_common'),
    stone: prior(-64, 128, 40, false, 'very_common'),
    iron_block: prior(-64, 320, 0, false, 'very_rare'),
  })
  const memory = { nearest: () => null } as any
  const acquirer = new Acquirer(bot, new Crafting(bot), knowledge, memory)
  const perception: Perception = {
    blocks: new Map(visible.map((name) => [name, { name, count: 5, distance: 6, position: new Vec3(5, y, 0) }])),
    instances: [],
    entities: creatures.map((name, id) => ({ name, kind: 'animal' as const, distance: 8, id })),
    hazards: [],
    y,
  }
  return { acquirer, perception }
}

test('diamond from nothing: finds the whole tool chain and starts with wood', () => {
  const { acquirer, perception } = setup({})
  const acq = acquirer.plan('diamond', 1, perception)
  assert.equal(acq.feasible, true)
  const text = acq.lines.join('\n')
  assert.match(text, /diamond_ore/)
  assert.match(text, /iron_pickaxe/)
  assert.match(text, /smelt raw_iron/)
  assert.ok(acq.frontier.every((s) => s.action === 'FIND_BLOCK'), JSON.stringify(acq.frontier))
  assert.ok(acq.seekBlocks.some((b) => b.endsWith('_log')), acq.seekBlocks.join(','))
})

test('visible logs become a MINE step', () => {
  const { acquirer, perception } = setup({}, ['oak_log'])
  const acq = acquirer.plan('wooden_pickaxe', 1, perception)
  assert.deepEqual(acq.frontier.map((s) => `${s.action} ${s.target}`), ['MINE oak_log'])
})

test('raw iron in hand becomes a SMELT step, not more mining', () => {
  const { acquirer, perception } = setup({ raw_iron: 3, stick: 2, stone_pickaxe: 1, oak_log: 4 }, ['iron_ore'])
  const acq = acquirer.plan('iron_pickaxe', 1, perception)
  assert.ok(acq.frontier.some((s) => s.action === 'SMELT' && s.target === 'raw_iron'), JSON.stringify(acq.frontier))
})

test('iron ore without a stone pickaxe routes through the tool first', () => {
  const { acquirer, perception } = setup({ wooden_pickaxe: 1, oak_log: 2 }, ['iron_ore', 'stone'])
  const acq = acquirer.plan('raw_iron', 1, perception)
  assert.ok(!acq.frontier.some((s) => s.target === 'iron_ore'), 'cannot mine iron with a wooden pickaxe')
  assert.ok(acq.frontier.some((s) => s.action === 'MINE' && s.target === 'stone'), JSON.stringify(acq.frontier))
})

test('food comes from a visible animal', () => {
  const { acquirer, perception } = setup({}, [], ['cow'])
  const acq = acquirer.plan('food', 2, perception)
  assert.ok(acq.frontier.some((s) => s.action === 'HUNT' && s.target === 'cow'), JSON.stringify(acq.frontier))
})

test('closure collects the blocks and items worth asking facts about', () => {
  const { acquirer } = setup({})
  const c = acquirer.closure(['diamond'])
  assert.ok(c.blocks.includes('deepslate_diamond_ore'))
  assert.ok(c.items.includes('iron_pickaxe'))
})

test('measured yields override flattened loot tables', () => {
  const { acquirer, perception } = setup({}, ['oak_leaves'], ['cow'])
  // Registry claims leaves always drop apples; three broken leaves with no apple prove otherwise.
  const k = (acquirer as any).knowledge
  for (let i = 0; i < 3; i++) k.recordDrop('oak_leaves', { stick: i === 0 ? 1 : 0 })
  const acq = acquirer.plan('food', 2, perception)
  assert.ok(!acq.frontier.some((s) => s.target === 'oak_leaves'), JSON.stringify(acq.frontier))
  assert.ok(acq.frontier.some((s) => s.action === 'HUNT' && s.target === 'cow'))
})
