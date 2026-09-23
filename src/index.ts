import mineflayer from 'mineflayer'
import pathfinderPkg from 'mineflayer-pathfinder'
import toolPkg from 'mineflayer-tool'
import { Agent } from './brain/agent.ts'
import { setBuiltCheck } from './brain/plan.ts'
import { protectSites } from './skills/index.ts'
import { progress } from './world/blueprint.ts'
import { createLLM } from './brain/llm.ts'
import { startReflexes } from './brain/reflex.ts'
import { Strategist } from './brain/strategist.ts'
import { config } from './config.ts'
import { log } from './log.ts'
import { usageSummary } from './usage.ts'
import { Acquirer } from './world/acquire.ts'
import { Crafting } from './world/crafting.ts'
import { initGameData } from './world/items.ts'
import { Knowledge } from './world/knowledge.ts'
import { Memory } from './world/memory.ts'
import { installStateIdFix } from './world/protocol-fixes.ts'

const { pathfinder, Movements } = pathfinderPkg as any
const { plugin: tool } = toolPkg as any

if (!config.jev.apiKey) {
  console.error('TYPESAFE_API_KEY is not set. Export it (e.g. in ~/.zshrc) and retry.')
  process.exit(1)
}

const bot = mineflayer.createBot({
  host: config.host,
  port: config.port,
  username: config.username,
  auth: config.auth,
  ...(config.version ? { version: config.version } : {}),
})
installStateIdFix(bot)
// Places are per world: the hashed seed from the login packet separates worlds that share a host and port.
let worldId = 'unknown'
;(bot as any)._client.once('login', (packet: any) => {
  const seed = packet.worldState?.hashedSeed ?? packet.hashedSeed
  if (seed !== undefined) worldId = String(seed)
})
bot.loadPlugin(pathfinder)
bot.loadPlugin(tool)

bot.once('spawn', async () => {
  const movements = new Movements(bot)
  movements.canDig = true
  movements.allow1by1towers = true
  movements.allowParkour = true
  movements.allowSprinting = true
  movements.liquidCost = 6 // swim only when there is no dry route
  movements.maxDropDown = 3 // falls of 4+ blocks hurt
  movements.scafoldingBlocks = ['dirt', 'cobblestone', 'cobbled_deepslate', 'netherrack']
    .map((n) => bot.registry.itemsByName[n]?.id).filter((id) => id !== undefined)
  ;(bot as any).safeMovements = movements
  ;(bot as any).pathfinder.setMovements(movements)
  ;(bot as any).pathfinder.thinkTimeout = 8000

  initGameData(bot)
  const memory = new Memory(`${config.host}_${config.port}_${config.username}_${worldId}`)
  movements.canOpenDoors = true
  protectSites(movements, memory.data.sites)
  setBuiltCheck((name) => {
    const site = memory.data.sites[name]
    return site?.origin ? progress(bot, site).remaining.length === 0 : false
  })
  const knowledge = new Knowledge(bot)
  const crafting = new Crafting(bot)
  const agent = new Agent(bot, new Strategist(createLLM(), bot), crafting, memory, knowledge, new Acquirer(bot, crafting, knowledge, memory))
  startReflexes(bot, agent)
  log('info', `spawned at ${bot.entity.position.floored()} on ${bot.version}; perception=${config.perception}; jev=${config.jev.model}`)

  bot.on('chat', (username, message) => {
    if (username === bot.username) return
    // Free text from a player is an instruction; "!" commands stay as direct controls.
    if (!message.startsWith('!')) return void agent.instruct(username, message)
    const [command, ...rest] = message.slice(1).split(' ')
    if (command === 'goal' && rest.length) void agent.start(rest.join(' '))
    else if (command === 'stop') (agent.stop(), bot.chat('stopped'))
    else if (command === 'plan') agent.planView().forEach((l) => bot.chat(l))
    else if (command === 'status') bot.chat(`${agent.goal || 'idle'} | hp ${Math.round(bot.health)} food ${bot.food} y ${Math.floor(bot.entity.position.y)}`)
    else if (command === 'usage') bot.chat(usageSummary().slice(0, 250))
  })

  await bot.waitForChunksToLoad()
  if (config.goal) void agent.start(config.goal)
  else bot.chat('Prêt. Dis-moi quoi faire dans le chat.')
})

bot.on('kicked', (reason) => log('error', `kicked: ${JSON.stringify(reason)}`))
bot.on('error', (err) => log('error', err.message))
bot.on('end', (reason) => {
  log('info', `disconnected: ${reason}`)
  process.exit(0)
})
const shutdown = () => {
  log('info', `usage: ${usageSummary()}`)
  if (bot.entity) log('info', `final: y ${Math.floor(bot.entity.position.y)}, inventory ${JSON.stringify(Object.fromEntries(bot.inventory.items().map((i) => [i.name, i.count])))}`)
  bot.quit()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
