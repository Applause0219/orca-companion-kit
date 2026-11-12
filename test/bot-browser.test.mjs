import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BROWSER_TEXT, cleanPostText, guardRequest, isPost, isTarget, launchOptions, readPostInBrowser, resolvePostUrl } from '../src/bot/browser.mjs'
import { readLink } from '../src/bot/intake.mjs'

const POST = 'https://www.threads.com/@someone_tw/post/AbC123xyz'
const SHARE = 'https://www.threads.com/share/ShArE123x'
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }]
const redirectTo = (loc) => new Response(null, { status: 302, headers: { location: loc } })

// ---------- unit ----------
test('browser targets: only https Threads posts and share links', () => {
  for (const u of [POST, 'https://threads.net/@a.b_c/post/abc123/', 'https://www.threads.com/t/abc123', SHARE]) assert.ok(isTarget(u, 'threads'), u)
  for (const u of [
    'http://www.threads.com/@a/post/abc123', // not https
    'https://www.threads.com/@a', // a profile, not a post
    'https://www.threads.com/@a/post/abc123/media',
    'https://www.threads.com/direct/inbox',
    'https://www.instagram.com/p/abc123/',
    'https://threads.com.evil.example/@a/post/abc123', // look-alike host
    'https://threads.com@evil.example/@a/post/abc123', // userinfo trick
    'not a url'
  ])
    assert.equal(isTarget(u, 'threads'), false, u)
  assert.equal(isPost(SHARE, 'threads'), false, 'a share link is a start, not where the page may end')
  assert.ok(isPost(`${POST}?xmt=abc`, 'threads'), 'tracking query on the redirect target is fine')
})

test('request guard: GET only, two hosts only, no media, no messages/account paths, navigation only to the post', () => {
  const g = (o) => guardRequest({ site: 'threads', method: 'GET', resourceType: 'script', navigation: false, mainFrame: true, ...o })
  assert.equal(g({ url: 'https://static.cdninstagram.com/rsrc.php/x.js' }), 'continue')
  assert.equal(g({ url: 'https://www.threads.com/api/graphql', resourceType: 'xhr' }), 'continue')
  assert.equal(g({ url: 'https://www.threads.com/api/graphql', resourceType: 'xhr', method: 'POST' }), 'abort', 'nothing but GET: no like, reply or message can be sent')
  assert.equal(g({ url: 'https://www.threads.com/ajax/bz', resourceType: 'ping', method: 'POST' }), 'abort')
  assert.equal(g({ url: 'https://www.instagram.com/api/v1/web/data/', resourceType: 'fetch' }), 'abort', 'instagram.com is never contacted')
  assert.equal(g({ url: 'https://scontent.cdninstagram.com/a.jpg', resourceType: 'image' }), 'abort')
  assert.equal(g({ url: 'https://www.threads.com/x.mp4', resourceType: 'media' }), 'abort')
  assert.equal(g({ url: 'https://127.0.0.1/x', resourceType: 'fetch' }), 'abort')
  assert.equal(g({ url: 'http://www.threads.com/x.js' }), 'abort', 'https only')
  // Messages, account and settings paths are refused for scripts too, not only for page navigation.
  for (const p of ['/direct/inbox', '/direct', '/messages/t/1', '/accounts/edit', '/settings', '/notifications', '/api/v1/direct_v2/inbox/', '/api/v1/friendships/create/1/'])
    assert.equal(g({ url: `https://www.threads.com${p}`, resourceType: 'fetch' }), 'abort', p)
  assert.equal(g({ url: 'https://www.threads.com/directory-of-things.js' }), 'continue', 'only whole path segments match')
  assert.equal(g({ url: POST, resourceType: 'document', navigation: true }), 'continue')
  assert.equal(g({ url: SHARE, resourceType: 'document', navigation: true }), 'abort', 'share links are resolved before the browser starts')
  assert.equal(g({ url: 'https://www.threads.com/direct/inbox', resourceType: 'document', navigation: true }), 'abort', 'messages page refused')
  assert.equal(g({ url: 'https://www.threads.com/login', resourceType: 'document', navigation: true }), 'abort')
  assert.equal(g({ url: POST, resourceType: 'document', navigation: true, mainFrame: false }), 'abort', 'no frames, no popups')
})

test('post text: the related-posts list and the size limit are cut', () => {
  assert.equal(cleanPostText('串文\n作者\n內文   \n\n\n\n留言\n相關串文\n別人的貼文'), '串文\n作者\n內文\n\n留言')
  assert.equal(cleanPostText('post\nRelated threads\nother'), 'post')
  assert.equal(cleanPostText('x'.repeat(MAX_BROWSER_TEXT + 50)).length, MAX_BROWSER_TEXT)
})

test('launch options: installed Chrome by default, a path when given, always headless, no non-proxied WebRTC', () => {
  assert.deepEqual([launchOptions({}).channel, launchOptions({}).headless], ['chrome', true])
  assert.ok(launchOptions({}).args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'))
  const p = launchOptions({ BOT_BROWSER: '/opt/chromium/chrome' })
  assert.equal(p.executablePath, '/opt/chromium/chrome')
  assert.equal(p.channel, undefined)
})

test('share links: followed hop by hop; every hop must stay on Threads and be public; tracking query dropped', async () => {
  const hops = []
  const fetchImpl = async (u, o) => (hops.push([u, o.redirect]), redirectTo(`${POST}?xmt=TRACK`))
  assert.deepEqual(await resolvePostUrl(SHARE, { fetchImpl, lookup: publicLookup }), { ok: true, url: POST })
  assert.deepEqual(hops, [[SHARE, 'manual']], 'redirects are followed by this code, not by fetch')
  assert.deepEqual(await resolvePostUrl(POST, { fetchImpl: async () => assert.fail('a post needs no request') }), { ok: true, url: POST })

  const away = await resolvePostUrl(SHARE, { lookup: publicLookup, fetchImpl: async () => redirectTo('https://evil.example/@a/post/abc123') })
  assert.match(away.why, /outside Threads/)
  const login = await resolvePostUrl(SHARE, { lookup: publicLookup, fetchImpl: async () => redirectTo('https://www.threads.com/login') })
  assert.match(login.why, /outside Threads/)
  const loop = await resolvePostUrl(SHARE, { lookup: publicLookup, fetchImpl: async () => redirectTo(SHARE) })
  assert.match(loop.why, /too many/)
  const priv = await resolvePostUrl(SHARE, { lookup: async () => [{ address: '10.0.0.5', family: 4 }], fetchImpl: async () => assert.fail('not fetched') })
  assert.match(priv.why, /could not be followed/)
  const notRedirect = await resolvePostUrl(SHARE, { lookup: publicLookup, fetchImpl: async () => new Response('page', { status: 200 }) })
  assert.match(notRedirect.why, /did not lead to a post/)
})

// ---------- integration: a fake playwright-core ----------
/**
 * A fake browser that records every call. Any page method outside the reading set throws, so a click, a
 * fill or a keyboard press would fail the test.
 */
function fakePlaywright({ finalUrl = `${POST}`, text = '串文\n作者\n貼文內容\n留言一\n相關串文\n無關', gotoError, redirectOnGoto = false, onLaunch, onClose } = {}) {
  const calls = []
  const state = { route: null, closed: false, ws: false, listeners: {}, ctxListeners: {} }
  const mainFrame = { name: 'main' }
  const READING = new Set(['goto', 'url', 'waitForFunction', 'waitForTimeout', 'evaluate', 'title', 'on', 'mainFrame'])
  const page = new Proxy(
    {
      goto: async (u) => {
        calls.push(['goto', u])
        if (redirectOnGoto) state.listeners.request?.({ isNavigationRequest: () => true, redirectedFrom: () => ({}) })
        if (gotoError) throw new Error(gotoError)
      },
      url: () => finalUrl,
      on: (ev, fn) => (state.listeners[ev] = fn),
      mainFrame: () => mainFrame,
      waitForFunction: async () => {},
      waitForTimeout: async () => {},
      evaluate: async () => text,
      title: async () => 'someone_tw on Threads'
    },
    {
      get(t, k) {
        if (typeof k === 'string' && !READING.has(k) && k !== 'then') throw new Error(`page.${k} must never be used`)
        return t[k]
      }
    }
  )
  const ctx = {
    newPage: async () => (calls.push(['newPage']), page),
    on: (ev, fn) => (state.ctxListeners[ev] = fn),
    route: async (glob, fn) => ((state.route = fn), calls.push(['route', glob])),
    routeWebSocket: async () => ((state.ws = true), calls.push(['routeWebSocket']))
  }
  const browser = {
    newContext: async (o) => (calls.push(['newContext', o]), ctx),
    close: async () => {
      state.closed = true
      calls.push(['close'])
      onClose?.()
    }
  }
  const mod = { chromium: { launch: async (o) => (calls.push(['launch', o]), onLaunch?.(), browser) } }
  return { load: async () => mod, calls, state, mainFrame, page }
}
/** Runs one fake request through the guard the module installed. frame: 'main' | 'other' | 'throws'. */
const through = async (f, r) => {
  let verdict = ''
  const frame = () => {
    if (r.frame === 'throws') throw new Error('Frame is not available for this request')
    return r.frame === 'other' ? { name: 'popup' } : f.mainFrame
  }
  await f.state.route({
    request: () => ({ url: () => r.url, method: () => r.method ?? 'GET', resourceType: () => r.type ?? 'xhr', isNavigationRequest: () => !!r.nav, frame }),
    continue: async () => (verdict = 'continue'),
    abort: async () => (verdict = 'abort')
  })
  return verdict
}
const opts = (f, extra = {}) => ({ env: {}, load: f.load, gapMs: 0, lookup: publicLookup, fetchImpl: async () => redirectTo(POST), ...extra })

test('browser read: share resolved first; guard installed before the page opens; only reading calls; always closed', async () => {
  const f = fakePlaywright()
  const r = await readPostInBrowser(SHARE, opts(f))
  assert.equal(r.ok, true, r.why)
  assert.equal(r.text, '串文\n作者\n貼文內容\n留言一')
  assert.equal(r.title, 'someone_tw on Threads')
  assert.deepEqual(f.calls.find((c) => c[0] === 'goto'), ['goto', POST], 'the browser opens the resolved post, never the share link')
  const order = f.calls.map((c) => c[0])
  assert.ok(order.indexOf('route') < order.indexOf('goto'), 'the guard is in place before the first request')
  assert.ok(f.state.ws, 'websockets are refused')
  assert.equal(order.at(-1), 'close')
  const ctxOpts = f.calls.find((c) => c[0] === 'newContext')[1]
  assert.equal(ctxOpts.serviceWorkers, 'block')
  assert.equal(ctxOpts.storageState, undefined, 'fresh context: no saved login or cookies')
  // The installed handler is the guard: POST, instagram.com, a messages fetch, a frame or popup are aborted.
  assert.equal(await through(f, { url: 'https://www.threads.com/api/graphql', method: 'POST' }), 'abort')
  assert.equal(await through(f, { url: 'https://www.instagram.com/api/v1/x', type: 'fetch' }), 'abort')
  assert.equal(await through(f, { url: 'https://www.threads.com/api/v1/direct_v2/inbox/', type: 'fetch' }), 'abort')
  assert.equal(await through(f, { url: 'https://static.cdninstagram.com/a.js', type: 'script' }), 'continue')
  assert.equal(await through(f, { url: POST, type: 'document', nav: true }), 'continue')
  assert.equal(await through(f, { url: POST, type: 'document', nav: true, frame: 'other' }), 'abort', 'popup or iframe')
  assert.equal(await through(f, { url: POST, type: 'document', nav: true, frame: 'throws' }), 'abort', 'frame() throwing refuses instead of hanging')
})

test('browser read: popups are closed as soon as they open', async () => {
  const f = fakePlaywright()
  await readPostInBrowser(POST, opts(f))
  let closed = false
  f.state.ctxListeners.page({ close: async () => (closed = true) })
  assert.ok(closed)
})

test('browser read: a redirected navigation, a login page, a crash, "off" and a missing package all fail softly', async () => {
  const red = fakePlaywright({ redirectOnGoto: true })
  const a = await readPostInBrowser(POST, opts(red))
  assert.equal(a.ok, false)
  assert.match(a.why, /redirected elsewhere/)
  assert.ok(red.state.closed)

  const login = fakePlaywright({ finalUrl: 'https://www.threads.com/login?next=x' })
  assert.match((await readPostInBrowser(POST, opts(login))).why, /redirected elsewhere/)

  const crash = fakePlaywright({ gotoError: 'net::ERR_TIMED_OUT\nstack...' })
  const b = await readPostInBrowser(POST, opts(crash))
  assert.match(b.why, /could not read it: net::ERR_TIMED_OUT$/)
  assert.ok(crash.state.closed, 'closed after an error too')

  let loaded = false
  const c = await readPostInBrowser(POST, { env: { BOT_BROWSER: 'off' }, load: async () => ((loaded = true), {}) })
  assert.match(c.why, /off/)
  assert.equal(loaded, false, 'off means the package is never even loaded')

  const d = await readPostInBrowser(POST, { ...opts(fakePlaywright()), load: async () => Promise.reject(new Error('Cannot find package')) })
  assert.match(d.why, /not installed/)

  const e = await readPostInBrowser('https://example.com/@a/post/abc123', { env: {}, load: async () => assert.fail('not loaded for other sites') })
  assert.match(e.why, /not a Threads or Instagram post/)
})

test('browser read: one at a time, and the next read waits for the gap', async () => {
  const events = []
  let open = 0
  const mk = () =>
    fakePlaywright({
      onLaunch: () => {
        open++
        events.push(['launch', Date.now(), open])
      },
      onClose: () => {
        open--
        events.push(['close', Date.now()])
      }
    })
  await Promise.all([readPostInBrowser(POST, opts(mk(), { gapMs: 120 })), readPostInBrowser(POST, opts(mk(), { gapMs: 120 })), readPostInBrowser(POST, opts(mk(), { gapMs: 120 }))])
  assert.deepEqual(events.map((e) => e[0]), ['launch', 'close', 'launch', 'close', 'launch', 'close'])
  assert.ok(events.filter((e) => e[0] === 'launch').every((e) => e[2] === 1), 'never two browsers at once')
  for (let i = 1; i < events.length - 1; i += 2) assert.ok(events[i + 1][1] - events[i][1] >= 100, `gap after read ${(i + 1) / 2}`)
})

test('readLink: a Threads link is read in the browser first; the note says what was and was not read', async () => {
  const f = fakePlaywright()
  let fetched = 0
  const r = await readLink(POST, { env: {}, lookup: publicLookup, fetchImpl: async () => (fetched++, new Response('')), browserRead: (u, o) => readPostInBrowser(u, { ...o, load: f.load, gapMs: 0 }) })
  assert.equal(r.source, 'browser')
  assert.equal(r.ok, true)
  assert.match(r.text, /貼文內容/)
  assert.match(r.limits.join(' '), /logged-out browser.*images and video were not read/)
  assert.equal(fetched, 0, 'no second fetch when the browser read it')
})

test('readLink: a private address is refused before the browser starts', async () => {
  let started = false
  await assert.rejects(readLink(POST, { env: {}, lookup: async () => [{ address: '10.0.0.5', family: 4 }], browserRead: async () => ((started = true), { ok: true }) }))
  assert.equal(started, false)
})

// ---------- live: real Chrome against a real public post (manual: BOT_LIVE_THREADS_URL=<public post link> npm test) ----------
test('live: a public Threads post is read in logged-out Chrome with the guard on', { skip: !process.env.BOT_LIVE_THREADS_URL && 'set BOT_LIVE_THREADS_URL=<a public post link> to run against threads.com' }, async () => {
  const r = await readPostInBrowser(process.env.BOT_LIVE_THREADS_URL, { env: {} })
  assert.equal(r.ok, true, r.why)
  assert.ok(isPost(r.finalUrl, 'threads'))
  assert.ok(r.text.length > 200, `only ${r.text.length} characters`)
  assert.doesNotMatch(r.text, /相關串文|Related threads/)
})

// ---------- Instagram: same guard, its own hosts ----------
const IG = 'https://www.instagram.com/p/DfjebRHHSv3/'
const IG_SHARE = 'https://www.instagram.com/share/p/BAbc123xyz'

test('instagram targets: posts, reels and account-prefixed links; share links are a start only; sections are not accounts', () => {
  for (const u of [IG, `${IG}?img_index=5&rpxt=TRACK`, 'https://instagram.com/reel/DewedhKHZwS/', 'https://www.instagram.com/reels/DewedhKHZwS', 'https://www.instagram.com/tv/AbCdE12', 'https://www.instagram.com/jasonxtsai/p/DfjebRHHSv3/'])
    assert.ok(isPost(u, 'instagram'), u)
  for (const u of [IG_SHARE, 'https://www.instagram.com/share/reel/BAbc123xyz', 'https://www.instagram.com/share/BAbc123xyz']) {
    assert.ok(isTarget(u, 'instagram'), u)
    assert.equal(isPost(u, 'instagram'), false, `${u} is resolved before the browser opens anything`)
  }
  for (const u of [
    'http://www.instagram.com/p/DfjebRHHSv3/', // not https
    'https://www.instagram.com/jasonxtsai/', // a profile
    'https://www.instagram.com/direct/p/abcdef', // a messages path that looks like account + post
    'https://www.instagram.com/accounts/p/abcdef',
    'https://www.instagram.com/explore/p/abcdef',
    'https://www.instagram.com/stories/someone/123456/',
    'https://www.instagram.com/accounts/login/?next=/p/DfjebRHHSv3/',
    'https://scontent.cdninstagram.com/p/DfjebRHHSv3/',
    'https://instagram.com.evil.example/p/DfjebRHHSv3/',
    'https://www.instagram.com@evil.example/p/DfjebRHHSv3/'
  ])
    assert.equal(isTarget(u, 'instagram'), false, u)
  assert.equal(isTarget(IG, 'threads'), false, 'a site never accepts the other site’s links')
  assert.equal(isTarget(POST, 'instagram'), false)
})

test('instagram guard: GET only, instagram.com and its script CDN only, never threads; no messages/account paths', () => {
  const g = (o) => guardRequest({ site: 'instagram', method: 'GET', resourceType: 'script', navigation: false, mainFrame: true, ...o })
  assert.equal(g({ url: 'https://static.cdninstagram.com/rsrc.php/x.js' }), 'continue')
  assert.equal(g({ url: 'https://www.instagram.com/api/v1/web/data/', resourceType: 'fetch' }), 'continue')
  // Measured: a logged-out post page sends these; all refused and the caption still renders.
  for (const [method, url, type] of [
    ['POST', 'https://www.instagram.com/api/graphql', 'xhr'],
    ['POST', 'https://www.instagram.com/ajax/bz', 'xhr'],
    ['POST', 'https://www.instagram.com/ajax/bulk-route-definitions/', 'xhr'],
    ['GET', 'https://www.facebook.com/x', 'xhr'],
    ['GET', 'https://scontent.cdninstagram.com/a.jpg', 'image'],
    ['GET', 'https://instagram.ftpe15-1.fna.fbcdn.net/a.jpg', 'image']
  ])
    assert.equal(g({ method, url, resourceType: type }), 'abort', `${method} ${url}`)
  assert.equal(g({ url: 'https://www.threads.com/api/graphql', resourceType: 'xhr' }), 'abort', 'an Instagram read never reaches Threads')
  for (const p of ['/direct/inbox/', '/accounts/edit/', '/challenge/', '/api/v1/direct_v2/inbox/', '/api/v1/friendships/create/1/'])
    assert.equal(g({ url: `https://www.instagram.com${p}`, resourceType: 'fetch' }), 'abort', p)
  assert.equal(g({ url: IG, resourceType: 'document', navigation: true }), 'continue')
  assert.equal(g({ url: 'https://www.instagram.com/accounts/login/', resourceType: 'document', navigation: true }), 'abort', 'login page refused')
  assert.equal(g({ url: IG_SHARE, resourceType: 'document', navigation: true }), 'abort')
  assert.equal(g({ url: IG, site: 'nope' }), 'abort', 'an unknown site allows nothing')
})

test('instagram text: the sign-up banner and the like/reply buttons are dropped; caption and comments stay', () => {
  const raw = '絕不錯過jasonxtsai的任何貼文\n註冊 Instagram，隨時掌握最新消息。\n繼續操作即表示你同意 Instagram 的《使用條款》和《隱私政策》。\n註冊\n登入\njasonxtsai\n•\n追蹤\njasonxtsai\n \n1 天\n電腦卡到開個瀏覽器都要等。\n\n留言「檢查」。\namyflower_hk\n \n8分鐘\n檢查\n讚\n回覆'
  assert.equal(cleanPostText(raw, 'instagram'), 'jasonxtsai\njasonxtsai\n\n1 天\n電腦卡到開個瀏覽器都要等。\n\n留言「檢查」。\namyflower_hk\n\n8分鐘\n檢查')
  assert.equal(cleanPostText('讚\n回覆', 'threads'), '讚\n回覆', 'Threads text is left as it was')
  assert.equal(cleanPostText('a\n \nb', 'instagram'), 'a\n\nb', 'a line of only a no-break space is blank')
})

test('instagram share links: followed hop by hop; a hop to Threads or to the login page is refused', async () => {
  assert.deepEqual(await resolvePostUrl(IG_SHARE, { lookup: publicLookup, fetchImpl: async () => redirectTo(`${IG}?igsh=TRACK`) }), { ok: true, url: IG })
  const cross = await resolvePostUrl(IG_SHARE, { lookup: publicLookup, fetchImpl: async () => redirectTo(POST) })
  assert.match(cross.why, /outside Instagram/)
  const login = await resolvePostUrl(IG_SHARE, { lookup: publicLookup, fetchImpl: async () => redirectTo('https://www.instagram.com/accounts/login/') })
  assert.match(login.why, /outside Instagram/)
})

test('instagram browser read: opens the resolved post with the Instagram guard installed; a login redirect fails softly', async () => {
  const f = fakePlaywright({ finalUrl: IG, text: '絕不錯過a的任何貼文\n註冊\na\n說明文字\n讚\n回覆' })
  const r = await readPostInBrowser(IG_SHARE, opts(f, { fetchImpl: async () => redirectTo(IG) }))
  assert.equal(r.ok, true, r.why)
  assert.equal(r.site, 'instagram')
  assert.equal(r.text, 'a\n說明文字')
  assert.deepEqual(f.calls.find((c) => c[0] === 'goto'), ['goto', IG])
  assert.equal(await through(f, { url: 'https://static.cdninstagram.com/a.js', type: 'script' }), 'continue')
  assert.equal(await through(f, { url: 'https://www.instagram.com/api/graphql', method: 'POST' }), 'abort')
  assert.equal(await through(f, { url: 'https://www.threads.com/x.js', type: 'script' }), 'abort', 'the installed guard is the Instagram one')
  assert.equal(await through(f, { url: IG, type: 'document', nav: true }), 'continue')
  assert.ok(f.state.closed)

  const login = fakePlaywright({ finalUrl: 'https://www.instagram.com/accounts/login/?next=%2Fp%2FDfjebRHHSv3%2F' })
  const b = await readPostInBrowser(IG, opts(login))
  assert.equal(b.ok, false)
  assert.match(b.why, /redirected elsewhere/)
})

test('readLink: an Instagram image post is read in the browser first; yt-dlp is not run', async () => {
  const f = fakePlaywright({ finalUrl: IG, text: 'jasonxtsai\n電腦卡到開個瀏覽器都要等。' })
  let ytdlp = 0
  const r = await readLink(`${IG}?img_index=5`, { env: {}, lookup: publicLookup, fetchImpl: async () => assert.fail('no page fetch'), ytdlpExec: async () => (ytdlp++, { stdout: '' }), browserRead: (u, o) => readPostInBrowser(u, { ...o, load: f.load, gapMs: 0 }) })
  assert.equal(r.source, 'browser')
  assert.equal(r.ok, true)
  assert.match(r.text, /電腦卡到/)
  assert.match(r.limits.join(' '), /caption and the comments.*images and video were not read/)
  assert.equal(ytdlp, 0)
})

test('readLink: when the browser cannot read an Instagram link, yt-dlp is tried next and the reason is kept', async () => {
  const ytdlpExec = async () => ({ stdout: JSON.stringify({ title: 'Reel title', description: 'caption text', uploader: 'harryleeai' }) })
  const r = await readLink('https://www.instagram.com/reel/DewedhKHZwS/', { env: { BOT_YTDLP: 'yt-dlp' }, lookup: publicLookup, ytdlpExec, browserRead: async () => ({ ok: false, why: 'browser reading is off (BOT_BROWSER=off)' }) })
  assert.equal(r.source, 'yt-dlp')
  assert.match(r.text, /caption text/)
  assert.match(r.limits[0], /^browser: browser reading is off/)
})

// ---------- live: real Chrome against a real public Instagram post (manual) ----------
test('live: a public Instagram post is read in logged-out Chrome with the guard on', { skip: !process.env.BOT_LIVE_INSTAGRAM_URL && 'set BOT_LIVE_INSTAGRAM_URL=<a public post link> to run against instagram.com' }, async () => {
  const r = await readPostInBrowser(process.env.BOT_LIVE_INSTAGRAM_URL, { env: {} })
  assert.equal(r.ok, true, r.why)
  assert.ok(isPost(r.finalUrl, 'instagram'))
  assert.ok(r.text.length > 80, `only ${r.text.length} characters`)
  assert.doesNotMatch(r.text, /註冊 Instagram|^讚$/m)
})
