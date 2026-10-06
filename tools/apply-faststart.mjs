#!/usr/bin/env node
// Make the whole pool playable in one step: rewrite every clip whose `moov` sits
// at the end, keeping the original beside it.
//
// The plugin only ever *reports* this — the card shows 未优化 — because rewriting a
// user's video without being asked is not something a decorative plugin should do
// on its own. But that left "drop a clip in, then find a terminal and type the
// right command" as the required workflow, which is not a workflow. This is that
// one step.
//
//   node tools/apply-faststart.mjs            # report only, changes nothing
//   node tools/apply-faststart.mjs --apply    # rewrite in place, originals kept
//
// Reversible: every original is moved to `assets/videos/originals/` (a
// subdirectory, so the pool does not pick it up) and can be moved back.

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extname, join, resolve } from 'node:path'
import { remux } from './faststart.mjs'

const defaultDir = fileURLToPath(new URL('../assets/videos', import.meta.url))
const VIDEO = /\.(mp4|m4v|mov)$/i

/**
 * Which of the two boxes a player must reach first comes earlier in the file.
 *
 * Only the first of the pair matters, and that is what makes this readable from a
 * 64 KiB window: `mdat` is several megabytes, so a walk that insisted on the whole
 * box being inside the window would step over it and report "mdat not found" —
 * which is how the first version of this classified three already-reordered clips
 * as needing a rewrite.
 * @param file - absolute path.
 * @returns 'moov' when the index comes first, 'mdat' when the data does, and
 *   'unknown' when neither is inside the window.
 */
export async function leadingBox(file) {
  const handle = await open(file, 'r')
  const head = Buffer.alloc(65536)
  const { bytesRead } = await handle.read(head, 0, head.length, 0)
  await handle.close()
  let offset = 0
  while (offset + 8 <= bytesRead) {
    const size = head.readUInt32BE(offset)
    const type = head.toString('latin1', offset + 4, offset + 8)
    if (type === 'moov') return 'moov'
    if (type === 'mdat') return 'mdat'
    if (size < 8) break
    offset += size
  }
  return 'unknown'
}

/**
 * Rewrite every clip in one directory that still has its index at the end.
 *
 * Exported so the verification suite can run it against a scratch directory: this
 * is the one tool in the package that overwrites the user's own media, so it is
 * the one that most needs to be exercised somewhere other than in place.
 * @param options - the pool directory and whether to write.
 * @returns one report line per clip, and the counts.
 */
export async function applyPool(options) {
  const dir = options.dir ?? defaultDir
  const backupDir = join(dir, 'originals')
  const scratchDir = join(dir, '.faststart-work')
  const lines = []
  let rewritten = 0
  let failed = 0

  const files = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && VIDEO.test(entry.name))
    .map(entry => entry.name)
    .sort()

  if (files.length === 0) return { lines: [`素材池是空的：${dir}`], rewritten, failed }

  for (const name of files) {
    const source = join(dir, name)
    const leading = await leadingBox(source)

    if (leading === 'moov') {
      lines.push(`OK    ${name}  moov 已在最前，无需处理`)
      continue
    }
    if (leading === 'unknown') {
      // Neither box inside the window: not a file this tool should guess about.
      lines.push(`SKIP  ${name}  读不到 moov/mdat（可能不是 mp4），交给人工判断`)
      failed += 1
      continue
    }
    if (options.apply !== true) {
      lines.push(`TODO  ${name}  moov 在 mdat 之后，加 --apply 就地重排（原片保留到 originals/）`)
      continue
    }

    const backup = join(backupDir, name)
    if (existsSync(backup)) {
      // Never overwrite an existing backup: a second run must not be able to turn
      // "the original" into "a previous rewrite".
      lines.push(`SKIP  ${name}  originals/ 里已经有同名备份，先处理它再重跑`)
      failed += 1
      continue
    }

    try {
      mkdirSync(scratchDir, { recursive: true })
      remux(source, scratchDir, true)
      const produced = join(scratchDir, `${name.replace(extname(name), '')}.faststart.mp4`)
      if (!existsSync(produced)) throw new Error('重排没有产出文件')

      const sizeBefore = statSync(source).size
      mkdirSync(backupDir, { recursive: true })
      renameSync(source, backup)
      copyFileSync(produced, source)
      rmSync(produced, { force: true })

      // Verify the file that is now in the pool, and undo the whole thing if it is
      // not what was promised. This is the check whose absence let the rewrite tool
      // report success while writing byte-identical copies.
      const after = await leadingBox(source)
      if (after !== 'moov') throw new Error('重排后的文件里 moov 仍在 mdat 之后')
      if (statSync(source).size !== sizeBefore) throw new Error('重排后长度变了')

      lines.push(`DONE  ${name}  moov 已前移（原片在 originals/${name}）`)
      rewritten += 1
    } catch (error) {
      // Restore, whatever step failed after the original was moved aside.
      if (existsSync(backup) && !existsSync(source)) renameSync(backup, source)
      lines.push(`FAIL  ${name}  ${error.message}`)
      failed += 1
    }
  }

  rmSync(scratchDir, { recursive: true, force: true })
  return { lines, rewritten, failed }
}

/**
 * The command-line entry, skipped when this file is imported.
 *
 * `--dir <path>` points the tool at another directory, which is how the suite
 * exercises it without touching the real pool.
 */
async function runCli() {
  const dirIndex = process.argv.indexOf('--dir')
  const dir = dirIndex >= 0 && process.argv[dirIndex + 1] !== undefined
    ? resolve(process.argv[dirIndex + 1])
    : defaultDir
  const apply = process.argv.includes('--apply')
  const result = await applyPool({ dir, apply })

  for (const line of result.lines) console.log(line)
  if (apply) {
    console.log(`\n重排 ${String(result.rewritten)} 段，失败 ${String(result.failed)} 段。原片都在 assets/videos/originals/。`)
    console.log('刷新页面即可；素材的缓存规则是 no-store，不需要清浏览器缓存。')
  } else {
    console.log('\n这一步没有改动任何文件。加 --apply 才会就地重排。')
  }
  process.exitCode = result.failed === 0 ? 0 : 1
}

const invoked = process.argv[1] === undefined ? '' : pathToFileURL(resolve(process.argv[1])).href
if (import.meta.url === invoked) await runCli()
