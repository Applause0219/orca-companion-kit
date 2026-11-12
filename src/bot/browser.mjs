// Reads a public Threads or Instagram post in a real, logged-out browser (Chrome driven by playwright-core),
// because the post's text only appears after the page's JavaScript runs (Threads) or is missing from the
// preview tags (Instagram image posts). No account, no cookies kept: every read starts a fresh browser
// context that is thrown away afterwards.
//
// Guard rails, enforced in code (no model ever drives this browser):
//  - the code only opens the post it was given and reads text; it never clicks, types or submits
//  - a share link is resolved here first, hop by hop (each hop must stay on the same site and be public),
//    so the browser opens the final post URL directly
//  - every request the browser makes is checked against that ONE site's list: GET only, https only, the
//    site's own host and its script CDN only (a Threads read never reaches instagram.com and the other way
//    round), no images/video/fonts, no messages/account/settings paths; a page navigation must be the post
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
// to yt-dlp (Instagram) and the preview tags.
import { assertPublicUrl } from './net-safe.mjs'

const ID = '[A-Za-z0-9_-]'
// One entry per site. Exact hosts only (core.mjs linkKind accepts any subdomain to classify a link; the
// browser is stricter on purpose). static.cdninstagram.com serves both sites' scripts and stylesheets:
// without it nothing renders. Instagram's page also asks www.facebook.com and its image CDNs: refused, the
// caption still renders (measured 2026-11-12).
const SITES = {
  threads: {
    label: 'Threads',
    pageHosts: new Set(['www.threads.com', 'threads.com', 'www.threads.net', 'threads.net']),
    assetHosts: new Set(['static.cdninstagram.com']),
    post: [new RegExp(`^/@[A-Za-z0-9._]{1,30}/post/${ID}{3,40}/?$`), new RegExp(`^/t/${ID}{3,40}/?$`)],
    share: new RegExp(`^/share/${ID}{3,40}/?$`),
    // Where the post ends and the platform's "more posts" list begins (zh-TW, zh-CN, en).
    related: ['相關串文', '相关串文', 'Related threads'],
    noise: { lines: new Set(), starts: [] },
    shows: 'the post and the replies shown without an account'
  },
  instagram: {
    label: 'Instagram',
    pageHosts: new Set(['www.instagram.com', 'instagram.com']),
    assetHosts: new Set(['static.cdninstagram.com']),
    // /p/ID, /reel/ID, /reels/ID, /tv/ID, optionally after the account name (/name/p/ID). A first segment
    // that is one of Instagram's own sections is not an account name: /share/p/ID is a share link.
    post: [new RegExp(`^/(?:(?!(?:share|direct|accounts|explore|stories|challenge)/)[A-Za-z0-9._]{1,30}/)?(?:p|reels?|tv)/${ID}{5,40}/?$`)],
    share: new RegExp(`^/share/(?:(?:p|reels?)/)?${ID}{3,40}/?$`),
    related: [],
    // The logged-out sign-up banner and the like/reply buttons under every comment.
    noise: {
      lines: new Set(['註冊', '登入', '追蹤', '讚', '回覆', '•', 'Sign up', 'Log in', 'Follow', 'Like', 'Reply']),
      starts: ['絕不錯過', '註冊 Instagram', '繼續操作即表示你同意 Instagram', 'Never miss a post from', 'Sign up for Instagram', 'By continuing, you agree to Instagram']
    },
    shows: 'the caption and the comments shown without an account'
  }
}
const SKIP_TYPES = new Set(['image', 'media', 'font'])
// Paths a logged-out reader never needs: messages, account, settings, notifications, follows, checkpoints.
const DENY_PATH = /^\/(?:direct|messages|accounts|settings|notifications|challenge|api\/v1\/(?:direct|direct_v2|accounts|friendships|users))(?:[/?]|$)/i
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
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 160)

/** 'threads' | 'instagram' for an https link on one of those sites' page hosts, else null. */
export function siteOf(u) {
  const x = parse(u)
  if (!x || x.protocol !== 'https:') return null
  const h = x.hostname.toLowerCase()
  return Object.keys(SITES).find((k) => SITES[k].pageHosts.has(h)) ?? null
}

/** True when `u` is an https post page of `site` (or of either site when omitted). */
export function isPost(u, site = siteOf(u)) {
  if (!site || siteOf(u) !== site) return false
  const p = new URL(u).pathname
  return !DENY_PATH.test(p) && SITES[site].post.some((re) => re.test(p))
}

/** True for a link the bot may start from: a post, or a share link (which redirects to a post). */
export function isTarget(u, site = siteOf(u)) {
  return isPost(u, site) || (!!site && siteOf(u) === site && SITES[site].share.test(new URL(u).pathname))
}

/**
 * The request guard for a read on `site`. -> 'continue' | 'abort'. Pure, so tests check it directly.
 * @param {{ site: string, url: string, method: string, resourceType: string, navigation: boolean, mainFrame: boolean }} r
 */
export function guardRequest({ site, url, method, resourceType, navigation, mainFrame }) {
  const s = SITES[site]
  if (!s || method !== 'GET') return 'abort'
  const x = parse(url)
  if (!x || x.protocol !== 'https:') return 'abort'
  if (navigation) return mainFrame && isPost(url, site) ? 'continue' : 'abort'
  if (SKIP_TYPES.has(resourceType)) return 'abort'
  const host = x.hostname.toLowerCase()
  if (s.pageHosts.has(host)) return DENY_PATH.test(x.pathname) ? 'abort' : 'continue'
  return s.assetHosts.has(host) ? 'continue' : 'abort'
}

/**
 * A post link as is, or a share link followed hop by hop (manual redirects; every hop must be a link of the
 * same site and resolve to a public address). -> { ok, url, why }. The tracking query is dropped.
 */
export async function resolvePostUrl(url, { fetchImpl = fetch, lookup, timeoutMs = 15000 } = {}) {
  const site = siteOf(url)
  let cur = url
  try {
    for (let hop = 0; hop <= SHARE_HOPS; hop++) {
      if (isPost(cur, site)) {
        const x = new URL(cur)
        return { ok: true, url: `${x.origin}${x.pathname}` }
      }
      if (!isTarget(cur, site)) return { ok: false, why: `the share link led outside ${SITES[site]?.label ?? 'the site'} posts` }
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

/** Cuts the platform's related-posts list, its buttons and banners, and the size; keeps the post and replies. */
export function cleanPostText(t, site = 'threads') {
  const cfg = SITES[site] ?? SITES.threads
  let s = String(t ?? '')
  for (const m of cfg.related) {
    const i = s.indexOf(`\n${m}\n`)
    if (i >= 0) s = s.slice(0, i)
  }
  const { lines, starts } = cfg.noise
  if (lines.size || starts.length)
    s = s
      .split('\n')
      .filter((l) => {
        const v = l.trim()
        return !lines.has(v) && !starts.some((p) => v.startsWith(p))
      })
      .join('\n')
  s = s.replace(/[^\S\n]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() // trailing blanks, no-break spaces included
  return s.length > MAX_BROWSER_TEXT ? s.slice(0, MAX_BROWSER_TEXT) : s
}

/** What a successful read could and could not see, for the note's limits line. */
export const browserLimits = (site) => `read in a logged-out browser: ${(SITES[site] ?? SITES.threads).shows}; images and video were not read`

/** launch() options from BOT_BROWSER: '' or 'chrome' = installed Chrome; anything else = an executable path. */
export function launchOptions(env = process.env) {
  const v = String(env.BOT_BROWSER ?? '').trim()
  const args = ['--disable-extensions', '--disable-sync', '--no-first-run', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--dns-prefetch-disable']
  const base = { headless: true, args }
  return !v || v === 'chrome' ? { ...base, channel: 'chrome' } : { ...base, executablePath: v }
}

// One read at a time, at least gapMs apart (module-wide, whoever calls, whichever site).
let queue = Promise.resolve()
let lastEnd = 0

/**
 * Reads one Threads or Instagram post. Never throws: { ok, site, title, text, finalUrl, why }.
 * `load` returns the playwright-core module and `fetchImpl`/`lookup` resolve share links (tests pass fakes).
 */
export function readPostInBrowser(url, { env = process.env, gapMs = MIN_GAP_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), ...opts } = {}) {
  if (String(env.BOT_BROWSER ?? '').trim() === 'off') return Promise.resolve({ ok: false, why: 'browser reading is off (BOT_BROWSER=off)' })
  const site = siteOf(url)
  if (!isTarget(url, site)) return Promise.resolve({ ok: false, why: 'not a Threads or Instagram post link' })
  const run = queue.then(async () => {
    const wait = lastEnd + gapMs - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      return { site, ...(await readOnce(url, site, { env, ...opts })) }
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

async function readOnce(url, site, { env, load = () => import('playwright-core'), fetchImpl, lookup, timeoutMs = 30000 }) {
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
      const verdict = guardRequest({ site, url: q.url(), method: q.method(), resourceType: q.resourceType(), navigation: q.isNavigationRequest(), mainFrame })
      return verdict === 'continue' ? route.continue() : route.abort()
    })
    await ctx.routeWebSocket(/.*/, (ws) => ws.close())
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    const finalUrl = page.url()
    if (redirected || !isPost(finalUrl, site)) return { ok: false, finalUrl, why: 'the post redirected elsewhere (login page, removed or private): not read' }
    // The post renders after its scripts run; wait until the main region holds text, then a moment for replies.
    await page.waitForFunction(() => ((document.querySelector('[role="main"], main') || document.body)?.innerText?.length ?? 0) > 80, null, { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(1500)
    const raw = await page.evaluate(() => (document.querySelector('[role="main"], main') || document.body)?.innerText ?? '')
    const text = cleanPostText(raw, site)
    const title = String(await page.title()).trim()
    return text ? { ok: true, title, text, finalUrl } : { ok: false, finalUrl, why: 'the page showed no text' }
  } catch (e) {
    return { ok: false, why: `the browser could not read it: ${firstLine(e)}` }
  } finally {
    await browser.close().catch(() => {})
  }
}
