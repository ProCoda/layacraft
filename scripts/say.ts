/** Send one chat line to the bot from a throwaway offline player: `npx tsx scripts/say.ts "!goal Find diamond"`. */
import mineflayer from 'mineflayer'

const bot = mineflayer.createBot({ host: process.env.MC_HOST ?? 'localhost', port: Number(process.env.MC_PORT ?? 25565), username: 'Boss', auth: 'offline' })
bot.once('spawn', async () => {
  await bot.waitForTicks(20)
  bot.chat(process.argv.slice(2).join(' '))
  await bot.waitForTicks(20)
  bot.quit()
})
