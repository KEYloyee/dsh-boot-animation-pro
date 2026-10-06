#!/usr/bin/env node
// Print the top-level box chain of every clip in the pool.
//
// Written as a file rather than an inline `node -e`: the pool holds CJK file
// names and a shell round-trip has already mangled them once in this project.
//
//   node tools/box-chain.mjs

import { readdir, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'

const assetDir = fileURLToPath(new URL('../assets/videos', import.meta.url))
const names = (await readdir(assetDir, { withFileTypes: true }))
  .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.mp4')
  .map(entry => entry.name)
  .sort()

for (const name of names) {
  const handle = await open(join(assetDir, name), 'r')
  // 64 KiB, the same window the Host reads: these files carry a ~21 KiB `uuid`
  // box before the media data, so a 4 KiB read saw only `ftyp, uuid` and reported
  // no `moov` at all — including for files whose `moov` had just been moved to the
  // front, which is exactly when the result matters.
  const head = Buffer.alloc(65536)
  const { bytesRead } = await handle.read(head, 0, head.length, 0)
  const { size } = await handle.stat()
  await handle.close()

  const chain = []
  let offset = 0
  while (offset + 8 <= bytesRead && chain.length < 8) {
    const boxSize = head.readUInt32BE(offset)
    const type = head.toString('latin1', offset + 4, offset + 8)
    chain.push(`${type}@${String(offset)}(size=${String(boxSize)})`)
    if (boxSize < 8) break
    offset += boxSize
  }
  const moovAt = head.indexOf(Buffer.from('moov', 'latin1'))
  process.stdout.write(`${name}\n  bytes=${String(size)}\n  ${chain.join(' -> ')}\n  first 'moov' type field at ${String(moovAt)}\n\n`)
}
