// Which CDP targets get the runtime: only Orca's own windows. src/themer.mjs starts Orca when imported, so
// the launcher's Target.attachedToTarget handler is cut out of its source and run here against a fake cdp,
// once per target in a made-up target list (main window, DevTools, service worker, a window still loading).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const REPO = path.resolve(import.meta.dirname, '..')
const LAUNCHER = fs.readFileSync(path.join(REPO, 'src', 'themer.mjs'), 'utf8').replace(/\r\n/g, '\n')

const INJECTING = ['Runtime.addBinding', 'Fetch.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Runtime.enable']

/** The handler passed to cdp.on('Target.attachedToTarget', …), as a function bound to fakes. */
function attachHandler() {
  const head = "cdp.on('Target.attachedToTarget', "
  const start = LAUNCHER.indexOf(head)
  assert.ok(start >= 0, 'launcher listens to Target.attachedToTarget')
  const end = LAUNCHER.indexOf('\n})\n', start)
  assert.ok(end > start, 'handler end found')
  const source = LAUNCHER.slice(start + head.length, end + 2)
  const calls = []
  const sessions = new Map()
  const context = vm.createContext({
    cdp: {
      send: (method, params, sessionId) => {
        calls.push({ method, sessionId })
        return Promise.resolve(method === 'Page.addScriptToEvaluateOnNewDocument' ? { identifier: '1' } : {})
      }
    },
    sessions,
    patchedAssets: new Map([['index.js', {}]]),
    pageScript: () => '/* runtime */',
    log() {},
    setTimeout() {},
    syncSound: async () => {},
    syncTerminal: async () => {},
    runCheckup: async () => {},
    Promise
  })
  const fn = vm.runInContext(`(${source})`, context, { filename: 'themer.mjs#attachedToTarget' })
  return { fn, calls, sessions }
}

const MAIN = 'file:///C:/Program%20Files/Orca/resources/app.asar/out/renderer/index.html'

/** Run the handler for one target; report whether it was injected and whether it was let go. */
async function attach(targetInfo) {
  const { fn, calls, sessions } = attachHandler()
  const sessionId = `s-${targetInfo.targetId}`
  await fn({ sessionId, targetInfo })
  const mine = calls.filter((c) => c.sessionId === sessionId).map((c) => c.method)
  return {
    injected: mine.some((m) => INJECTING.includes(m)) || sessions.has(sessionId),
    resumed: mine.includes('Runtime.runIfWaitingForDebugger')
  }
}

const targets = {
  main: { targetId: 'main', type: 'page', url: MAIN, title: 'Orca' },
  loadingWindow: { targetId: 'new', type: 'page', url: '', title: '' },
  blankWindow: { targetId: 'blank', type: 'page', url: 'about:blank', title: '' },
  serviceWorker: { targetId: 'sw', type: 'service_worker', url: 'file:///orca/sw.js', title: '' },
  sharedWorker: { targetId: 'shw', type: 'shared_worker', url: 'file:///orca/w.js', title: '' },
  worker: { targetId: 'w', type: 'worker', url: 'blob:file:///x', title: '' },
  devtoolsOther: { targetId: 'dt-other', type: 'other', url: 'devtools://devtools/bundled/devtools_app.html', title: 'DevTools' },
  devtoolsPage: { targetId: 'dt-page', type: 'page', url: 'devtools://devtools/bundled/devtools_app.html', title: 'DevTools' }
}

test('inject target: the main renderer window gets the runtime and is resumed', async () => {
  const r = await attach(targets.main)
  assert.deepEqual(r, { injected: true, resumed: true })
})

// A new window attaches paused before its first navigation, so its url is still '' or about:blank. It has
// to be injected now: Page.addScriptToEvaluateOnNewDocument is what puts the runtime into the Orca
// document it navigates to next. Skipping blank pages would leave every new window unthemed.
test('inject target: a window that has not navigated yet (empty url, about:blank) is still injected', async () => {
  for (const t of [targets.loadingWindow, targets.blankWindow]) {
    assert.deepEqual(await attach(t), { injected: true, resumed: true }, t.targetId)
  }
})

test('inject target: workers and non-page targets are only resumed, never injected', async () => {
  for (const t of [targets.serviceWorker, targets.sharedWorker, targets.worker, targets.devtoolsOther]) {
    assert.deepEqual(await attach(t), { injected: false, resumed: true }, `${t.type} ${t.url}`)
  }
})

test('inject target: over a mixed target list, only the Orca pages are injected', async () => {
  const picked = []
  for (const t of Object.values(targets)) {
    if (t === targets.devtoolsPage) continue // covered by the todo below
    if ((await attach(t)).injected) picked.push(t.targetId)
  }
  assert.deepEqual(picked, ['main', 'new', 'blank'])
})

// Known gap: the handler picks by targetInfo.type alone. A DevTools front end that shows up as a 'page'
// target with a devtools:// url would get the runtime (theme CSS, picker shortcut, touches). Left as a todo
// for the owner to decide whether the launcher should also skip devtools:// urls.
test('inject target: a devtools:// page is not injected', { todo: 'known gap: the attach handler only checks targetInfo.type, so a devtools:// target of type page is injected' }, async () => {
  const r = await attach(targets.devtoolsPage)
  assert.deepEqual(r, { injected: false, resumed: true })
})
