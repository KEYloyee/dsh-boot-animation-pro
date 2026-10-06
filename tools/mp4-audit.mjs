// Check that every clip's index actually points at its own media data.
//
// A browser that cannot resolve a sample shows nothing and surfaces no error in
// the page: the overlay appears, no frame is painted. That is the same visible
// symptom as a container whose `moov` sits at the end, so the two have to be told
// apart from the bytes.
//
// The decisive question is whether the sample tables are coherent: every chunk
// offset in `stco`/`co64` must land inside `mdat`, and the sample sizes in `stsz`
// must add up to something `mdat` can hold. A file that fails this is
// unplayable by construction, whatever the player.
//
//   node tools/mp4-audit.mjs

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'

const assetDir = fileURLToPath(new URL('../assets/videos', import.meta.url))

/** Top-level boxes only, so `mdat`'s real extent is known. */
function topLevel(buffer) {
  const boxes = []
  let offset = 0
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (size === 1) size = Number(buffer.readBigUInt64BE(offset + 8))
    else if (size === 0) size = buffer.length - offset
    if (size < 8 || offset + size > buffer.length) break
    boxes.push({ type, start: offset, size, payload: offset + 8 })
    offset += size
  }
  return boxes
}

/** Every box of one type anywhere in a range, by walking containers. */
function findBoxes(buffer, wanted, start, end, out = []) {
  const containers = ['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex']
  let offset = start
  while (offset + 8 <= end) {
    const size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (size < 8 || offset + size > end) break
    if (wanted.includes(type)) out.push({ type, payload: offset + 8, size })
    if (containers.includes(type)) findBoxes(buffer, wanted, offset + 8, offset + size, out)
    offset += size
  }
  return out
}

const names = (await readdir(assetDir, { withFileTypes: true }))
  .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.mp4')
  .map(entry => entry.name)
  .sort()

let bad = 0

for (const name of names) {
  const buffer = await readFile(join(assetDir, name))
  const boxes = topLevel(buffer)
  const mdat = boxes.find(box => box.type === 'mdat')
  const moovAt = boxes.findIndex(box => box.type === 'moov')

  const problems = []
  if (mdat === undefined) problems.push('没有 mdat')
  if (moovAt < 0) problems.push('没有 moov')
  if (problems.length > 0) {
    process.stdout.write(`${name}\n  问题：${problems.join('、')}\n\n`)
    bad += 1
    continue
  }

  const mdatStart = mdat.payload
  const mdatEnd = mdat.start + mdat.size

  const tables = findBoxes(buffer, ['stco', 'co64', 'stsz', 'stsc'], 0, buffer.length)
  const offsets = []
  for (const table of tables) {
    if (table.type === 'stco') {
      const count = buffer.readUInt32BE(table.payload + 4)
      for (let i = 0; i < count; i += 1) offsets.push(buffer.readUInt32BE(table.payload + 8 + i * 4))
    }
    if (table.type === 'co64') {
      const count = buffer.readUInt32BE(table.payload + 4)
      for (let i = 0; i < count; i += 1) offsets.push(Number(buffer.readBigUInt64BE(table.payload + 8 + i * 8)))
    }
  }
  const sizes = tables.filter(table => table.type === 'stsz')
  let sampleBytes = 0
  let sampleCount = 0
  for (const table of sizes) {
    const uniform = buffer.readUInt32BE(table.payload + 4)
    const count = buffer.readUInt32BE(table.payload + 8)
    sampleCount += count
    if (uniform !== 0) sampleBytes += uniform * count
    else {
      for (let i = 0; i < count; i += 1) sampleBytes += buffer.readUInt32BE(table.payload + 12 + i * 4)
    }
  }

  const outside = offsets.filter(offset => offset < mdatStart || offset >= mdatEnd)
  const lowest = offsets.length === 0 ? undefined : Math.min(...offsets)
  const highest = offsets.length === 0 ? undefined : Math.max(...offsets)

  process.stdout.write(`${name}\n`)
  process.stdout.write(`  mdat      ${String(mdatStart)} – ${String(mdatEnd)}  (${String(mdat.size)} B)\n`)
  process.stdout.write(`  块偏移    ${String(offsets.length)} 个，范围 ${String(lowest)} – ${String(highest)}\n`)
  process.stdout.write(`  样本      ${String(sampleCount)} 个，合计 ${String(sampleBytes)} B\n`)
  process.stdout.write(`  moov      ${moovAt === 1 ? '紧跟在 ftyp 后（faststart）' : `第 ${String(moovAt + 1)} 个顶层盒（在数据之后）`}\n`)

  if (offsets.length === 0) problems.push('索引里没有任何块偏移')
  if (outside.length > 0) problems.push(`${String(outside.length)} 个块偏移落在 mdat 之外（例如 ${String(outside[0])}）`)
  if (sampleBytes > mdat.size) problems.push(`样本合计 ${String(sampleBytes)} B 超过 mdat 的 ${String(mdat.size)} B`)

  process.stdout.write(`  结论      ${problems.length === 0 ? '索引自洽，数据可达' : `不一致：${problems.join('、')}`}\n\n`)
  if (problems.length > 0) bad += 1
}

process.stdout.write(`${String(names.length - bad)}/${String(names.length)} 段素材的索引与数据一致\n`)
process.exitCode = bad === 0 ? 0 : 1
