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

// Every setMode('to', reason) call: the reason is a plain non-empty string literal (or a `cond ? 'a' : 'b'`
// of two), and each one has a row in the transition table with the same new state.
test('every setMode reason is a literal listed in the transition table', () => {
  const engine = read('src/touches/companion.js')
  const section = doc.split('### 每一次換 `mode`')[1]?.split('\n## ')[0] ?? ''
  assert.match(section, /\| 舊 → 新 \| 原因 \| 在哪個函式 \|/)
  const rows = section
    .split('\n')
    .filter((l) => /^\| `[a-z]+` → `[a-z]+` \|/.test(l))
    .map((l) => {
      const [, change, why, fn] = l.split('|').map((c) => c.trim())
      return { to: change.match(/→ `([a-z]+)`/)[1], why, fn: fn.replace(/`/g, '') }
    })
  const calls = [...engine.matchAll(/\bsetMode\(\s*'([a-z]+)'\s*,\s*([^)]*)\)/g)]
  assert.ok(calls.length >= 15, `found only ${calls.length} setMode calls`)
  assert.equal(calls.length, [...engine.matchAll(/\bsetMode\(/g)].length, 'every setMode call names its state as a literal')
  const seen = []
  for (const [call, to, arg] of calls) {
    const m = arg.trim().match(/^(?:[\w.!]+\s*\?\s*)?'([^'\n]*)'(?:\s*:\s*'([^'\n]*)')?$/)
    assert.ok(m, `${call}: the reason must be a string literal`)
    for (const why of [m[1], m[2]].filter((w) => w !== undefined)) {
      assert.ok(why.trim(), `${call}: empty reason`)
      const row = rows.find((r) => r.why === why && r.to === to)
      assert.ok(row, `${call}: '${why}' (→ ${to}) has no row in 每一次換 mode`)
      seen.push(row)
    }
  }
  for (const row of rows) {
    assert.ok(seen.includes(row), `row '${row.why}' is not a setMode reason in companion.js any more`)
    const name = row.fn.split('.').pop()
    assert.match(engine, new RegExp(`\\b${name}\\s*(?:=|:)`), `function '${row.fn}' for '${row.why}' not found`)
  }
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
