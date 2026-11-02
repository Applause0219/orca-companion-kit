// docs/injection-approaches.md explains why the kit injects over CDP instead of a preload. These checks keep
// it honest about what the launcher actually does, and keep the README pointing at it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const doc = read('docs/injection-approaches.md')

test('injection-approaches.md compares the four points in one table', () => {
  for (const row of ['要不要改 app 檔案', '換頁或重新整理後要不要重套', '更新 Orca 後會不會失效', '除錯埠的風險']) {
    assert.ok(doc.split('\n').some((l) => l.startsWith('| **' + row + '**')), `missing row: ${row}`)
  }
})

test('the CDP calls and the pipe it names are the ones the launcher uses', () => {
  const launcher = read('src/themer.mjs')
  for (const call of ['Page.addScriptToEvaluateOnNewDocument', 'Runtime.evaluate', 'Target.setAutoAttach', 'waitForDebuggerOnStart']) {
    assert.ok(doc.includes(call), `doc does not mention ${call}`)
    assert.ok(launcher.includes(call), `launcher no longer uses ${call}; update the doc`)
  }
  assert.match(read('src/cdp-pipe.mjs'), /--remote-debugging-pipe/)
  assert.doesNotMatch(launcher, /--remote-debugging-port/)
})

test('README links to injection-approaches.md', () => {
  assert.match(read('README.md'), /\(docs\/injection-approaches\.md\)/)
})
