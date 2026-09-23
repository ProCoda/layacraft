/** Minimal RCON client for the local test server: `npx tsx scripts/rcon.ts "time set day"`. */
import fs from 'node:fs'
import net from 'node:net'

const password = process.env.RCON_PASSWORD ?? fs.readFileSync(new URL('../server/.rcon_password', import.meta.url), 'utf8').trim()
const commands = process.argv.slice(2)

function packet(id: number, type: number, body: string) {
  const payload = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + payload.length)
  buf.writeInt32LE(10 + payload.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  payload.copy(buf, 12)
  return buf
}

const socket = net.connect(Number(process.env.RCON_PORT ?? 25575), '127.0.0.1')
let buffer = Buffer.alloc(0)
let next = 1
socket.on('connect', () => socket.write(packet(0, 3, password)))
socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 4 && buffer.length >= buffer.readInt32LE(0) + 4) {
    const len = buffer.readInt32LE(0)
    const id = buffer.readInt32LE(4)
    const body = buffer.subarray(12, 4 + len - 2).toString('utf8')
    buffer = buffer.subarray(4 + len)
    if (id === -1) throw new Error('RCON auth failed')
    if (id > 0 && body) console.log(body)
    if (next > commands.length) return socket.end()
    socket.write(packet(next, 2, commands[next++ - 1]))
  }
})
