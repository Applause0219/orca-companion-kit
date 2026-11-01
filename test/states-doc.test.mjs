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
  const modes = new Set([...engine.matchAll(/\bmode = '([a-z]+)'/g)].map((m) => m[1]))
  assert.ok(modes.size >= 6, `found only ${[...modes]}`)
  for (const mode of modes) assert.ok(doc.includes(`\`${mode}\``), `mode '${mode}' is missing from docs/states.md`)
})

test('README and companion-api link to states.md', () => {
  assert.match(read('README.md'), /\(docs\/states\.md\)/)
  assert.match(read('docs/companion-api.md'), /\(states\.md\)/)
})
