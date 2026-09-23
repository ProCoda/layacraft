import type { Bot } from 'mineflayer'

/**
 * mineflayer tracks ONE stateId for all windows, so player-inventory packets (window 0) overwrite the stateId of an
 * open crafting table. The server then answers every click with a full resync, the client's cursor model drifts,
 * and multi-ingredient table recipes silently fail. Track stateId per window and fix outgoing clicks.
 */
export function installStateIdFix(bot: Bot) {
  const client = (bot as any)._client
  const stateIds = new Map<number, number>()
  const track = (packet: { windowId: number; stateId?: number }) => {
    if (typeof packet.stateId === 'number') stateIds.set(packet.windowId, packet.stateId)
  }
  client.on('window_items', track)
  client.on('set_slot', track)
  const write = client.write.bind(client)
  client.write = (name: string, params: any) => {
    // stateId -1 is mineflayer's deliberate "resync me" probe; leave it alone.
    if (name === 'window_click' && params.stateId !== -1 && stateIds.has(params.windowId)) {
      params = { ...params, stateId: stateIds.get(params.windowId) }
    }
    return write(name, params)
  }
}
