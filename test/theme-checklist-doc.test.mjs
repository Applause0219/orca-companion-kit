// docs/theme-checklist.md is the checklist theme authors go through. These checks keep its four sections,
// keep the style id it names in step with the runtime, keep its relative links alive, and keep the README pointing at it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const doc = read('docs/theme-checklist.md')

test('theme-checklist.md has its four sections', () => {
  for (const heading of ['## 選擇器：照穩定程度挑', '## 樣式節點：固定 id，不重複', '## 重新載入、換頁之後要再套一次', '## 失敗時安靜退回原本的樣子']) {
    assert.ok(doc.split(/\r?\n/).includes(heading), `missing section: ${heading}`)
  }
})

test('selector order is role/aria, then stable attributes, then class', () => {
  const role = doc.indexOf('1. **role／aria**')
  const attr = doc.indexOf('2. **穩定屬性**')
  const cls = doc.indexOf('3. **class**')
  assert.ok(role >= 0 && role < attr && attr < cls)
  for (const avoid of ['雜湊 class', 'nth-child', '比對文字']) assert.ok(doc.includes(avoid), `missing: ${avoid}`)
})

test('the theme style id it names is the one the runtime uses', () => {
  assert.ok(doc.includes('orca-themer-style'))
  assert.match(read('src/page-runtime.js'), /STYLE_ID = 'orca-themer-style'/)
})

test('relative links point at existing docs', () => {
  for (const [, target] of doc.matchAll(/\]\(([^)#]+\.md)(#[^)]*)?\)/g)) {
    assert.ok(existsSync(new URL(`../docs/${target}`, import.meta.url)), `broken link: ${target}`)
  }
})

test('README links to theme-checklist.md', () => {
  assert.match(read('README.md'), /\(docs\/theme-checklist\.md\)/)
})
