// Reads a public Threads post in a real, logged-out browser (Chrome driven by playwright-core), because the
// page's text only appears after its JavaScript runs. No account, no cookies kept: every read starts a fresh
// browser context that is thrown away afterwards.
//
// Guard rails, enforced in code (no model ever drives this browser):
//  - the code only opens the post it was given and reads text; it never clicks, types or submits
//  - a /share/ link is resolved here first, hop by hop (each hop must stay on Threads and be public), so the
//    browser opens the final post URL directly
//  - every request the browser makes is checked: GET only, https only, Threads and its script CDN only, no
//    images/video/fonts, no messages/account/settings paths; a page navigation must be the post itself
//  - a navigation that the server redirects is treated as a failure (Playwright does not route redirect
//    hops, so the hop itself is one GET we cannot stop; its result is discarded and its sub-requests are
//    still checked)
//  - popups, WebSockets, service workers, downloads, permissions and non-proxied WebRTC UDP are refused
//  - one read at a time, at least MIN_GAP_MS apart
// What keeps messages unreadable is the missing login: there is no account in this browser. The path list
// is a second layer, not the guarantee.
//
// Optional: playwright-core is an optional dependency and Chrome must be installed. BOT_BROWSER=off turns
// this off; BOT_BROWSER=<path> uses another Chromium executable. When it is unavailable, intake falls back
// to the preview tags.
import { assertPublicUrl } from './net-safe.mjs'

// Exact hosts only (core.mjs linkKind also accepts any *.threads.* subdomain to classify a link; the browser
// is stricter on purpose).
const PAGE_HOSTS = new Set(['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net'])
// static.cdninstagram.com serves the page's scripts and stylesheet; without it the post never renders.
const ASSET_HOSTS = new Set(['static.cdninstagram.com'])
const SKIP_TYPES = new Set(['image', 'media', 'font'])
const POST_PATH = /^\/@[A-Za-z0-9._]{1,30}\/post\/[A-Za-z0-9_-]{3,40}\/?$/
const SHORT_PATH = /^\/t\/[A-Za-z0-9_-]{3,40}\/?$/
const SHARE_PATH = /^\/share\/[A-Za-z0-9_-]{3,40}\/?$/
// Paths a logged-out reader never needs: messages, account, settings, notifications, follows.
const DENY_PATH = /^\/(?:direct|messages|accounts|settings|notifications|api\/v1\/(?:direct|direct_v2|accounts|friendships|users))(?:[/?]|$)/i
// Where the post ends and the platform's "more posts" list begins (zh-TW, zh-CN, en).
const RELATED = ['相關串文', '相关串文', 'Related threads']
export const MAX_BROWSER_TEXT = 24000
export const MIN_GAP_MS = 5000
const SHARE_HOPS = 3

const parse = (u) => {
  try {
    return new URL(u)
  } catch {
    return null
  }
}
const onThreads = (x) => !!x && x.protocol === 'https:' && PAGE_HOSTS.has(x.hostname.toLowerCase())
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160)

/** True when `u` is an https Threads post page (`/@user/post/ID` or `/t/ID`). */
export function isThreadsPost(u) {
  const x = parse(u)
  return onThreads(x) && (POST_PATH.test(x.pathname) || SHORT_PATH.test(x.pathname))
}

/** True for a link the bot may start from: a post, or a `/share/ID` link (which redirects to a post). */
export function isThreadsTarget(u) {
  const x = parse(u)
  return isThreadsPost(u) || (onThreads(x) && SHARE_PATH.test(x.pathname))
}

/**
 * The request guard. -> 'continue' | 'abort'. Pure, so tests check it directly.
 * @param {{ url: string, method: string, resourceType: string, navigation: boolean, mainFrame: boolean }} r
 */
export function guardRequest({ url, method, resourceType, navigation, mainFrame }) {
  if (method !== 'GET') return 'abort'
  const x = parse(url)
  if (!x || x.protocol !== 'https:') return 'abort'
  if (navigation) return mainFrame && isThreadsPost(url) ? 'continue' : 'abort'
  if (SKIP_TYPES.has(resourceType)) return 'abort'
  const host = x.hostname.toLowerCase()
  if (PAGE_HOSTS.has(host)) return DENY_PATH.test(x.pathname) ? 'abort' : 'continue'
  return ASSET_HOSTS.has(host) ? 'continue' : 'abort'
}

/**
 * A post link as is, or a /share/ link followed hop by hop (manual redirects; every hop must be a Threads
 * link and resolve to a public address). -> { ok, url, why }. The tracking query is dropped.
 */
export async function resolvePostUrl(url, { fetchImpl = fetch, lookup, timeoutMs = 15000 } = {}) {
  let cur = url
  try {
    for (let hop = 0; hop <= SHARE_HOPS; hop++) {
      if (isThreadsPost(cur)) {
        const x = new URL(cur)
        return { ok: true, url: `${x.origin}${x.pathname}` }
      }
      if (!isThreadsTarget(cur)) return { ok: false, why: 'the share link led outside Threads posts' }
      await assertPublicUrl(cur, lookup)
      const r = await fetchImpl(cur, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
      const loc = r.headers.get('location')
      if (r.status < 300 || r.status >= 400 || !loc) return { ok: false, why: 'the share link did not lead to a post' }
      cur = new URL(loc, cur).href
    }
  } catch (e) {
    return { ok: false, why: `the share link could not be followed: ${firstLine(e)}` }
  }
  return { ok: false, why: 'the share link redirected too many times' }
}

/** Cuts the platform's related-posts list and the size; keeps the post and its replies. */
export function cleanPostText(t) {
  let s = String(t ?? '')
  for (const m of RELATED) {
    const i = s.indexOf(`\n${m}\n`)
    if (i >= 0) s = s.slice(0, i)
  }
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return s.length > MAX_BROWSER_TEXT ? s.slice(0, MAX_BROWSER_TEXT) : s
}

/** launch() options from BOT_BROWSER: '' or 'chrome' = installed Chrome; anything else = an executable path. */
export function launchOptions(env = process.env) {
  const v = String(env.BOT_BROWSER ?? '').trim()
  const args = ['--disable-extensions', '--disable-sync', '--no-first-run', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--dns-prefetch-disable']
  const base = { headless: true, args }
  return !v || v === 'chrome' ? { ...base, channel: 'chrome' } : { ...base, executablePath: v }
}

// One read at a time, at least gapMs apart (module-wide, whoever calls).
let queue = Promise.resolve()
let lastEnd = 0

/**
 * Reads one Threads post. Never throws: { ok, title, text, finalUrl, why }.
 * `load` returns the playwright-core module and `fetchImpl`/`lookup` resolve share links (tests pass fakes).
 */
export function readThreadsInBrowser(url, { env = process.env, gapMs = MIN_GAP_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...opts } = {}) {
  if (String(env.BOT_BROWSER ?? '').trim() === 'off') return Promise.resolve({ ok: false, why: 'browser reading is off (BOT_BROWSER=off)' })
  if (!isThreadsTarget(url)) return Promise.resolve({ ok: false, why: 'not a Threads post link' })
  const run = queue.then(async () => {
    const wait = lastEnd + gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      return await readOnce(url, { env, ...opts })
    } finally {
      lastEnd = Date.now()
    }
  })
  queue = run.then(
    () => {},
    () => {}
  )
  return run
}

async function readOnce(url, { env, load = () => import('playwright-core'), fetchImpl, lookup, timeoutMs = 30000 }) {
  const target = await resolvePostUrl(url, { fetchImpl, lookup })
  if (!target.ok) return { ok: false, why: target.why }
  let chromium
  try {
    ;({ chromium } = await load())
  } catch {
    return { ok: false, why: 'playwright-core is not installed (run npm install)' }
  }
  let browser
  try {
    browser = await chromium.launch(launchOptions(env))
  } catch (e) {
    return { ok: false, why: `the browser could not start (is Chrome installed? set BOT_BROWSER): ${firstLine(e)}` }
  }
  try {
    const ctx = await browser.newContext({ locale: 'zh-TW', serviceWorkers: 'block', acceptDownloads: false, permissions: [] })
    const page = await ctx.newPage()
    ctx.on('page', (p) => p !== page && p.close().catch(() => {})) // no popups
    let redirected = false
    page.on('request', (r) => {
      if (r.isNavigationRequest() && r.redirectedFrom()) redirected = true
    })
    await ctx.route('**/*', (route) => {
      const q = route.request()
      let mainFrame = false
      try {
        mainFrame = q.frame() === page.mainFrame() // frame() throws for some popup and worker requests: refused
      } catch {}
      const verdict = guardRequest({ url: q.url(), method: q.method(), resourceType: q.resourceType(), navigation: q.isNavigationRequest(), mainFrame })
      return verdict === 'continue' ? route.continue() : route.abort()
    })
    await ctx.routeWebSocket(/.*/, (ws) => ws.close())
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    const finalUrl = page.url()
    if (redirected || !isThreadsPost(finalUrl)) return { ok: false, finalUrl, why: 'the post redirected elsewhere (login page, removed or private): not read' }
    // The post renders after its scripts run; wait until the main region holds text, then a moment for replies.
    await page.waitForFunction(() => ((document.querySelector('[role="main"]') || document.body)?.innerText?.length ?? 0) > 80, null, { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(1500)
    const raw = await page.evaluate(() => (document.querySelector('[role="main"]') || document.body)?.innerText ?? '')
    const text = cleanPostText(raw)
    const title = String(await page.title()).trim()
    return text ? { ok: true, title, text, finalUrl } : { ok: false, finalUrl, why: 'the page showed no text' }
  } catch (e) {
    return { ok: false, why: `the browser could not read it: ${firstLine(e)}` }
  } finally {
    await browser.close().catch(() => {})
  }
}
