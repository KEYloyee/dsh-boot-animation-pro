#!/usr/bin/env node
// Read duration and resolution straight out of the mp4 boxes.
//
// The browser-based probe cannot answer these on this machine: the automation
// browser has no media decoders, so every clip reports a decode failure. The
// metadata lives in the container anyway, so it can be read from the bytes:
// `mvhd` carries the timescale and duration, `tkhd` the display dimensions.
//
// Usage: node tools/mp4-info.mjs [directory]

import { readdir, readFile, open } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join, extname } from 'node:path'

const DEFAULT_DIR = fileURLToPath(new URL('../assets/videos', import.meta.url))
const dir = process.argv[2] ?? DEFAULT_DIR

/** Walk top-level mp4 boxes, invoking the visitor with each box's payload range. */
function walkBoxes(buffer, visit, start = 0, end = buffer.length) {
  let offset = start
  while (offset + 8 <= end) {
    const size = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (size < 8) break
    const payloadStart = offset + 8
    const payloadEnd = Math.min(offset + size, end)
    visit(type, payloadStart, payloadEnd)
    // Descend into containers so `mvhd`/`tkhd` nested under `moov`/`trak` are found.
    if (type === 'moov' || type === 'trak' || type === 'mdia') {
      walkBoxes(buffer, visit, payloadStart, payloadEnd)
    }
    offset += size
  }
}

/** Decode `mvhd` into a duration in seconds. */
function readMvhd(buffer, start) {
  const version = buffer.readUInt8(start)
  if (version === 1) {
    const timescale = buffer.readUInt32BE(start + 20)
    const duration = Number(buffer.readBigUInt64BE(start + 24))
    return timescale === 0 ? undefined : duration / timescale
  }
  const timescale = buffer.readUInt32BE(start + 12)
  const duration = buffer.readUInt32BE(start + 16)
  return timescale === 0 ? undefined : duration / timescale
}

/** Decode `tkhd` into display width/height for a video track. */
function readTkhd(buffer, start) {
  const version = buffer.readUInt8(start)
  // width/height are the LAST two 16.16 fixed-point words of the box payload, so
  // locate them from the box size rather than from a hand-counted field offset:
  // counting past the transformation matrix is where this went wrong before.
  const size = buffer.readUInt32BE(start - 8)
  const boxEnd = start - 8 + size
  if (boxEnd > buffer.length || boxEnd - 8 < start) return undefined
  const width = buffer.readUInt32BE(boxEnd - 8) / 65536
  const height = buffer.readUInt32BE(boxEnd - 4) / 65536
  if (width === 0 || height === 0) return undefined
  return { width, height, version }
}

const entries = (await readdir(dir, { withFileTypes: true }))
  .filter(entry => entry.isFile() && ['.mp4', '.m4v', '.mov'].includes(extname(entry.name).toLowerCase()))
  .map(entry => entry.name)
  .sort()

if (entries.length === 0) {
  process.stdout.write(`no mp4 files in ${dir}\n`)
  process.exit(0)
}

for (const name of entries) {
  const path = join(dir, name)
  // The header (ftyp + moov) can sit after the media payload, so scan the whole
  // file. Files are a few megabytes, which is fine for a one-off inspection.
  const buffer = await readFile(path)
  let duration
  let dims
  let hasAudio = false
  walkBoxes(buffer, (type, start) => {
    if (type === 'mvhd') duration = readMvhd(buffer, start)
    if (type === 'tkhd') dims = readTkhd(buffer, start) ?? dims
    if (type === 'hdlr') {
      // The handler type sits at payload + 8 and names the media kind.
      const handler = buffer.toString('ascii', start + 8, start + 12)
      if (handler === 'soun') hasAudio = true
    }
  })

  const size = buffer.length
  const durationText = duration === undefined ? 'unknown' : `${duration.toFixed(2)}s`
  const dimsText = dims === undefined ? 'unknown' : `${dims.width}x${dims.height}`
  const aspect = dims === undefined ? '-' : (dims.width / dims.height).toFixed(3)
  process.stdout.write(
    `${name}\n`
    + `  size      ${(size / 1024 / 1024).toFixed(2)} MB\n`
    + `  duration  ${durationText}\n`
    + `  video     ${dimsText}  (aspect ${aspect})\n`
    + `  audio     ${hasAudio ? 'yes' : 'no'}\n`,
  )
}
