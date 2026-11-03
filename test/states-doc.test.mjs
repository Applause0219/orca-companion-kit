// docs/states.md describes how the pet's actions interrupt each other. These checks keep it in step with
// the engine: every `mode` the engine sets is named there, and the README and companion-api link to it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const doc = read('docs/states.md')

test('states.md names the four layers', () => {
  for (const layer of ['idle', 'walk', 'reaction', 'alert']) assert.match(doc, new RegExp(`\\*\\*${layer}\\*\\*`), layer)
})

test('every mode the engine sets is in states.md', () => {
  const engine = read('src/touches/companion.js')
  const modes = new Set([...engine.matchAll(/\b(?:mode = |setMode\()'([a-z]+)'/g)].map((m) => m[1]))
  assert.ok(modes.size >= 6, `found only ${[...modes]}`)
  for (const mode of modes) assert.ok(doc.includes(`\`${mode}\``), `mode '${mode}' is missing from docs/states.md`)
})

test('states.md gives every mode a cue besides color', () => {
  const section = doc.split('## 不只靠顏色')[1]?.split('\n## ')[0] ?? ''
  assert.match(section, /\| 狀態 \| 顏色、明暗 \| 非顏色提示 \|/)
  for (const mode of ['home', 'asleep', 'flying', 'following', 'visiting', 'hiding']) {
    const row = section.split('\n').find((l) => l.startsWith('|') && l.includes(`\`${mode}\``))
    assert.ok(row, `mode '${mode}' has no row in 不只靠顏色`)
    assert.ok(row.split('|')[3]?.trim(), `mode '${mode}' has an empty 非顏色提示`)
  }
})

test('the Puff demo for agent work is a sign, not a color', () => {
  const puff = read('examples/touches/puff.js')
  assert.match(puff, /emotes: \{ working: \['⚙'/)
  assert.match(puff, /busyToo: \{\s*weight: \(c\) => \(c\.working \? 6 : 0\)/)
  assert.match(puff, /emote\('working'\)/)
})

test('README and companion-api link to states.md', () => {
  assert.match(read('README.md'), /\(docs\/states\.md\)/)
  assert.match(read('docs/companion-api.md'), /\(states\.md\)/)
})
