// docs/official-theme-plugins.md maps what Orca's own theme plugins can do against what the kit injects.
// These checks keep the "what the kit does now" column in step with the code, and keep its links working.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const doc = read('docs/official-theme-plugins.md')

test('official-theme-plugins.md has a row for each part the official plugins cover', () => {
  for (const row of ['檔案圖示', '語法高亮', '終端機 ANSI 十六色', '色彩模式（亮／暗）']) {
    assert.ok(doc.split('\n').some((l) => l.startsWith('| **' + row + '**')), `missing row: ${row}`)
  }
  assert.match(doc, /## 哪些可以改成純主題檔/)
})

test('the terminal settings it names are the ones the launcher writes', () => {
  const launcher = read('src/themer.mjs')
  for (const key of ['terminalCustomThemes', 'terminalThemeDark']) {
    assert.ok(doc.includes(key), `doc does not mention ${key}`)
    assert.ok(launcher.includes(key), `launcher no longer writes ${key}; update the doc`)
  }
})

test('the built-in themes key their Monaco rule on the editor-bg touch, so it can be turned off', () => {
  for (const file of ['themes/catppuccin-mocha.css', 'themes/rose-pine.css', 'themes/tokyo-night.css', 'examples/themes/cotton-sky.css']) {
    const css = read(file)
    const rules = [...css.matchAll(/([^{}]*)\{([^}]*)\}/g)].filter(([, , body]) => body.includes('--vscode-editor-background'))
    assert.ok(rules.length, `${file}: no Monaco rule`)
    for (const [, selectors] of rules) {
      const list = selectors.replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((s) => s.trim()).filter(Boolean)
      for (const s of list) assert.match(s, /^html\.dark\[data-orca-touch-editor-bg\] /, `${file}: ${s}`)
    }
    assert.match(css, /@touches[^\n]*\beditor-bg\b/, `${file}: @touches does not list editor-bg`)
  }
  assert.match(doc, /html\[data-orca-touch-editor-bg\]/)
})

test('the touches it names exist', () => {
  const builtin = read('src/touches/builtin.js')
  for (const id of ['custom-cursor', 'editor-bg', 'theme-sound']) assert.ok(builtin.includes(`'${id}'`), id)
})

test('links in official-theme-plugins.md point at existing docs, and themes.md links to it', () => {
  for (const [, target] of doc.matchAll(/\]\(([^)#]+)(#[^)]*)?\)/g)) {
    if (/^https?:/.test(target)) continue
    assert.ok(existsSync(new URL(`../docs/${target}`, import.meta.url)), `broken link: ${target}`)
  }
  assert.match(read('docs/themes.md'), /\(official-theme-plugins\.md\)/)
})
