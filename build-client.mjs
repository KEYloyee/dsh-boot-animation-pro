// Rebuild lib/client.js from src/client.js.
//
// The browser bundle is the source wrapped in the shell's module-loader call.
// Keeping the build here — rather than in a bundler — is deliberate: this half
// imports nothing (React arrives through the factory's `require`), so there is
// nothing to resolve and nothing to tree-shake. The wrapper is the whole build.
//
//   window.__ModuleLoader__.load({ id: "dsh-boot-animation", factory: (require) => {
//   var module = { exports: {} }; var exports = module.exports;
//   <src/client.js verbatim>
//   return module.exports; } });
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const id = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

const head = `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\n`
  + 'var module = { exports: {} }; var exports = module.exports;\n'
const tail = '\nreturn module.exports; } });\n'

const source = readFileSync(join(root, 'src', 'client.js'), 'utf8')
if (source.includes('return module.exports; } });')) {
  throw new Error('build-client: src/client.js already carries the loader tail; it is source, not a bundle')
}

const bundle = head + source + tail
writeFileSync(join(root, 'lib', 'client.js'), bundle)
console.log(`build-client: lib/client.js written (${String(bundle.length)} chars from ${String(source.length)})`)
