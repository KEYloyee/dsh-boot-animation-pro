// Read the codec fourcc out of every clip's video sample description.
//
// moov position explains a slow first frame, not a clip that never plays. The
// remaining difference worth reading from the bytes is the codec itself: a
// browser that cannot decode HEVC shows exactly this symptom — the overlay
// appears, nothing is painted, and no error surfaces in the page.
//
//   node tools/codec-report.mjs

import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { extname, join } from 'node:path'

const assetDir = fileURLToPath(new URL('../assets/videos', import.meta.url))

/** Walk nested boxes, calling visit(type, payloadStart, payloadEnd, buffer). */
function walk(buffer, visit, start, end) {
  let offset = start
  while (offset + 8 <= end) {
    const size = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (size < 8 || offset + size > end) return
    visit(type, offset + 8, offset + size, offset)
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'].includes(type)) {
      // `stsd` carries a version/flags word and an entry count before its children.
      const inner = type === 'stsd' ? offset + 16 : offset + 8
      walk(buffer, visit, inner, offset + size)
    }
    // A visual sample entry holds `avcC`/`btrt`/`pasp` after a 78-byte header.
    if (VISUAL.includes(type)) walk(buffer, visit, offset + 8 + 78, offset + size)
    offset += size
  }
}

/** Sample-description fourccs that name a codec (video and audio). */
const CODECS = [
  'avc1', 'avc3', 'avc4', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01', 'mp4v', 'ap4h', 'apch',
  'mp4a', 'alac', 'ac-3', 'ec-3', 'Opus', 'fLaC',
]

/** Visual sample entries whose child boxes start after a 78-byte fixed header. */
const VISUAL = ['avc1', 'avc3', 'avc4', 'hvc1', 'hev1', 'vp08', 'vp09', 'av01', 'mp4v', 'ap4h', 'apch']

const names = (await readdir(assetDir, { withFileTypes: true }))
  .filter(entry => entry.isFile() && extname(entry.name).toLowerCase() === '.mp4')
  .map(entry => entry.name)
  .sort()

for (const name of names) {
  const buffer = await readFile(join(assetDir, name))
  const entries = []
  const uuids = []
  const avc = []
  walk(buffer, (type, payloadStart, payloadEnd, boxStart) => {
    if (type === 'uuid') {
      const id = [...buffer.subarray(payloadStart, payloadStart + 16)]
        .map(byte => byte.toString(16).padStart(2, '0')).join('')
      uuids.push(`${id} (${String(payloadEnd - payloadStart)} B)`)
    }
    // The fourcc of a sample entry IS its box type; reading its payload instead
    // finds the reserved word and reports nothing at all.
    if (CODECS.includes(type)) {
      const track = entries.length === 0 ? '1st' : `${String(entries.length + 1)}th`
      const width = buffer.readUInt16BE(payloadStart + 24)
      const height = buffer.readUInt16BE(payloadStart + 26)
      entries.push(`${type} (${track}, ${String(width)}x${String(height)}, ${String(payloadEnd - payloadStart)} B)`)
    }
    // `avcC` is the AVC decoder configuration record: version, profile, compat,
    // level. A browser refuses a profile it does not implement while still
    // resolving play(), so this is the difference between "black" and "playing".
    if (type === 'avcC') {
      const profile = buffer.readUInt8(payloadStart + 1)
      const compat = buffer.readUInt8(payloadStart + 2)
      const level = buffer.readUInt8(payloadStart + 3)
      const NAMES = {
        66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10',
        122: 'High 4:2:2', 144: 'High 4:4:4 (old)', 244: 'High 4:4:4 Predictive',
      }
      avc.push(`${NAMES[profile] ?? `profile ${String(profile)}`}`
        + ` (profile_idc ${String(profile)}, compat 0x${compat.toString(16)}, level ${(level / 10).toFixed(1)})`)
    }
    void boxStart
  }, 0, buffer.length)

  process.stdout.write(`${name}\n`)
  process.stdout.write(`  编码 ${entries.length === 0 ? '(没找到)' : entries.join(', ')}\n`)
  process.stdout.write(`  AVC 配置 ${avc.length === 0 ? '(没找到 avcC)' : avc.join(' | ')}\n`)
  process.stdout.write(`  uuid 盒 ${uuids.length === 0 ? '无' : uuids.join(' | ')}\n\n`)
}
