/**
 * Acknowledged crafting. mineflayer's bot.craft fires window clicks without waiting for the server, which on 1.21
 * desynchronizes the cursor and silently produces nothing. Here every click waits for the server's echo, and the
 * result slot is verified before it is taken.
 */
import { once } from 'node:events'
import type { Bot } from 'mineflayer'

export function inventorySettled(bot: Bot, quietMs = 300, maxMs = 3_000) {
  return new Promise<void>((resolve) => {
    const client = (bot as any)._client
    let quiet: NodeJS.Timeout
    const done = () => {
      clearTimeout(quiet)
      clearTimeout(cap)
      client.off('set_slot', bump)
      client.off('window_items', bump)
      resolve()
    }
    const bump = () => {
      clearTimeout(quiet)
      quiet = setTimeout(done, quietMs)
    }
    const cap = setTimeout(done, maxMs)
    client.on('set_slot', bump)
    client.on('window_items', bump)
    bump()
  })
}

/** Items left in the 2x2 grid (slots 1-4) after an interrupted craft are invisible to inventory.items(). */
export async function reclaimCraftingGrid(bot: Bot) {
  for (const slot of [1, 2, 3, 4]) {
    if (!bot.inventory.slots[slot]) continue
    await bot.clickWindow(slot, 0, 1).catch(() => {})
    await inventorySettled(bot, 120, 1_000)
  }
}

async function click(bot: Bot, slot: number, button: number, mode: number) {
  await bot.clickWindow(slot, button, mode)
  await inventorySettled(bot, 120, 1_500)
}

function gridPositions(recipe: any, width: number): { slot: number; id: number }[] {
  const out: { slot: number; id: number }[] = []
  if (recipe.inShape) {
    recipe.inShape.forEach((row: any[], y: number) => row.forEach((item, x) => {
      if (item.id !== -1) out.push({ slot: 1 + x + y * width, id: item.id })
    }))
  }
  for (const [i, item] of (recipe.ingredients ?? []).entries()) {
    const used = new Set(out.map((p) => p.slot))
    const free = Array.from({ length: width * width }, (_, k) => k + 1).find((s) => !used.has(s))
    if (free === undefined) throw new Error(`no free grid slot for ingredient ${i}`)
    out.push({ slot: free, id: item.id })
  }
  return out
}

export async function craftReliably(bot: Bot, recipe: any, times: number, table: any | null) {
  for (let i = 0; i < times; i++) await craftOnce(bot, recipe, table)
}

async function craftOnce(bot: Bot, recipe: any, table: any | null) {
  let window: any = bot.inventory
  if (table) {
    const opened = once(bot as any, 'windowOpen')
    bot.activateBlock(table)
    ;[window] = await Promise.race([opened, new Promise<never>((_, r) => setTimeout(() => r(new Error('crafting table did not open')), 5_000))])
    await inventorySettled(bot, 150, 1_500)
  } else {
    await reclaimCraftingGrid(bot)
  }
  const width = table ? 3 : 2
  if (window.selectedItem) {
    // An item stuck on the cursor would be swapped into the grid by the first click.
    const empty = window.firstEmptyInventorySlot()
    if (empty !== null) await click(bot, empty, 0, 0)
  }
  try {
    for (const p of gridPositions(recipe, width)) {
      const source = window.findInventoryItem(p.id, null, false)
      if (!source) throw new Error(`missing ingredient ${bot.registry.items[p.id].name}`)
      await click(bot, source.slot, 0, 0) // pick up the stack
      await click(bot, p.slot, 1, 0) // drop exactly one
      if (window.selectedItem) await click(bot, source.slot, 0, 0) // put the rest back
    }
    const result = window.slots[0]
    if (!result || result.type !== recipe.result.id) {
      throw new Error(`grid did not form ${bot.registry.items[recipe.result.id].name} (result slot: ${result?.name ?? 'empty'})`)
    }
    await click(bot, 0, 0, 1) // shift-click the result into the inventory
  } finally {
    if (table) {
      bot.closeWindow(window)
      await inventorySettled(bot, 150, 1_500)
    } else {
      await reclaimCraftingGrid(bot)
    }
  }
}
