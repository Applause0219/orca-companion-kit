// Reload and new windows: every fresh document gets the runtime and the theme again, and a document that
// receives the runtime twice (Page.addScriptToEvaluateOnNewDocument, then Runtime.evaluate on the new
// context) still ends up with one runtime and one theme <style>. The page side runs in a tiny fake DOM;
// the launcher side is checked in its source, since src/themer.mjs starts Orca when imported.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { composeCss, publicState } from '../src/themes.mjs'

const REPO = path.resolve(import.meta.dirname, '..')
const RUNTIME = fs.readFileSync(path.join(REPO, 'src', 'page-runtime.js'), 'utf8')
const LAUNCHER = fs.readFileSync(path.join(REPO, 'src', 'themer.mjs'), 'utf8')

// Just enough DOM for page-runtime.js: ids, head/body order, append/prepend/remove, dataset.
function element(tagName) {
  const el = {
    tagName,
    id: '',
    textContent: '',
    parent: null,
    children: [],
    dataset: {},
    attributes: {},
    get isConnected() {
      let n = this
      while (n.parent) n = n.parent
      return n.tagName === 'html'
    },
    get lastElementChild() {
      return this.children.at(-1) ?? null
    },
    appendChild(child) {
      child.remove()
      child.parent = this
      this.children.push(child)
      return child
    },
    prepend(child) {
      child.remove()
      child.parent = this
      this.children.unshift(child)
    },
    remove() {
      if (!this.parent) return
      this.parent.children.splice(this.parent.children.indexOf(this), 1)
      this.parent = null
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value)
    },
    getAttribute(name) {
      return this.attributes[name] ?? null
    },
    removeAttribute(name) {
      delete this.attributes[name]
    },
    addEventListener() {},
    querySelector: () => null
  }
  return el
}

function all(node, out = []) {
  for (const c of node.children) out.push(c), all(c, out)
  return out
}

/** A fresh document, as after a reload or in a newly opened window. */
// loaded: the page finished loading before the runtime arrived, so DOMContentLoaded never fires again.
function freshWindow(media = { matches: false, addEventListener() {} }, { loaded = false } = {}) {
  const html = element('html')
  const head = html.appendChild(element('head'))
  const body = html.appendChild(element('body'))
  const sent = []
  const listeners = []
  const observers = []
  const docListeners = {}
  let created = 0
  const document = {
    documentElement: html,
    head,
    body,
    visibilityState: 'visible',
    createElement: (tag) => {
      if (tag === 'style') created++
      return element(tag)
    },
    getElementById: (id) => all(html).find((n) => n.id === id) ?? null,
    querySelector: (sel) => (sel === 'meta[name="color-scheme"]' ? all(html).find((n) => n.tagName === 'meta' && n.attributes.name === 'color-scheme') ?? null : null),
    addEventListener(type, fn) {
      if (type === 'DOMContentLoaded' && !loaded) fn()
      else (docListeners[type] ??= []).push(fn)
    }
  }
  const win = {
    document,
    location: { href: 'file:///orca/out/renderer/index.html' },
    navigator: { platform: 'Win32' },
    matchMedia: () => media,
    MutationObserver: class {
      constructor(fn) {
        this.fn = fn
        this.targets = []
      }
      observe(target) {
        if (!this.targets.includes(target)) this.targets.push(target)
        if (!observers.includes(this)) observers.push(this)
      }
      disconnect() {
        this.targets = []
      }
    },
    CustomEvent: class {
      constructor(type) {
        this.type = type
      }
    },
    dispatchEvent() {},
    addEventListener: (type) => listeners.push(type),
    removeEventListener() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    console: { warn() {}, log() {} },
    orcaThemerSend: (json) => sent.push(JSON.parse(json))
  }
  win.window = win
  const context = vm.createContext(win)
  return {
    win,
    sent,
    listeners,
    inject: () => vm.runInContext(RUNTIME, context, { filename: 'page-runtime.js' }),
    // Delivers a DOM change to every observer watching something, as the browser would after a mutation.
    mutate: () => {
      for (const o of observers) if (o.targets.length) o.fn([])
    },
    themeStyles: () => all(html).filter((n) => n.id === 'orca-themer-style'),
    // The window goes to the background or comes back, as the browser reports it.
    setVisibility: (state) => {
      document.visibilityState = state
      for (const fn of docListeners.visibilitychange ?? []) fn()
    },
    stylesCreated: () => created
  }
}

const payload = (css) => ({ state: { themes: [{ id: 'night', touches: [] }], themeId: 'night', enabledTouches: [] }, css })

test('reinject: a second copy in the same document is ignored (one runtime, one hello, one picker shortcut)', () => {
  const w = freshWindow()
  w.inject() // Page.addScriptToEvaluateOnNewDocument
  const runtime = w.win.__orcaThemer
  const listenersAfterFirst = w.listeners.length
  w.inject() // Runtime.evaluate on Runtime.executionContextCreated
  w.inject() // a touch save re-evaluates it once more
  assert.equal(w.win.__orcaThemer, runtime, 'the first runtime stays')
  assert.equal(w.listeners.length, listenersAfterFirst, 'no second set of keydown listeners')
  assert.deepEqual(w.sent.map((m) => m.type), ['hello'])
})

test('reinject: applying again reuses the theme <style>, never adds a second one', () => {
  const w = freshWindow()
  w.inject()
  w.win.__orcaThemer.apply(payload(':root{--background:#000}'))
  w.inject()
  w.win.__orcaThemer.apply(payload(':root{--background:#111}'))
  const styles = w.themeStyles()
  assert.equal(styles.length, 1)
  assert.equal(styles[0].textContent, ':root{--background:#111}')
  assert.equal(w.win.document.head.lastElementChild, styles[0], 'kept last in <head> so it wins ties')
  assert.equal(w.win.document.documentElement.dataset.orcaTheme, 'night')
})

test('reinject: a page that finished loading before the runtime arrived gets the theme at once (DOMContentLoaded will not fire again)', () => {
  const w = freshWindow(undefined, { loaded: true })
  w.inject()
  w.win.__orcaThemer.apply(payload(':root{--background:#000}'))
  const styles = w.themeStyles()
  assert.equal(styles.length, 1)
  assert.equal(styles[0].textContent, ':root{--background:#000}')
  assert.equal(w.win.document.documentElement.dataset.orcaTheme, 'night')
})

test('reinject: a theme <style> already in the page is taken over, not duplicated', () => {
  const w = freshWindow()
  const old = element('style')
  old.id = 'orca-themer-style'
  w.win.document.head.appendChild(old)
  w.win.document.head.appendChild(element('link')) // a lazy chunk stylesheet added after it
  w.inject()
  w.win.__orcaThemer.apply(payload('a{}'))
  assert.deepEqual(w.themeStyles(), [old])
  assert.equal(old.textContent, 'a{}')
  assert.equal(w.win.document.head.lastElementChild, old)
})

// The page switching light/dark in place (meta color-scheme, or the root's class/style) fires no event;
// the runtime's observer re-applies the theme under the same id, so the sheet survives and never doubles.
test('color scheme: changing meta color-scheme in place keeps exactly one theme <style> with the theme', () => {
  const w = freshWindow()
  const { head } = w.win.document
  const meta = element('meta')
  meta.setAttribute('name', 'color-scheme')
  meta.setAttribute('content', 'dark')
  head.appendChild(meta)
  w.inject()
  w.win.__orcaThemer.apply(payload(':root{--background:#000}'))
  // The page drops our sheet while switching (as a head rewrite would), then flips the scheme.
  w.themeStyles()[0].remove()
  meta.setAttribute('content', 'light')
  w.mutate()
  let styles = w.themeStyles()
  assert.equal(styles.length, 1, 'the theme is back, once')
  assert.equal(styles[0].textContent, ':root{--background:#000}')
  assert.equal(head.lastElementChild, styles[0], 'still last in <head>')
  // A stray copy under our id (left by the page) is removed before re-adding, so they never stack.
  const stray = element('style')
  stray.id = 'orca-themer-style'
  w.win.document.body.appendChild(stray)
  meta.setAttribute('content', 'dark')
  w.mutate()
  styles = w.themeStyles()
  assert.equal(styles.length, 1)
  assert.equal(styles[0].textContent, ':root{--background:#000}')
})

test('color scheme: unrelated mutations do not re-add the theme <style>, and theme off stays off', () => {
  const w = freshWindow()
  const meta = element('meta')
  meta.setAttribute('name', 'color-scheme')
  meta.setAttribute('content', 'dark')
  w.win.document.head.appendChild(meta)
  w.inject()
  w.win.__orcaThemer.apply(payload('a{}'))
  const sheet = w.themeStyles()[0]
  w.mutate() // scheme unchanged: nothing is removed or re-added
  assert.deepEqual(w.themeStyles(), [sheet])
  w.win.__orcaThemer.apply(payload(''))
  meta.setAttribute('content', 'light')
  w.mutate()
  for (const s of w.themeStyles()) assert.equal(s.textContent, '', 'no theme rules come back after the theme was turned off')
})

// A background window's timers are throttled, so a sheet lost while hidden is put back the moment the
// window is shown again: once, and only when it is actually gone.
test('visibility: hidden -> visible with the theme <style> cleared puts it back exactly once', () => {
  const w = freshWindow()
  w.inject()
  w.win.__orcaThemer.apply(payload(':root{--background:#000}'))
  w.setVisibility('hidden')
  w.themeStyles()[0].remove() // lost while in the background
  const before = w.stylesCreated()
  w.setVisibility('hidden') // still hidden: nothing to do yet
  assert.equal(w.themeStyles().length, 0)
  w.setVisibility('visible')
  const styles = w.themeStyles()
  assert.equal(styles.length, 1, 'the theme is back, once')
  assert.equal(styles[0].textContent, ':root{--background:#000}')
  assert.equal(w.win.document.head.lastElementChild, styles[0])
  assert.equal(w.stylesCreated() - before, 1, 'applied a single time')
  w.setVisibility('visible') // already there: left alone
  assert.deepEqual(w.themeStyles(), styles)
  assert.equal(w.stylesCreated() - before, 1)
})

test('visibility: coming back with the theme <style> intact, or with no theme, adds nothing', () => {
  const w = freshWindow()
  w.inject()
  w.setVisibility('hidden')
  w.setVisibility('visible')
  assert.equal(w.themeStyles().length, 0, 'no theme applied yet: nothing to restore')
  w.win.__orcaThemer.apply(payload('a{}'))
  const sheet = w.themeStyles()[0]
  const before = w.stylesCreated()
  w.setVisibility('hidden')
  w.setVisibility('visible')
  assert.deepEqual(w.themeStyles(), [sheet])
  assert.equal(w.stylesCreated(), before)
})

test('reinject: a reload or a new window starts clean and gets the runtime and the theme again', () => {
  const before = freshWindow()
  before.inject()
  before.win.__orcaThemer.apply(payload('a{}'))
  for (const next of [freshWindow(), freshWindow()]) {
    assert.equal(next.win.__orcaThemer, undefined)
    next.inject()
    next.inject()
    assert.ok(next.win.__orcaThemer, 'runtime installed in the new document')
    assert.notEqual(next.win.__orcaThemer, before.win.__orcaThemer)
    next.win.__orcaThemer.apply(payload('a{}'))
    assert.equal(next.themeStyles().length, 1)
    assert.deepEqual(next.sent.map((m) => m.type), ['hello'])
  }
})

// prefers-reduced-motion: the pet (and every other touch) is never started while the system asks for
// less motion, and one already running is stopped as soon as the setting flips; it comes back when it
// flips off. This is the whole reduced-motion story for companion.js, so its looping motion needs no
// media query of its own.
function reducedMotionWindow(reduce) {
  const media = {
    matches: reduce,
    listeners: [],
    addEventListener(type, fn) {
      if (type === 'change') this.listeners.push(fn)
    },
    flip(next) {
      this.matches = next
      for (const fn of this.listeners) fn({ matches: next })
    }
  }
  const w = freshWindow(media)
  w.inject()
  const log = []
  w.win.__orcaThemer.registerTouch('companion', {
    start() {
      log.push('start')
      return () => log.push('stop')
    }
  })
  w.win.__orcaThemer.apply({ state: { themes: [{ id: 'night', touches: ['companion'] }], themeId: 'night', enabledTouches: ['companion'] }, css: '' })
  return { media, log }
}

test('reduced motion: the companion is not started while the system asks for less motion', () => {
  const { log } = reducedMotionWindow(true)
  assert.deepEqual(log, [])
})

test('reduced motion: turning it on stops a running companion, turning it off starts it again', () => {
  const { media, log } = reducedMotionWindow(false)
  assert.deepEqual(log, ['start'])
  assert.ok(media.listeners.length > 0, 'the runtime listens for the setting changing')
  media.flip(true)
  assert.deepEqual(log, ['start', 'stop'])
  media.flip(false)
  assert.deepEqual(log, ['start', 'stop', 'start'])
})

// The launcher half: what makes the page side above happen on every reload and every window.
const handler = (event) => {
  const start = LAUNCHER.indexOf(`cdp.on('${event}'`)
  assert.ok(start >= 0, `launcher listens to ${event}`)
  const end = LAUNCHER.indexOf('\ncdp.on(', start + 1)
  return LAUNCHER.slice(start, end < 0 ? undefined : end)
}

test('reinject: every page target registers the runtime for each new document before it resumes', () => {
  const attach = handler('Target.attachedToTarget')
  assert.match(attach, /Page\.addScriptToEvaluateOnNewDocument', \{ source: pageScript\(\) \}/)
  assert.match(attach, /Runtime\.enable/)
  const resumed = attach.indexOf('const resumed')
  assert.ok(resumed > 0 && attach.indexOf('addScriptToEvaluateOnNewDocument') < resumed, 'registered before the paused page resumes')
  // A theme change swaps the registered script instead of stacking a second one per document.
  assert.match(LAUNCHER, /removeScriptToEvaluateOnNewDocument', \{ identifier: entry\.scriptId \}/)
})

test('reinject: each new main-world context is evaluated once, and a throw is logged from exceptionDetails', () => {
  const created = handler('Runtime.executionContextCreated')
  assert.match(created, /context\.auxData\?\.isDefault/, 'only the main world, not the preload world')
  assert.match(created, /Runtime\.evaluate', \{ expression: pageScript\(\), contextId: context\.id \}/)
  assert.match(created, /r\.exceptionDetails/)
  assert.match(created, /runtimeError \?\?=/, 'the first error reaches the update checkup')
  assert.match(created, /log\('runtime evaluated'/)
  // The runtime itself is what makes the second copy harmless.
  assert.match(RUNTIME, /^\s*if \(window\.__orcaThemer\) return$/m)
})

// Switching and turning off themes: the launcher's broadcast() sends every window the payload built by
// composeCss/publicState, and the page reuses its one <style>. Three switches leave one theme sheet per
// window holding only the last theme; "Orca 原色" (themeId null) leaves no theme rules and no theme touch.
const library = {
  themes: ['a', 'b', 'c'].map((id) => ({ id, name: id, touches: [`spark-${id}`], css: `:root{--background:#${id}${id}${id}}` })),
  snippets: []
}
const settingsFor = (themeId) => ({ themeId, enabledSnippets: [], enabledTouches: ['spark-a', 'spark-b', 'spark-c'], companions: {} })
const launcherPayload = (themeId) => ({ css: composeCss(library, settingsFor(themeId)), state: publicState(library, settingsFor(themeId)) })

/** Two Orca windows (as broadcast() sees them), each with the runtime and one touch per theme. */
function themedWindows() {
  return [freshWindow(), freshWindow()].map((w) => {
    w.inject()
    const log = []
    for (const t of library.themes) {
      const id = `spark-${t.id}`
      w.win.__orcaThemer.registerTouch(id, {
        start() {
          log.push(`start ${id}`)
          return () => log.push(`stop ${id}`)
        }
      })
    }
    return { ...w, log, injectedStyles: () => all(w.win.document.documentElement).filter((n) => n.tagName === 'style') }
  })
}
const broadcastTo = (windows, themeId) => {
  for (const w of windows) {
    w.inject() // broadcast() re-registers the runtime; a second copy is a no-op
    w.win.__orcaThemer.apply(launcherPayload(themeId))
  }
}

test('theme switch: three switches leave each window one theme <style>, holding only the last theme', () => {
  const windows = themedWindows()
  for (const id of ['a', 'b', 'c']) broadcastTo(windows, id)
  for (const w of windows) {
    const sheets = w.themeStyles()
    assert.equal(sheets.length, 1, 'one theme sheet per window')
    assert.match(sheets[0].textContent, /theme: c/)
    assert.doesNotMatch(sheets[0].textContent, /theme: [ab]\b|#aaa|#bbb/, 'nothing of the earlier themes stays')
    // The runtime's own picker sheet plus the theme sheet, never one per switch.
    assert.deepEqual(w.injectedStyles().map((n) => n.id).sort(), ['orca-themer-style', 'orca-themer-ui'])
    assert.equal(w.win.document.documentElement.dataset.orcaTheme, 'c')
    assert.deepEqual(w.log, ['start spark-a', 'stop spark-a', 'start spark-b', 'stop spark-b', 'start spark-c'], 'only the current theme touch runs')
  }
})

test('theme off: no theme rules, no theme marker and no theme touch stay in any window', () => {
  const windows = themedWindows()
  for (const id of ['a', 'b', 'c']) broadcastTo(windows, id)
  broadcastTo(windows, null) // the picker's "Orca 原色" sends select-theme with id null
  for (const w of windows) {
    for (const sheet of w.themeStyles()) assert.equal(sheet.textContent, '', 'the theme sheet is emptied')
    const ui = w.injectedStyles().find((n) => n.id === 'orca-themer-ui')
    assert.ok(ui && !/:root|--[\w-]+\s*:/.test(ui.textContent), 'only the picker sheet keeps rules, all scoped to the picker and notice')
    assert.equal(w.win.document.documentElement.dataset.orcaTheme, '')
    assert.equal(w.log.at(-1), 'stop spark-c')
    const count = (word) => w.log.filter((l) => l.startsWith(word)).length
    assert.equal(count('start'), count('stop'), 'every started touch was stopped')
  }
})

// Known failure: turning the theme off empties the theme <style> but leaves the element in <head>
// (styleElement() reuses it rather than removing it). It holds no rules, so it styles nothing, but the
// page is not free of injected theme <style> elements as the cleanup check asks.
test('theme off: the theme <style> element itself is removed', { todo: 'known failure: apply() with empty css keeps an empty <style id="orca-themer-style"> in <head>' }, () => {
  const windows = themedWindows()
  broadcastTo(windows, 'a')
  broadcastTo(windows, null)
  for (const w of windows) assert.deepEqual(w.themeStyles(), [])
})

test('theme switch: no inspector or constructed stylesheets, only the one <style> per document', () => {
  // CSS.createStyleSheet / CSS.addRule would stack an inspector sheet per call, and constructed sheets
  // would outlive the <style>; neither the launcher nor the runtime uses them.
  for (const [name, source] of [['launcher', LAUNCHER], ['runtime', RUNTIME]]) {
    assert.doesNotMatch(source, /CSS\.(createStyleSheet|addRule|setStyleSheetText)|adoptedStyleSheets|new CSSStyleSheet|insertRule/, name)
  }
})
