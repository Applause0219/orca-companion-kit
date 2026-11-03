// The performance rules (docs/performance.md) hold for every file in this repo, and the linter catches
// each trap it is meant to catch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { lintCss, lintTerminal, lintTouch } from '../src/lint.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const files = (dir, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(ext)).map((n) => path.join(dir, n)) : [])
const errors = (issues) => issues.filter((i) => i.level === 'error')

test('repo themes, snippets and examples pass the CSS rules', () => {
  for (const file of [...files(path.join(REPO, 'themes'), '.css'), ...files(path.join(REPO, 'examples', 'themes'), '.css'), ...files(path.join(REPO, 'examples', 'snippets'), '.css')])
    assert.deepEqual(lintCss(fs.readFileSync(file, 'utf8')), [], file)
})

test('repo touches and example touches parse and pass the touch rules', () => {
  for (const file of [...files(path.join(REPO, 'src', 'touches'), '.js'), ...files(path.join(REPO, 'examples', 'touches'), '.js')])
    assert.deepEqual(lintTouch(fs.readFileSync(file, 'utf8'), file), [], file)
})

test('example terminal palettes are valid', () => {
  for (const file of files(path.join(REPO, 'examples', 'terminal'), '.json')) assert.deepEqual(lintTerminal(fs.readFileSync(file, 'utf8')), [], file)
})

test('lint: catches a page-wide ::selection, allows one on a single element', () => {
  assert.equal(errors(lintCss('::selection{background:red}'))[0]?.rule, 'page-wide-selection')
  assert.equal(errors(lintCss('html, *::selection{background:red}'))[0]?.rule, 'page-wide-selection')
  assert.equal(errors(lintCss('.panel ::selection{background:red}'))[0]?.rule, 'page-wide-selection')
  assert.deepEqual(lintCss('.panel::selection{background:red}'), [])
  assert.deepEqual(lintCss('/* ::selection in a comment */ a{color:red}'), [])
})

test('lint: catches combinators inside :not(), ignores simple arguments and url()', () => {
  assert.equal(errors(lintCss('*:not(.a .b){color:red}'))[0]?.rule, 'not-combinator')
  assert.equal(errors(lintCss('*:not(.a > .b){color:red}'))[0]?.rule, 'not-combinator')
  assert.deepEqual(lintCss("*:not([role='separator'], .x, [class*='resize']){cursor:url(\"data:image/svg+xml,%3Csvg a b%3E\") 2 2, auto}"), [])
})

test('lint: warns about universal transitions and whole-window filters', () => {
  assert.equal(lintCss('* { transition: color .2s }')[0]?.rule, 'universal-motion')
  assert.equal(lintCss('body { backdrop-filter: blur(4px) }')[0]?.rule, 'window-filter')
})

test('lint: touch rules (syntax, Esc, IME, readback, cleanup)', () => {
  assert.equal(lintTouch('T.registerTouch("x", {')[0].rule, 'syntax')
  const esc =
    'T.registerTouch("x",{start(){const k=(e)=>{if(e.key==="Escape")stop()};addEventListener("keydown",k);addEventListener("compositionend",k);return()=>{removeEventListener("keydown",k);removeEventListener("compositionend",k)}}})'
  assert.ok(errors(lintTouch(esc)).some((i) => i.rule === 'esc-binding'))
  const rules = lintTouch('T.registerTouch("x",{start(){addEventListener("keydown",f);setInterval(f,9);c.getImageData(0,0,1,1)}})').map((i) => i.rule)
  for (const rule of ['ime', 'cleanup', 'canvas-readback']) assert.ok(rules.includes(rule), rule)
  assert.equal(lintTouch('// Escape is mentioned only in a comment\nT.registerTouch("x",{start(){}})').length, 0)
  // Typing is heard on the window or the document; a panel's own arrow keys are not typing.
  assert.ok(lintTouch('T.registerTouch("x",{start(){document.addEventListener("keydown",f);return()=>document.removeEventListener("keydown",f)}})').some((i) => i.rule === 'ime'))
  assert.ok(lintTouch('T.registerTouch("x",{start(){window.addEventListener("keydown",f);return()=>window.removeEventListener("keydown",f)}})').some((i) => i.rule === 'ime'))
  assert.deepEqual(lintTouch('T.registerPickerItem({id:"p",run(){const nav=document.createElement("div");nav.addEventListener("keydown",f);nav.removeEventListener("keydown",f)}})'), [])
})

test('lint: warns (never errors) about fragile selectors in CSS', () => {
  const fragile = (css) => lintCss(css).filter((i) => i.rule === 'fragile-selector')
  assert.equal(fragile('.tabs > div:nth-child(2){color:red}').length, 1)
  assert.equal(fragile('li:nth-of-type(3){color:red}').length, 1)
  assert.equal(fragile('.css-1x2y3z{color:red}').length, 1)
  assert.equal(fragile('._a8f3c{color:red}').length, 1)
  assert.equal(fragile('.sc-bdVaJa span{color:red}').length, 1)
  assert.equal(fragile('a{color:red}\n\n.css-1x2y3z{color:red}')[0].line, 3)
  assert.ok(lintCss('div:nth-child(2), .css-1x2y3z{color:red}').every((i) => i.level === 'warn'))
  // Stable hooks, values and strings are not selectors to warn about.
  assert.deepEqual(lintCss("[role='separator'], [aria-selected='true'], [data-testid=\"sortable-tab\"]{color:red}"), [])
  assert.deepEqual(lintCss('.monaco-editor .xterm-viewport, .bg-worktree-sidebar, .xterm-256color{color:red}'), [])
  assert.deepEqual(lintCss(".a{transition:opacity 0.25s;font-family:'Noto Sans TC'}\n@media (min-width:40.5em){.b{color:red}}"), [])
  assert.deepEqual(lintCss("[aria-label='x.css-1x2y3z']{color:red}"), [])
  assert.deepEqual(lintCss('/* .css-1x2y3z li:nth-child(2) */ a{color:red}'), [])
})

test('lint: warns (never errors) about fragile selectors and text matching in touches', () => {
  const fragile = (code) => {
    const issues = lintTouch(`T.registerTouch("x",{start(){${code}\n}})`)
    assert.ok(!issues.some((i) => i.rule === 'syntax'), code)
    return issues.filter((i) => i.rule === 'fragile-selector')
  }
  assert.equal(fragile('document.querySelector(".tabs > button:nth-child(2)")').length, 1)
  assert.equal(fragile("document.querySelectorAll('.css-1x2y3z')").length, 1)
  assert.equal(fragile('el.closest(`.sc-bdVaJa`)').length, 1)
  assert.equal(fragile('const b=[...document.querySelectorAll("button")].find((b)=>b.textContent==="設定")').length, 1)
  assert.equal(fragile('if(el.innerText.trim()==="Settings")x()').length, 1)
  assert.equal(fragile('if(el.textContent?.includes("終端機"))x()').length, 1)
  assert.equal(fragile('if(/設定/.test(el.textContent))x()').length, 1)
  assert.ok(lintTouch('T.registerTouch("x",{start(){document.querySelector("li:nth-child(2)")}})').every((i) => i.level === 'warn'))
  // Stable hooks and writing text are fine.
  assert.deepEqual(fragile("document.querySelector('[role=\"tab\"][aria-selected=\"true\"]')"), [])
  assert.deepEqual(fragile("document.querySelector('[data-testid=\"sortable-tab\"] .monaco-editor')"), [])
  assert.deepEqual(fragile('el.textContent = "✦"; const t = tab?.getAttribute("data-tab-title") ?? tab?.textContent ?? ""'), [])
  assert.deepEqual(fragile('// el.textContent === "x" and li:nth-child(2) only in a comment'), [])
})

test('lint: terminal palettes need #hex colors', () => {
  assert.equal(lintTerminal('{"background":"red"}').some((i) => i.rule === 'terminal-color'), true)
  assert.equal(lintTerminal('nope')[0].rule, 'json')
})

test('lint: a touch that registers nothing is flagged, a shared module that sets T.<name> is not', () => {
  const rule = (code) => lintTouch(code, 'x.js').map((i) => i.rule)
  assert.ok(rule(';(() => { const x = 1 })()').includes('no-register'))
  assert.ok(!rule(';(() => {\n  const T = window.__orcaThemer\n  T.myModel = { a: 1 }\n})()').includes('no-register'))
})
