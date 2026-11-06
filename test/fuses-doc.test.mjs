// docs/troubleshooting-fuses.md is the cheat sheet for "injection stopped working after an Orca update".
// These checks keep its command and fuse names right, keep it honest about the pipe the launcher uses,
// keep its relative links alive, and keep the README pointing at it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const doc = read('docs/troubleshooting-fuses.md')

test('it shows the read command for both platforms', () => {
  assert.ok(doc.includes('npx @electron/fuses read --app'))
  assert.ok(doc.includes('Orca.exe'))
  assert.ok(doc.includes('Orca.app'))
})

test('it names the fuses it explains', () => {
  for (const fuse of ['EnableNodeCliInspectArguments', 'EnableNodeOptionsEnvironmentVariable', 'RunAsNode', 'OnlyLoadAppFromAsar']) {
    assert.ok(doc.includes('`' + fuse + '`'), `missing fuse: ${fuse}`)
  }
})

test('the example install paths match the ones the launcher looks in', () => {
  const platform = read('src/platform.mjs')
  assert.ok(doc.includes(String.raw`%LOCALAPPDATA%\Programs\orca`))
  assert.match(platform, /'Programs', 'orca'/)
  assert.ok(doc.includes('/Applications/Orca.app'))
  assert.ok(platform.includes("'/Applications/Orca.app'"))
})

test('it says the kit uses the pipe, and ends by checking the debug port is closed', () => {
  assert.ok(doc.includes('--remote-debugging-pipe'))
  assert.match(read('src/cdp-pipe.mjs'), /--remote-debugging-pipe/)
  const lines = doc.split(/\r?\n/)
  const last = lines.filter((l) => l.startsWith('## ')).at(-1)
  assert.ok(last.includes('除錯埠'), `last section should be the debug-port check, got: ${last}`)
})

test('relative links point at existing docs', () => {
  for (const [, target] of doc.matchAll(/\]\(([^)#]+\.md)(#[^)]*)?\)/g)) {
    assert.ok(existsSync(new URL(`../docs/${target}`, import.meta.url)), `broken link: ${target}`)
  }
})

test('README links to troubleshooting-fuses.md', () => {
  assert.match(read('README.md'), /\(docs\/troubleshooting-fuses\.md\)/)
})
