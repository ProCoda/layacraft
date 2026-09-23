/** Creative mode: every item is available on demand, nothing hurts, nothing needs gathering. */
import type { Bot } from 'mineflayer'
import prismarineItem from 'prismarine-item'
import { countItem, isGroup, matchesItem } from './items.ts'

export function isCreative(bot: Bot) {
  return bot.game?.gameMode === 'creative'
}

/** Put `count` of `item` in the inventory (hotbar first). Groups ("log", "planks") resolve to a representative item. */
export async function creativeGive(bot: Bot, item: string, count: number): Promise<boolean> {
  const name = isGroup(item) ? Object.keys(bot.registry.itemsByName).find((n) => matchesItem(item, n)) : item
  const def = name ? bot.registry.itemsByName[name] : undefined
  if (!def) return false
  const Item = (prismarineItem as any)(bot.registry)
  let missing = count - countItem(bot, name!)
  const slots = [...Array(9).keys()].map((i) => 36 + i).concat([...Array(27).keys()].map((i) => 9 + i))
  for (const slot of slots) {
    if (missing <= 0) break
    const current = bot.inventory.slots[slot]
    if (current && current.name !== name) continue
    const stack = Math.min(def.stackSize, (current?.count ?? 0) + missing)
    await bot.creative.setInventorySlot(slot, new Item(def.id, stack))
    missing -= stack - (current?.count ?? 0)
  }
  if (missing > 0) {
    // Inventory full: overwrite the least useful hotbar slot.
    await bot.creative.setInventorySlot(44, new Item(def.id, Math.min(def.stackSize, missing)))
  }
  return true
}
