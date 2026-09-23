/**
 * Layer 0: hard-coded survival at 4 Hz. No model in the loop; preempts whatever skill is running.
 * Fast models are still too slow for "a creeper is hissing next to you".
 */
import type { Bot } from 'mineflayer'
import { goals } from '../skills/context.ts'
import { FOOD, HOSTILE } from '../world/items.ts'


export interface Preemptor {
  preempt(reason: string, routine: () => Promise<void>): Promise<void>
  readonly reflexActive: boolean
}

export function startReflexes(bot: Bot, agent: Preemptor) {
  const b = bot as any
  const timer = setInterval(() => {
    if (!bot.entity || agent.reflexActive || bot.health <= 0) return
    const me = bot.entity.position
    const threat = bot.nearestEntity((e) => HOSTILE.has(e.name ?? '') && e.position.distanceTo(me) < 7 && Math.abs(e.position.y - me.y) < 4)

    // Lava or fire: get out before anything else.
    if ((bot.entity as any).isInLava || bot.blockAt(me.floored())?.name === 'lava') {
      void agent.preempt('escaping lava', async () => {
        bot.setControlState('jump', true)
        const safe = bot.findBlock({
          maxDistance: 8,
          matching: (block) => block.boundingBox === 'block',
          useExtraInfo: (block) => ['air', 'cave_air'].includes(bot.blockAt(block.position.offset(0, 1, 0))?.name ?? '')
            && ['air', 'cave_air'].includes(bot.blockAt(block.position.offset(0, 2, 0))?.name ?? ''),
        })
        if (safe) b.pathfinder.setGoal(new goals.GoalBlock(safe.position.x, safe.position.y + 1, safe.position.z))
        await wait(2500)
        b.pathfinder.setGoal(null)
        bot.setControlState('jump', false)
      })
      return
    }

    // Air: surface, then head for the nearest dry land. Only when the head is actually under water.
    const head = bot.blockAt(me.offset(0, 1.62, 0))
    if (head?.name === 'water' && bot.oxygenLevel < 12) {
      void agent.preempt('surfacing from water', async () => {
        bot.setControlState('jump', true)
        const deadline = Date.now() + 6000
        while (Date.now() < deadline && bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name === 'water') await wait(200)
        // Swim to the nearest breathable block (a surface, or an air pocket in a flooded cave).
        const breath = bot.findBlock({
          maxDistance: 20,
          matching: (block) => block.name === 'air' || block.name === 'cave_air',
          useExtraInfo: (block) => ['water', 'air', 'cave_air'].includes(bot.blockAt(block.position.offset(0, -1, 0))?.name ?? '') || bot.blockAt(block.position.offset(0, -1, 0))?.boundingBox === 'block',
        })
        if (breath) {
          b.pathfinder.setGoal(new goals.GoalBlock(breath.position.x, breath.position.y, breath.position.z))
          const until = Date.now() + 10000
          while (Date.now() < until && bot.blockAt(bot.entity.position.offset(0, 1.62, 0))?.name === 'water') await wait(250)
          b.pathfinder.setGoal(null)
        }
        bot.setControlState('jump', false)
      })
      return
    }

    if (threat) {
      const d = threat.position.distanceTo(me)
      // Fighting while swimming loses; so does fighting a creeper.
      const flee = threat.name === 'creeper' || bot.health <= 6 || !!(bot.entity as any).isInWater
      if (flee && d < 6) {
        void agent.preempt(`flee ${threat.name}`, async () => {
          b.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(threat, 14)), true)
          await wait(3500)
          b.pathfinder.setGoal(null)
        })
        return
      }
      if (!flee && d < 4.5) {
        void agent.preempt(`fight ${threat.name}`, async () => {
          const weapon = bestWeapon(bot)
          if (weapon) await bot.equip(weapon, 'hand').catch(() => {})
          b.pathfinder.setGoal(new goals.GoalFollow(threat, 2), true)
          const deadline = Date.now() + 15_000
          while (threat.isValid && Date.now() < deadline && bot.health > 6 && threat.position.distanceTo(bot.entity.position) < 10) {
            if (threat.position.distanceTo(bot.entity.position) < 3.3) {
              await bot.lookAt(threat.position.offset(0, threat.height * 0.8, 0), true)
              bot.attack(threat)
            }
            await wait(600)
          }
          b.pathfinder.setGoal(null)
        })
        return
      }
    }

    // Only urgent hunger preempts a skill; routine eating happens between skills (Agent.snack).
    if (bot.food <= 6 && !threat) {
      const food = bestFood(bot)
      if (food) {
        void agent.preempt(`eat ${food.name}`, async () => {
          await bot.equip(food, 'hand')
          await bot.consume().catch(() => {})
        })
      }
    }
  }, 250)
  bot.once('end', () => clearInterval(timer))
}

const TIER = ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
const KIND = ['_shovel', '_pickaxe', '_axe', '_sword']

/** Highest-damage item held: swords beat axes beat pickaxes, higher tiers first. */
export function bestWeapon(bot: Bot) {
  const score = (name: string) => {
    const kind = KIND.findIndex((k) => name.endsWith(k))
    return kind < 0 ? -1 : kind * 10 + TIER.indexOf(name.split('_')[0])
  }
  return bot.inventory.items().filter((i) => score(i.name) >= 0).sort((a, b) => score(b.name) - score(a.name))[0]
}

export function bestFood(bot: Bot) {
  return bot.inventory.items().filter((i) => FOOD.has(i.name)).sort((a, c) => foodRank(c.name) - foodRank(a.name))[0]
}

function foodRank(name: string) {
  return name.startsWith('cooked_') || name === 'bread' || name === 'baked_potato' ? 2 : name === 'golden_apple' ? 0 : 1
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
