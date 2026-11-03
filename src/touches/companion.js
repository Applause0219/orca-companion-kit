// companion.js: a reusable desktop pet for Orca. A character file calls
//   window.__orcaThemer.registerCompanion({ id, label, svg, parts, words, acts, ... })
// and gets a pet that can be dragged and thrown, resized with the wheel, follows you on double-click
// (right-click stops it), looks at your pointer, sways while you type, has moods, idles without repeating
// itself, startles, welcomes you back, watches Orca's agent tabs, reacts to the line you send, likes
// being petted, says a short line now and then, remembers the days you spent together, and has feelings that
// last (mood, affection, closeness; companion_emotion.js) with a sulk when they sink too low. Opt-in extras:
// hide-and-seek behind the window's edges, git commit/push reactions, being caught in the act when you
// come back, a nuzzle when the pointer rests on it, reading along on Markdown tabs, an evening lantern,
// and singing your own audio file on a word. Full reference: docs/companion-api.md.
//
// Rules this file keeps (and character files should too):
// - Motion is WAAPI on transform/opacity only; one rAF loop runs only while thrown or following.
// - Per-keystroke work is throttled (150 ms) and never reads layout or canvas pixels.
// - IME: Windows IMEs send keydown only for the first composing key, so typing also listens to compositionupdate.
// - Never binds Esc: in a terminal Esc interrupts Claude Code and other agents. Right-click ends follow mode.
// - The typed line lives only in memory and is dropped on Enter. Nothing is stored or sent anywhere.
// - Every listener, timer, observer and element is removed in stop().
// The runtime does not start touches at all under prefers-reduced-motion.
;(() => {
  const T = window.__orcaThemer
  if (!T) return

  const LAYER_ID = 'oc-companion-layer'
  function layer() {
    let el = document.getElementById(LAYER_ID)
    if (!el) {
      el = document.createElement('div')
      el.id = LAYER_ID
      el.setAttribute('aria-hidden', 'true')
      el.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147482000;overflow:hidden'
      document.body.appendChild(el)
    }
    return el
  }

  // Lifts the named parts (direct children of the <svg>) into HTML boxes of their own, in drawing order; see
  // the note at its call. Returns the figure (replacing the svg in its parent), or null when nothing lifts.
  // Each box's pivot is the part's bounding box times the part's transform-origin ('right center',
  // '50% 100%'...), in screen px. P's entries for lifted parts become the boxes.
  function liftParts(svg, P, names, BOX) {
    const lifted = new Map() // element → part name
    for (const name of names) for (const el of P[name] ?? []) if (el.parentNode === svg) lifted.set(el, name)
    if (!lifted.size) return null
    const vb = svg.viewBox.baseVal
    const kx = BOX / (vb.width || 120)
    const ky = BOX / (vb.height || 120)
    const figure = document.createElement('div')
    figure.style.cssText = `position:absolute;left:0;top:0;width:${BOX}px;height:${BOX}px;filter:${svg.style.filter || 'none'}`
    const sheet = () => {
      const s = svg.cloneNode(false)
      s.removeAttribute('id')
      s.style.cssText = 'position:absolute;left:0;top:0;overflow:visible'
      return s
    }
    // One transform-origin token as a fraction of the part's box (a bare number is in viewBox units).
    const frac = (tok, extent) => {
      if (tok === 'left' || tok === 'top') return 0
      if (tok === 'right' || tok === 'bottom') return 1
      if (tok === 'center') return 0.5
      const n = parseFloat(tok)
      return Number.isNaN(n) ? 0.5 : tok.endsWith('%') ? n / 100 : extent ? n / extent : 0.5
    }
    const pivot = (el, box) => {
      let [a = 'center', b = 'center'] = (el.style.transformOrigin || 'center').trim().split(/\s+/)
      if (a === 'top' || a === 'bottom' || b === 'left' || b === 'right') [a, b] = [b, a]
      let r
      try {
        r = el.getBBox()
      } catch {
        r = { x: vb.x, y: vb.y, width: vb.width, height: vb.height }
      }
      box.style.transformOrigin = `${((r.x - vb.x + frac(a, r.width) * r.width) * kx).toFixed(2)}px ${((r.y - vb.y + frac(b, r.height) * r.height) * ky).toFixed(2)}px`
    }
    let current = null
    for (const child of [...svg.children]) {
      const name = lifted.get(child)
      if (name) {
        const box = document.createElement('div')
        box.style.cssText = `position:absolute;left:0;top:0;width:${BOX}px;height:${BOX}px`
        pivot(child, box)
        child.style.transformBox = ''
        child.style.transformOrigin = ''
        box.appendChild(sheet()).appendChild(child)
        figure.appendChild(box)
        P[name][P[name].indexOf(child)] = box
        current = null
      } else {
        current ??= figure.appendChild(sheet())
        current.appendChild(child)
      }
    }
    svg.replaceWith(figure)
    return figure
  }

  const DEFAULT_COLORS = {
    sparkle: '#fff7e0',
    heart: '#f5b8cf',
    note: '#e6ebff',
    alert: '#f3d48e',
    calm: '#dfe6ff',
    dim: '#b9c0dc',
    trail: '#fff7e0'
  }
  // Short sine chimes made in the page; no sound files. Frequencies in Hz.
  const DEFAULT_SOUNDS = { gain: 1, pet: [1318.5, 1760], welcome: [1046.5, 1318.5, 1568], follow: [1108.7, 1318.5], star: [1760] }
  const DEFAULT_ORIGIN = { ears: 'center bottom', flutter: 'center', eyes: 'center', happyEyes: 'center', sleepEyes: 'center' }

  // Checked in order after the character's own words. "沒有 bug" is good news, so it comes before "bug".
  const DEFAULT_WORDS = [
    { re: /(沒有?|不是|沒|no|not an?)\s*(bug|錯誤?|問題|error|壞)|完成|搞定|成功|好耶|太棒|超棒|讚|\b(done|yay|nice|lgtm|fixed|works)\b/i, react: 'goodNews' },
    { re: /謝謝|感謝|\b(thanks?|thx|ty)\b/i, react: 'thanks' },
    { re: /晚安|好睏|好累|想睡|\b(good ?night|sleepy|tired)\b/i, react: 'sleepy' },
    // Before `curious`, so "可以唱歌嗎？" sings instead of tilting its head.
    { re: /唱歌|唱首歌|搖籃曲|\b(sing|lullaby)\b/i, react: 'sing' },
    { re: /bug|錯誤|壞了|失敗|卡住|\b(error|fail(ed)?|broken|crash)/i, react: 'worried' },
    { re: /[?？]\s*$|為什麼|怎麼|\b(why|how)\b/i, react: 'curious' }
  ]

  let audio = null
  function chime(freqs, gain = 0.06, gap = 0.12) {
    try {
      audio ??= new AudioContext()
      const now = audio.currentTime
      freqs.forEach((freq, i) => {
        const t0 = now + i * gap
        for (const [ratio, amp, decay] of [[1, 1, 1], [2, 0.3, 1.6], [2.76, 0.18, 2.3]]) {
          const osc = audio.createOscillator()
          const env = audio.createGain()
          osc.frequency.value = freq * ratio
          env.gain.setValueAtTime(0, t0)
          env.gain.linearRampToValueAtTime(gain * amp, t0 + 0.005)
          env.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.8 / decay)
          osc.connect(env).connect(audio.destination)
          osc.start(t0)
          osc.stop(t0 + 1.9)
        }
      })
    } catch {}
  }

  const isTerminal = (t) => t instanceof HTMLTextAreaElement && t.classList.contains('xterm-helper-textarea')
  const t = (x, y, deg = 0, sx = 1, sy = sx) => ({ transform: `translate(${x}px,${y}px) rotate(${deg}deg) scale(${sx},${sy})` })
  const at = (frames, offsets) => frames.map((k, i) => ({ ...k, offset: offsets[i] }))
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  T.companions ??= new Map()

  // Opens an Orca tab the way a real click does. Orca switches tabs on pointerdown (the tab strip is
  // sortable), so a bare el.click() leaves you where you were.
  function openTab(tab) {
    if (!tab?.isConnected) return false
    const r = tab.getBoundingClientRect()
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true }
    tab.dispatchEvent(new PointerEvent('pointerdown', o))
    tab.dispatchEvent(new MouseEvent('mousedown', o))
    tab.dispatchEvent(new PointerEvent('pointerup', { ...o, buttons: 0 }))
    tab.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }))
    tab.click()
    return true
  }

  // Orca keeps the tab strip of every worktree it has shown mounted, but lays out only the one in front:
  // another worktree's tabs are in the DOM with a zero-size box, and clicking them does nothing.
  const TAB = '[data-testid="sortable-tab"]'
  const shown = (el) => !!el?.isConnected && el.getBoundingClientRect().width > 0
  const tabById = (id) => (id ? document.querySelector(`${TAB}[data-tab-id="${CSS.escape(id)}"]`) : null)
  // The tab in front: every mounted worktree has an active tab, the one that counts is laid out.
  const frontTab = () => {
    const all = document.querySelectorAll(`${TAB}[data-active="true"]`)
    return [...all].find(shown) ?? all[0] ?? null
  }
  // Orca's own store (zustand): which worktree a tab belongs to, and bringing that worktree to the front.
  // Found by shape, not by its minified export name; null when this Orca build has none. Only Orca's own
  // bundle is imported: a modulepreload of assets/store-<8-char hash>.js next to the page (Orca loads from
  // file://, whose origin is opaque, so the check is the page's own assets folder and protocol).
  let orcaStore = null
  let storeLoad = null
  const STORE_FILE = /^store-[\w-]{8}\.js$/
  const storeUrl = () => {
    const assets = new URL('assets/', location.href)
    for (const el of document.querySelectorAll('link[rel="modulepreload"][href]')) {
      let u
      try {
        u = new URL(el.getAttribute('href'), location.href)
      } catch {
        continue
      }
      if (u.protocol !== location.protocol || u.origin !== assets.origin || u.search || u.hash) continue
      const name = u.pathname.slice(assets.pathname.length)
      if (u.pathname.startsWith(assets.pathname) && STORE_FILE.test(name)) return u.href
    }
    return null
  }
  const loadStore = () =>
    (storeLoad ??= (async () => {
      const u = storeUrl()
      if (!u) return null
      const mod = await import(u)
      orcaStore = Object.values(mod).find((v) => typeof v?.getState === 'function' && typeof v.getState().setActiveWorktree === 'function') ?? null
      return orcaStore
    })().catch(() => null))
  const worktreeOfTab = (id) => {
    const s = orcaStore?.getState()
    if (!s || !id) return null
    for (const map of [s.unifiedTabsByWorktree, s.tabsByWorktree]) for (const [wt, tabs] of Object.entries(map ?? {})) if (Array.isArray(tabs) && tabs.some((x) => x?.id === id || x?.entityId === id)) return wt
    return null
  }
  // Where a tab of a worktree not in front is: its worktree's row in the sidebar (or its project's).
  const worktreeRow = (wt) => {
    if (!wt) return null
    const dec = (e) => {
      try {
        return decodeURIComponent(e.id)
      } catch {
        return e.id
      }
    }
    const rows = [...document.querySelectorAll('[id^="worktree-list-option-"]')].filter(shown)
    const repo = wt.split('::')[0]
    return rows.find((e) => dec(e).includes(wt)) ?? rows.find((e) => e.getAttribute('data-repo-header-id') === repo) ?? null
  }
  // The box to fly to for a tab: the tab itself when it is laid out, else its worktree's sidebar row.
  const tabRect = (tab) => {
    if (shown(tab)) return tab.getBoundingClientRect()
    const row = worktreeRow(worktreeOfTab(tab?.getAttribute('data-tab-id'))) ?? document.querySelector('.bg-worktree-sidebar[data-os-file-drop-owner]')
    return row?.getBoundingClientRect() ?? tab.getBoundingClientRect()
  }
  // Opens a tab wherever it is: its worktree comes to the front first. 'open' once it is in front, 'gone'
  // when no worktree has it any more, 'stuck' when it did not come up in time.
  async function goToTab(id) {
    let el = tabById(id)
    if (!shown(el)) {
      await loadStore()
      const wt = worktreeOfTab(id)
      if (orcaStore && !wt && !el) return 'gone'
      const s = orcaStore?.getState()
      if (s && wt && s.activeWorktreeId !== wt) s.setActiveWorktree(wt)
      for (let i = 0; i < 40 && !shown((el = tabById(id))); i++) await wait(100)
    }
    if (!shown(el)) return el || orcaStore ? 'stuck' : 'gone'
    openTab(el)
    return 'open'
  }

  // ---------- pure rules (no DOM), exposed as T.companionRules so tests can walk them ----------
  // Hide-and-seek: a spot is a point on the edge of something on screen plus `dir`, the way the pet peeks
  // out; the thing hiding it lies on the other side of that line. Rects are plain {left, top, right,
  // bottom} measured once when it hides. `rand` is injectable so tests are repeatable.
  const SEEK = (() => {
    const OUT = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
    const ROT = { up: 0, right: 90, down: 180, left: -90 }
    const WEIGHT = { toast: 3, tabs: 2, status: 2, sidebar: 2, files: 2, divider: 2, pane: 2, window: 1 }
    const ok = (r) => r && r.right - r.left > 0 && r.bottom - r.top > 0
    // A point along [a, b], kept `m` px away from both ends; null when the stretch is too short.
    const along = (a, b, m, rand) => (b - a < m * 2 + 24 ? null : a + m + rand() * (b - a - m * 2))
    function spots(r, view, rand = Math.random) {
      const out = []
      const add = (name, x, y, dir) => x != null && y != null && out.push({ name, x: Math.round(x), y: Math.round(y), dir })
      const H = (name, rect, y, dir, m = 40) => ok(rect) && add(name, along(rect.left, rect.right, m, rand), y, dir)
      const V = (name, rect, x, dir, m = 50) => ok(rect) && add(name, x, along(rect.top, rect.bottom, m, rand), dir)
      if (ok(r.tabs)) H('tabs', r.tabs, r.tabs.bottom, 'down')
      if (ok(r.sidebar) && r.sidebar.right - r.sidebar.left > 140) V('sidebar', r.sidebar, r.sidebar.right, 'right', 70)
      if (ok(r.files) && r.files.right - r.files.left > 120) V('files', r.files, r.files.left, 'left', 70)
      if (ok(r.status)) H('status', r.status, r.status.top, 'up', 60)
      for (const p of (r.panes || []).filter(ok).slice(0, 4)) {
        if (p.right - p.left < 160 || p.bottom - p.top < 120) continue
        if (rand() < 0.5) add('pane', p.right - 40, p.bottom, 'up')
        else add('pane', p.left + 40, p.top, 'down')
      }
      for (const d of (r.dividers || []).filter((d) => ok(d.rect)).slice(0, 4)) {
        const { rect, vertical } = d
        if (vertical) V('divider', rect, (rect.left + rect.right) / 2, rand() < 0.5 ? 'left' : 'right')
        else H('divider', rect, (rect.top + rect.bottom) / 2, rand() < 0.5 ? 'up' : 'down')
      }
      for (const t of (r.toasts || []).filter(ok).slice(0, 2)) H('toast', { left: t.left, top: t.top, bottom: t.bottom, right: Math.min(t.right, t.left + 120) }, t.top, 'up', 30) // not {...t}: a DOMRect's fields are getters
      const all = { left: 0, top: 0, right: view.w, bottom: view.h }
      H('window', all, view.h, 'up', 80)
      H('window', all, 0, 'down', 80)
      V('window', all, 0, 'right', 80)
      V('window', all, view.w, 'left', 80)
      return out
    }
    const near = (s, p, d) => p && Math.hypot(s.x - p.x, s.y - p.y) < d
    const inside = (s, r, pad) => s.x > r.left - pad && s.x < r.right + pad && s.y > r.top - pad && s.y < r.bottom + pad
    // What shows of the pet (about box × box/2 outward of the line) has to stay on screen.
    const fits = (s, view, box) => {
      const [nx, ny] = OUT[s.dir]
      const ox = s.x + nx * box * 0.6
      const oy = s.y + ny * box * 0.6
      const half = box / 2
      return s.x >= 0 && s.x <= view.w && s.y >= 0 && s.y <= view.h && ox >= 0 && ox <= view.w && oy >= 0 && oy <= view.h && (ny ? s.x >= half && s.x <= view.w - half : s.y >= half && s.y <= view.h - half)
    }
    // Picks one spot: not under the pointer, not on what you are typing into, not right where it was.
    // `want` (a spot name) narrows the pick when such a spot exists. Rules relax step by step, so there is
    // always an answer while the window has any size at all.
    function pick(cands, { view, box = 64, pointer = null, from = null, avoid = [], want = null, rand = Math.random } = {}) {
      const onScreen = cands.filter((s) => OUT[s.dir] && fits(s, view, box))
      const safe = onScreen.filter((s) => !near(s, pointer, 160) && !avoid.some((r) => inside(s, r, 90)))
      const steps = [safe.filter((s) => !near(s, from, 220)), safe, onScreen.filter((s) => !near(s, pointer, 160)), onScreen]
      const only = want && onScreen.some((s) => s.name === want)
      for (const pool of steps) {
        const list = only ? pool.filter((s) => s.name === want) : pool
        if (!list.length) continue
        let r = rand() * list.reduce((a, s) => a + (WEIGHT[s.name] || 1), 0)
        for (const s of list) if ((r -= WEIGHT[s.name] || 1) <= 0) return s
        return list[list.length - 1]
      }
      return null
    }
    return { OUT, ROT, spots, pick }
  })()
  // A sent git line: the last `git commit` / `git push` in a chain counts ("git add . && git commit -m x").
  // Quoted strings are dropped first, so `git commit -m "git push"` is a commit and `echo "git push"` is
  // nothing. Only the typed line is read, never terminal output; a dry run or help does not count.
  const GIT_RE = /(?:^\s*|[;&|]+\s*)git\s+(?:(?:-[cC]\s+\S+|--[\w-]+(?:=\S+)?)\s+)*(commit|push)\b/g
  function gitMoment(line) {
    const bare = String(line ?? '').replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
    if (/--dry-run\b|(?:^|\s)(?:-h|--help)(?:\s|$)/.test(bare)) return null
    let kind = null
    for (const m of bare.matchAll(GIT_RE)) kind = m[1]
    return kind
  }
  // Tabs worth reading along with: Markdown files and READMEs.
  const isReadable = (title) => /\.(md|markdown|mdx)$/i.test(String(title ?? '').trim()) || /^readme(\.|$)/i.test(String(title ?? '').trim())
  // The lantern follows the evening (`from` o'clock until the `until` o'clock day roll): light it once per
  // day, keep it lit after a reload, put it out in the morning. `lit` is the day key it was last lit on.
  function lanternPhase({ hour, day, lit, from = 18, until = 5 }) {
    const evening = hour >= from || hour < until
    if (!evening) return 'out'
    return lit === day ? 'keep' : 'light'
  }
  // Missing pieces in someone's pet (a word naming an act that is not there, an --asset-* sound that is
  // not in the folder): `resolve` falls back to 'idle', and `once` says so the first time only, so a typo
  // shows up once in the console instead of on every keystroke.
  const missing = {
    resolve: (name, has) => (typeof name === 'string' && name && has(name) ? name : 'idle'),
    once: (seen = new Set()) => (kind, name) => {
      const key = `${kind}:${name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }
  }
  // Dev aid (settings row debugState, off by default; docs/states.md): the current `mode` over its head
  // and one console.debug line per change, "old→new（why）". `isOn()` is read at every call; while it is
  // off nothing is made and nothing is logged. `make()` builds the label (the engine's DOM), `log` writes.
  function stateTrace(isOn, { make, log }) {
    let tag = null
    const drop = () => {
      tag?.remove()
      tag = null
    }
    const show = (now) => ((tag ??= make()).textContent = now)
    return {
      change(from, to, why) {
        if (from === to) return
        if (!isOn()) return drop()
        log(`${from}→${to}（${why}）`)
        show(to)
      },
      // The switch may flip between changes: the label comes or goes at once.
      sync(now) {
        if (isOn()) show(now)
        else drop()
      },
      stop: drop
    }
  }
  T.companionRules = { seek: SEEK, gitMoment, isReadable, lanternPhase, defaultWords: DEFAULT_WORDS, openTab, frontTab, goToTab, missing, stateTrace }

  // ---------- settings: the catalog the settings panel is drawn from, and the pure helpers ----------
  // Each pet's settings are one object, saved by the launcher as settings.json "companions"[<pet id>]
  // (only what differs from that pet's defaults) and handed to the page as T.state.companions[<pet id>].
  // The engine reads it at every trigger point (memoized); companion_settings.js draws the panel from
  // the same catalog. A pet adds rows of its own with `behaviors` (docs/companion-api.md「設定面板」).
  const CONFIG = (() => {
    const VERSION = 1
    // How often a random or timed behaviour happens: a multiplier.
    const FREQ_STEPS = [
      [0.25, '很少'],
      [0.5, '少'],
      [1, '平常'],
      [2, '常常']
    ]
    // kind: 'feature' (on/off; freq: true adds how-often), 'freq', 'number', 'quiet', 'range', 'name',
    // 'size', 'home', 'stats', 'forget', 'resetAll'. `on(pet)` is a feature's default (built-in behaviours
    // are on; the opt-in ones follow the pet's own config). `shows(pet)` drops a row the pet cannot do
    // (no lines, no sounds). `preview: false` hides the 「試試看」 button.
    const f = (id, label, desc, extra = {}) => ({ kind: 'feature', id, label, desc, ...extra })
    const optIn = (key) => (pet) => Boolean(pet.cfg[key])
    const SECTIONS = [
      {
        // How it feels (companion_emotion.js): drawn by the panel's 'heart' row, words only (Alt shows numbers).
        id: 'heart',
        label: '心情',
        intro: '牠現在的心情、對你的好感，和你們有多親近。',
        items: [
          { kind: 'heart', id: 'heart', label: '現在', shows: (pet) => Boolean(pet.emotion) },
          f('sulk', '鬧彆扭', '心情跌到谷底時（一天最多一次），牠會躲到角落背對你；來回摸牠三下就和好。', { shows: (pet) => Boolean(pet.emotion) })
        ]
      },
      {
        id: 'touch',
        label: '互動',
        intro: '摸牠、抓牠、跟牠玩的方式。',
        items: [
          f('gaze', '看你的游標', '游標靠近時，牠的眼睛和身體會轉過去。'),
          f('pet', '摸摸', '游標在牠身上來回移動幾下，牠會開心地冒愛心。'),
          f('nuzzle', '蹭蹭', '游標停在牠身上不動，牠會靠過來蹭你。', { on: optIn('nuzzle') }),
          f('seek', '捉迷藏', '點牠一下，牠會躲到視窗某個邊緣後面偷看你，點到就找到了。', { on: (pet) => Boolean(pet.cfg.hideAndSeek) && pet.cfg.hideAndSeek?.click !== false }),
          f('drag', '拖曳搬家', '按住拖到別處、慢慢放下，那裡就是牠的新家。'),
          f('throw', '甩出去', '拖著用力一甩，牠會飛出去撞牆反彈，再飄回家。'),
          f('wheel', '滾輪縮放', '游標放在牠身上滾滾輪，可以放大或縮小。'),
          f('follow', '跟著你', '雙擊牠，牠就一路跟著游標走；按右鍵停下。'),
          f('startle', '被嚇一跳', '游標從牠身邊快速掠過，牠會嚇一跳。')
        ]
      },
      {
        id: 'typing',
        label: '打字',
        intro: '你在終端機打字時，牠的反應。',
        items: [
          f('sway', '跟著打字晃', '你打字時，牠跟著節奏左右晃。'),
          f('comboGlow', '連擊光暈', '連續打字時，身後的光越來越亮，每 50 下轉一圈。', { shows: (pet) => pet.glow }),
          f('words', '聽得懂的話', '送出的那一行有牠認得的詞（完成、謝謝、bug、問句、牠的名字），牠會回應。'),
          f('puzzled', '一直刪字', '短時間按很多下退格，牠會歪頭看你。'),
          f('sing', '唱歌', '送出「唱歌」或 sing，牠就唱給你聽。'),
          f('gitCommit', 'commit 蓋章', '送出 git commit，牠在旁邊蓋一個印章。', { on: optIn('git') }),
          f('gitPush', 'push 紙飛機', '送出 git push，牠折一架紙飛機扔出去。', { on: optIn('git') })
        ]
      },
      {
        id: 'daily',
        label: '日常',
        intro: '沒事的時候，牠自己找事做。',
        items: [
          f('idle', '閒著的小動作', '每隔一陣子做點小事，不會連兩次一樣。', { freq: true }),
          f('wander', '到處晃晃', '偶爾出去走一小段，看看四周再回家。', { freq: true, shows: (pet) => pet.acts.has('wander') }),
          f('mood', '心情符號', '最近發生的事會影響牠，頭上偶爾冒出心情符號。'),
          f('sleep', '睡覺', '一陣子沒動靜就睡著。頻率調高，牠更快睡著。', { freq: true }),
          f('blink', '眨眼', '每隔幾秒眨一下眼睛。', { on: (pet) => pet.cfg.blink !== false, shows: (pet) => pet.parts.has('eyes') }),
          f('toast', '通知時轉圈', 'Orca 跳出通知時，牠開心地轉一圈。'),
          f('read', '陪你讀文件', '使用中的分頁是 Markdown 或 README 時，牠偶爾湊過去一起讀。', { freq: true, on: optIn('readAlong') }),
          f('lantern', '傍晚點燈', '每天傍晚點一盞小燈籠陪你一整晚，早上吹熄。', { on: optIn('lantern') })
        ]
      },
      {
        id: 'welcome',
        label: '迎接',
        intro: '你離開又回來的時候。',
        items: [
          f('welcome', '歡迎回來', '離開一陣子再回來，牠會跳起來歡迎你。'),
          f('caught', '被抓包', '回來時偶爾撞見牠在偷玩，嚇一跳、臉紅、假裝沒事。', { freq: true, on: optIn('caught') }),
          f('greet', '每天打招呼', '每天第一次見面，依時段打招呼。'),
          f('milestones', '紀念日', '一起滿 7、30、100 天這些日子，牠會慶祝。'),
          f('late', '比平常晚', '比你平常的時間晚很多還在用，牠會擔心你。', { shows: (pet) => pet.speaks })
        ]
      },
      {
        id: 'agent',
        label: 'Agent',
        intro: 'Agent 工作時，牠在做什麼。',
        items: [
          f('vigil', '陪著工作', 'Agent 工作時，牠身後的光慢慢呼吸。', { shows: (pet) => pet.glow }),
          f('knock', '敲門', '有分頁在等你授權，牠飛過去敲一敲；點牠就切過去。', { on: (pet) => pet.cfg.visitTabs !== false }),
          f('done', '做完時轉圈', 'Agent 做完，牠轉一圈。'),
          f('droop', '出錯時垂頭', 'Agent 出錯，牠垂頭喪氣一下，再振作起來。')
        ]
      },
      {
        id: 'speech',
        label: '說話',
        intro: '頭上冒出的那一句話。',
        items: [
          f('speech', '讓牠說話', '頭上偶爾冒出一句話。關掉就一句都不說。', { shows: (pet) => pet.speaks }),
          { kind: 'freq', id: 'talk', label: '話多話少', desc: '沒事找你聊天的機會有多少。', dependsOn: 'speech', shows: (pet) => pet.speaks },
          { kind: 'number', id: 'dailyCap', path: 'speech.dailyCap', label: '一天最多幾句', desc: '說滿了就等到明天。', unit: '句', min: 0, max: 60, step: 1, dependsOn: 'speech', shows: (pet) => pet.speaks },
          { kind: 'quiet', id: 'quiet', label: '安靜時段', desc: '這段時間不說話、不出聲，動作照常。', shows: (pet) => pet.speaks || pet.sounds }
        ]
      },
      {
        id: 'sound',
        label: '聲音',
        intro: '牠的小鈴聲，和唱歌時放的音檔。安靜時段也會讓它們停下。',
        items: [
          f('sound', '讓牠出聲', '鈴聲和唱歌音檔的總開關。', { shows: (pet) => pet.sounds }),
          { kind: 'range', id: 'chime', path: 'sound.chime', label: '鈴聲大小', desc: '摸摸、歡迎、蓋章時那些小鈴聲。', min: 0, max: 2, step: 0.05, percent: true, dependsOn: 'sound', shows: (pet) => pet.sounds },
          { kind: 'range', id: 'song', path: 'sound.song', label: '唱歌音量', desc: '唱歌時放你的音檔，開頭淡入、結尾淡出到這個大小。', min: 0, max: 1, step: 0.05, percent: true, dependsOn: 'sound', shows: (pet) => pet.sounds && pet.song }
        ]
      },
      {
        id: 'you',
        label: '你和牠',
        intro: '牠怎麼叫你、記得什麼。',
        items: [
          { kind: 'name', id: 'name', label: '怎麼叫你', desc: '打招呼和歡迎你回來時，會叫你的名字。', shows: (pet) => pet.speaks },
          { kind: 'size', id: 'size', label: '大小', desc: '也可以把游標放在牠身上滾滾輪。' },
          { kind: 'home', id: 'home', label: '回到原位', desc: '送牠回預設的位置，拖過的新家不算了。' },
          { kind: 'stats', id: 'stats', label: '你們的回憶' },
          { kind: 'forget', id: 'forget', label: '忘掉回憶', desc: '一起的天數、摸摸次數、紀念日都歸零，從頭認識你。設定會留著。' },
          { kind: 'resetAll', id: 'resetAll', label: '設定全部恢復預設', desc: '開關、頻率、聲音都回到原本的樣子，回憶不受影響。' },
          f('debugState', '開發：顯示狀態', '在牠頭上顯示現在的狀態（home、asleep、flying……），每次轉換在主控台記一行「舊→新（原因）」。抓狀態亂跳的問題用。', { on: () => false, preview: false })
        ]
      }
    ]
    const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
    const shown = (item, pet) => {
      try {
        return item.shows?.(pet) ?? true
      } catch {
        return false
      }
    }

    /**
     * The panel of one pet: the built-in sections with the rows this pet can do, plus its own `behaviors`
     * (one with a built-in id renames, hides or re-previews that row instead). A hidden row stays in the
     * catalog with `hidden: true`, so its default still holds; the panel just does not draw it. `pet`
     * describes the pet without the DOM: { cfg, acts: Set, parts: Set, speaks, sounds, song, songVolume, glow }.
     */
    function catalog(pet) {
      const sections = SECTIONS.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i })) }))
      for (const extra of [].concat(pet.cfg.sections ?? [])) {
        if (!isObj(extra) || typeof extra.id !== 'string' || sections.some((s) => s.id === extra.id)) continue
        sections.splice(sections.length - 1, 0, { id: extra.id, label: String(extra.label ?? extra.id), intro: String(extra.intro ?? ''), items: [] })
      }
      for (const b of [].concat(pet.cfg.behaviors ?? [])) {
        if (!isObj(b) || typeof b.id !== 'string' || !/^[\w-]{1,40}$/.test(b.id)) continue
        const same = sections.flatMap((s) => s.items).find((i) => i.id === b.id)
        if (same) {
          for (const k of ['label', 'desc', 'hidden']) if (k in b) same[k] = b[k]
          if (typeof b.preview === 'function') same.run = b.preview
          continue
        }
        const section = sections.find((s) => s.id === (b.section ?? 'daily')) ?? sections.find((s) => s.id === 'daily')
        section.items.push({
          kind: 'feature',
          id: b.id,
          label: String(b.label ?? b.id),
          desc: String(b.desc ?? ''),
          freq: Boolean(b.freq),
          own: true,
          on: () => b.default !== false,
          run: typeof b.preview === 'function' ? b.preview : null,
          preview: typeof b.preview === 'function'
        })
      }
      for (const s of sections) s.items = s.items.filter((i) => shown(i, pet))
      return sections.filter((s) => s.items.length)
    }
    const items = (sections) => sections.flatMap((s) => s.items)

    const num = (v, min, max, fallback) => {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
      return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
    }
    // Defaults: how the pet behaves with no settings at all (its own config decides the opt-in rows).
    function defaults(sections, pet) {
      const all = items(sections)
      const on = (i) => {
        try {
          return i.on ? Boolean(i.on(pet)) : true
        } catch {
          return false
        }
      }
      return {
        v: VERSION,
        features: Object.fromEntries(all.filter((i) => i.kind === 'feature').map((i) => [i.id, on(i)])),
        freq: Object.fromEntries(all.filter((i) => (i.kind === 'feature' && i.freq) || i.kind === 'freq').map((i) => [i.id, 1])),
        speech: { dailyCap: 12 },
        quiet: { on: false, start: '23:00', end: '07:00' },
        sound: { chime: 1, song: num(pet.songVolume, 0, 1, 0.35) },
        you: { name: '' }
      }
    }
    const hm = (v, fallback) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback)
    const snapFreq = (v) => {
      const n = num(v, 0, 10, 1)
      return FREQ_STEPS.reduce((best, [s]) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), 1)
    }
    const clone = (o) => JSON.parse(JSON.stringify(o))

    // Any saved value (partial, hand-edited, broken, from an older version) -> a complete config.
    function normalize(raw, base) {
      const r = isObj(raw) ? raw : {}
      const out = clone(base)
      if (isObj(r.features)) for (const id in out.features) if (typeof r.features[id] === 'boolean') out.features[id] = r.features[id]
      if (isObj(r.freq)) for (const id in out.freq) if (r.freq[id] != null) out.freq[id] = snapFreq(r.freq[id])
      out.speech.dailyCap = Math.round(num(r.speech?.dailyCap, 0, 60, base.speech.dailyCap))
      const q = isObj(r.quiet) ? r.quiet : {}
      out.quiet.on = typeof q.on === 'boolean' ? q.on : base.quiet.on
      out.quiet.start = hm(q.start, base.quiet.start)
      out.quiet.end = hm(q.end, base.quiet.end)
      out.sound.chime = num(r.sound?.chime, 0, 2, base.sound.chime)
      out.sound.song = num(r.sound?.song, 0, 1, base.sound.song)
      const name = r.you?.name
      out.you.name = typeof name === 'string' ? name.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 16) : ''
      return out
    }
    // What to save: only what differs from the defaults, so a later default reaches anyone who never changed it.
    function changed(cfg, base) {
      const out = {}
      for (const [k, v] of Object.entries(cfg)) {
        if (k === 'v') continue
        if (isObj(v)) {
          const d = changed(v, base?.[k] ?? {})
          if (Object.keys(d).length) out[k] = d
        } else if (v !== base?.[k]) out[k] = v
      }
      return out
    }
    const diff = (cfg, base) => ({ v: VERSION, ...changed(cfg, base) })
    // A copy of cfg with one dotted path set.
    function setPath(cfg, path, value) {
      const next = clone(cfg)
      const keys = path.split('.')
      let o = next
      for (const k of keys.slice(0, -1)) o = o[k] = isObj(o[k]) ? o[k] : {}
      o[keys.at(-1)] = value
      return next
    }
    const getPath = (cfg, path) => path.split('.').reduce((o, k) => o?.[k], cfg)
    // Is `minutes` (since midnight) inside [start, end)? An end earlier than the start runs past midnight.
    const toMin = (s) => {
      const [h, m] = String(s).split(':').map(Number)
      return h * 60 + m
    }
    function inWindow(minutes, start, end) {
      const a = toMin(start)
      const b = toMin(end)
      if (a === b) return false
      return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b
    }
    const quietAt = (cfg, date = new Date()) => cfg.quiet.on && inWindow(date.getHours() * 60 + date.getMinutes(), cfg.quiet.start, cfg.quiet.end)
    // A line that names you: {you} in it is replaced (or dropped with its comma when no name is set);
    // `prefix` puts the name in front of a line that has no {you}.
    const withName = (line, name, prefix = false) => {
      if (!line) return line
      const s = String(line)
      if (s.includes('{you}')) return name ? s.replaceAll('{you}', name) : s.replace(/\{you\}[，,、]?\s*/g, '')
      return name && prefix ? `${name}，${s}` : s
    }
    return { VERSION, FREQ_STEPS, SECTIONS, catalog, items, defaults, normalize, diff, setPath, getPath, inWindow, quietAt, withName }
  })()
  T.companionConfig = CONFIG

  T.registerCompanion = function registerCompanion(cfg) {
    if (!cfg?.id || typeof cfg.svg !== 'string') throw new Error('registerCompanion needs { id, svg }')
    T.registerTouch(cfg.id, {
      label: cfg.label ?? cfg.id,
      description:
        cfg.description ??
        '拖曳、甩出去、滾輪縮放、摸摸牠；雙擊跟著你、右鍵停下；會看游標、跟著打字晃、聽得懂你送出的幾句話',
      start: () => startCompanion(cfg)
    })
  }

  function startCompanion(cfg) {
    const id = cfg.id
    const BOX = cfg.size ?? 64
    const HALF = BOX / 2
    const C = { ...DEFAULT_COLORS, ...cfg.colors }
    const S = cfg.sounds === false ? null : { ...DEFAULT_SOUNDS, ...(typeof cfg.sounds === 'object' ? cfg.sounds : {}) }
    // Settings (on, freq, conf, canSound...) are defined after the acts, below; these only run later.
    const sound = (name, gain = 0.05, gap) => S?.[name] && canSound() && chime(S[name], gain * (S.gain ?? 1) * conf().sound.chime, gap)
    const host = layer()

    // ---------- the element ----------
    const home = document.createElement('div')
    home.dataset.companion = id
    home.setAttribute('aria-label', cfg.title ?? cfg.label ?? id) // not title: a native tooltip would cover the pet on hover
    home.style.cssText = `position:absolute;left:0;top:0;width:${BOX}px;height:${BOX}px;pointer-events:auto;cursor:pointer;touch-action:none;will-change:transform`
    const glowColor = cfg.glow === false ? null : cfg.glow ?? 'color-mix(in srgb, var(--primary, #c8d2ff) 55%, transparent)'
    const glow = document.createElement('div')
    glow.style.cssText = `position:absolute;inset:-${Math.round(BOX * 0.22)}px;border-radius:50%;background:radial-gradient(closest-side,${glowColor ?? 'transparent'},transparent);opacity:.3;pointer-events:none`
    if (!glowColor) glow.style.display = 'none'
    const bob = document.createElement('div')
    bob.style.cssText = `position:relative;width:${BOX}px;height:${BOX}px`
    bob.innerHTML = cfg.svg
    const svg = bob.querySelector('svg')
    if (!svg) throw new Error(`companion ${id}: svg markup has no <svg>`)
    svg.setAttribute('width', String(BOX))
    svg.setAttribute('height', String(BOX))
    svg.setAttribute('aria-hidden', 'true')
    svg.style.overflow = 'visible'
    home.append(glow, bob)
    host.appendChild(home)

    // Named parts of the drawing, found by CSS selector: { eyes: '.my-eyes' } or { ears: { sel, origin } }.
    const P = {}
    for (const [name, spec] of Object.entries(cfg.parts ?? {})) {
      const { sel, origin } = typeof spec === 'string' ? { sel: spec } : spec ?? {}
      P[name] = sel ? [...svg.querySelectorAll(sel)] : []
      for (const el of P[name]) {
        el.style.transformBox = 'fill-box'
        // data-origin on an element wins, so a left and a right ear can each pivot where they attach.
        el.style.transformOrigin = el.dataset?.origin ?? origin ?? DEFAULT_ORIGIN[name] ?? 'center'
      }
    }
    const parts = (name) => P[name] ?? []
    const animateParts = (name, keyframes, options) => parts(name).forEach((el) => el.animate(keyframes, options))

    // The drawing's extent and its eyes, in viewBox units, read once while the SVG is still whole (hide-and-seek
    // slides it behind an edge by these).
    const vb = svg.viewBox.baseVal
    const DRAWN = (() => {
      try {
        const all = svg.getBBox()
        const eyes = parts('eyes').map((e) => e.getBBox())
        return { top: all.y, eyesBottom: eyes.length ? Math.max(...eyes.map((r) => r.y + r.height)) : null }
      } catch {
        return null
      }
    })()
    // Parts that move all the time (the breathing part, the ears) or follow the pointer (the eyes) are lifted
    // out of the SVG into HTML boxes of their own, each holding a same-viewBox SVG with just that part, stacked
    // in the drawing's own order; the rest stays in sheets between them. Chromium cannot run a transform
    // animation on an SVG child on the compositor: inside the SVG, every frame re-laid-out and repainted the
    // whole drawing (drop-shadow included), ~10 s of main-thread time a minute while idle. An HTML box animates
    // on the compositor. Only a part that is a direct child of the <svg> is lifted; the pivot is computed from
    // the part's bounding box, as `transform-box: fill-box` did inside the SVG. Gradients and other <defs>
    // still resolve: url(#id) looks across the document. (docs/performance.md, rule 14)
    const figure = liftParts(svg, P, ['flutter', 'ears', 'eyes'], BOX)
    const head = figure ?? svg // what turns toward the pointer

    // Faces: swap the open eyes for the happy or sleeping ones, when the drawing has them.
    for (const el of [...parts('happyEyes'), ...parts('sleepEyes')]) el.style.opacity = '0'
    let faceTimer = 0
    const setFace = (face, ms = 0) => {
      clearTimeout(faceTimer)
      const want = face === 'happy' ? 'happyEyes' : face === 'sleep' ? 'sleepEyes' : 'eyes'
      if (!parts(want).length) return
      for (const name of ['eyes', 'happyEyes', 'sleepEyes']) for (const el of parts(name)) el.style.opacity = name === want ? '' : '0'
      if (ms) faceTimer = setTimeout(() => !stopped && setFace(mode === 'asleep' ? 'sleep' : null), ms)
    }

    const loops = [
      bob.animate([{ transform: 'translateY(0)' }, { transform: `translateY(${-BOX * 0.07}px)` }], { duration: 3200, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }),
      ...parts('flutter').map((el) => el.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(.88)' }], { duration: 1400, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' })),
      ...parts('ears').map((el, i) => el.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${i % 2 ? 3 : -3}deg)` }], { duration: 2600, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }))
    ]
    // A loop should run on the compositor, but Chromium runs it on the main thread when it starts while
    // another animation on the same element is in effect, or when one lands on it later (a reaction, a
    // fill: 'forwards' pose), and then keeps it there for good: pause()/play() do not bring it back. Once the
    // element is back to just its loop, a fresh copy at the same currentTime (no visible jump) is composited
    // again. Done right after each other animation on that element ends, and on the 5 s recheck.
    // (docs/performance.md, rule 15)
    const seats = [] // [get, set] of each loop that should stay composited
    const reseat = ([get, set]) => {
      const loop = get()
      if (stopped || !loop || loop.playState !== 'running') return
      const el = loop.effect.target
      if (!el.isConnected || el.getAnimations().some((a) => a !== loop)) return
      const keyframes = loop.effect.getKeyframes().map(({ computedOffset, ...k }) => k)
      const fresh = Element.prototype.animate.call(el, keyframes, loop.effect.getTiming())
      fresh.playbackRate = loop.playbackRate
      fresh.currentTime = loop.currentTime
      loop.cancel()
      set(fresh)
    }
    const keepComposited = (el, get, set) => {
      const seat = [get, set]
      seats.push(seat)
      const settle = () => requestAnimationFrame(() => reseat(seat))
      const own = el.animate
      el.animate = function (keyframes, options) {
        const a = own.call(this, keyframes, options)
        // The loops themselves (infinite, replace) do not count; everything else is reseated after.
        if (!(options?.iterations === Infinity && (options.composite ?? 'replace') === 'replace')) a.finished.then(settle, settle)
        return a
      }
    }
    loops.forEach((loop, i) => keepComposited(loop.effect.target, () => loops[i], (a) => (loops[i] = a)))

    // Reactions (a sway per keystroke, a startle, a twirl, the droop...) are added on top of the loop and of
    // each other with composite: 'add', and Chromium runs an additive animation on the main thread, with a
    // style recalc every frame and the loop under it dragged along: ~10 s a minute while typing. Instead
    // each element gets a few nested same-size boxes (same pivot) and every additive transform animation
    // plays in a free box of its own, replacing nothing: nested transforms compose exactly like added
    // ones, and each runs on the compositor. Order is kept (a new one goes inside the innermost busy box);
    // only when none is free does it fall back to adding, as before.
    const LAYERS = 4
    const stacked = (el) => {
      const boxes = []
      let parent = el
      const kids = [...el.childNodes]
      for (let i = 0; i < LAYERS; i++) {
        const box = document.createElement('div')
        box.style.cssText = `position:absolute;left:0;top:0;width:100%;height:100%;transform-origin:${el.style.transformOrigin || '50% 50%'}`
        parent.appendChild(box)
        boxes.push({ box, anim: null })
        parent = box
      }
      parent.append(...kids)
      const taken = (b) => {
        const a = b.anim
        if (!a || a.playState === 'idle' || a.replaceState === 'removed') return false
        if (a.playState !== 'finished') return true
        const fill = a.effect?.getTiming().fill
        return fill === 'forwards' || fill === 'both'
      }
      const own = el.animate
      el.animate = function (keyframes, options) {
        if (options?.composite !== 'add' || !keyframes.every((k) => Object.keys(k).every((p) => p === 'transform' || p === 'offset' || p === 'easing'))) return own.call(this, keyframes, options)
        const inner = boxes.findLastIndex(taken)
        const b = boxes.slice(inner + 1).find((x) => !taken(x)) ?? boxes.find((x) => !taken(x))
        if (!b) return Element.prototype.animate.call(boxes.at(-1).box, keyframes, options)
        b.anim = Element.prototype.animate.call(b.box, keyframes, { ...options, composite: 'replace' })
        return b.anim
      }
      return parent // where the content now lives
    }
    const bobInner = stacked(bob)
    for (const name of ['flutter', 'ears', 'eyes']) for (const el of parts(name)) if (el instanceof HTMLElement) stacked(el)

    // ---------- where it is and how big ----------
    const SPOT_KEY = `orca-companion:${id}:spot`
    const SIZE_KEY = `orca-companion:${id}:size`
    const store = (key, value) => {
      try {
        localStorage.setItem(key, value)
      } catch {}
    }
    let saved = null
    let size = 1
    try {
      saved = JSON.parse(localStorage.getItem(SPOT_KEY) || 'null')
      size = Math.min(2.5, Math.max(0.5, Number(localStorage.getItem(SIZE_KEY)) || 1))
    } catch {}
    // The box scales from its center, so a bigger pet reaches `edge` past it on every side.
    const edge = () => HALF * size - HALF
    const clamp = (p) => ({ x: Math.min(Math.max(p.x, edge()), innerWidth - BOX - edge()), y: Math.min(Math.max(p.y, edge()), innerHeight - BOX - edge()) })
    let spot = { x: 24, y: innerHeight - 100 }
    const center = () => ({ x: spot.x + HALF, y: spot.y + HALF })
    const homeSpot = () => {
      if (saved) return clamp({ x: saved.fx * innerWidth, y: saved.fy * innerHeight })
      if (typeof cfg.home === 'function') return clamp(cfg.home({ width: innerWidth, height: innerHeight, box: BOX }))
      const bar = document.querySelector('.bg-worktree-sidebar[data-os-file-drop-owner]')?.getBoundingClientRect()
      return bar && bar.width > 140 ? clamp({ x: bar.right - BOX - 20, y: bar.bottom - BOX - 48 }) : clamp({ x: 18, y: innerHeight - BOX - 46 })
    }
    const place = (p, tilt = 0) => {
      spot = p
      home.style.transform = `translate(${p.x}px, ${p.y}px)` + (tilt ? ` rotate(${tilt}deg)` : '') + (size !== 1 ? ` scale(${size})` : '')
    }
    const saveSpot = () => {
      saved = { fx: spot.x / innerWidth, fy: spot.y / innerHeight }
      store(SPOT_KEY, JSON.stringify(saved))
    }
    const flyTo = (p, ms = 700) => {
      const from = home.style.transform
      place(p)
      return home.animate([{ transform: from }, { transform: home.style.transform }], { duration: ms, easing: 'cubic-bezier(.45,.05,.3,1)' }).finished.catch(() => {})
    }
    place(homeSpot())

    // Animations that keep their end state (dim while asleep) are tracked here: once finished, Chromium
    // may drop them from getAnimations() while they still apply, so they could not be found to cancel.
    const held = new Set()
    const hold = (keyframes, options) => {
      const a = home.animate(keyframes, options)
      held.add(a)
      return a
    }
    const release = () => {
      held.forEach((a) => a.cancel())
      held.clear()
    }

    let stopped = false // late timers check this after stop()
    let mode = 'home' // home | asleep | flying | following | visiting | hiding
    // Every change of `mode` goes through here, so the debugState row can show and log it.
    const trace = T.companionRules.stateTrace(() => on('debugState'), {
      make: () => {
        const el = document.createElement('div')
        el.dataset.companionState = ''
        el.style.cssText = 'position:absolute;left:50%;bottom:100%;transform:translate(-50%,-4px);padding:1px 5px;border-radius:4px;background:rgb(0 0 0 / .65);color:#fff;font:600 10px/1.4 ui-monospace,monospace;white-space:nowrap;pointer-events:none'
        home.appendChild(el)
        return el
      },
      log: (line) => console.debug(`[companion ${id}] ${line}`)
    })
    const setMode = (to, why) => {
      const from = mode
      mode = to
      trace.change(from, to, why)
    }
    let busy = null // the action playing now; idle picks wait for it
    let drag = null
    let roaming = false // out for a little stroll: don't snap it home
    const free = () => !stopped && mode === 'home' && !drag && !roaming && !document.hidden
    const onResize = (e) => {
      if (e?.type === 'resize' && seek?.spot && mode === 'hiding') {
        clearTimeout(seek.resized)
        seek.resized = seekLater(reseek, 150) // once the resize settles: the rects moved
        return
      }
      if (mode === 'home' && !drag && !roaming) place(homeSpot())
    }
    addEventListener('resize', onResize)
    const reposition = setInterval(() => {
      onResize() // the sidebar can be dragged wider or collapsed
      if (mode === 'home' && !held.size && getComputedStyle(home).opacity !== '1') hold([{ opacity: 1 }, { opacity: 1 }], { duration: 1, fill: 'forwards' })
      seats.forEach(reseat) // a loop that fell back to the main thread gets its composited copy (see keepComposited)
    }, 5000)

    // ---------- small effects ----------
    const floatUp = (glyph, color, { x = center().x, y = spot.y + BOX * 0.1, rise = 30, ms = 1100, px = 0, glow = false } = {}) => {
      const el = document.createElement('div')
      el.textContent = glyph
      const shadow = glow ? `0 0 4px #fff,0 0 10px ${color},0 0 22px ${color}` : `0 0 6px ${color}`
      el.style.cssText = `position:absolute;left:${x}px;top:${y}px;font:600 ${px || Math.round(12 * Math.max(1, size * 0.8))}px/1 system-ui;color:${color};text-shadow:${shadow};pointer-events:none;white-space:nowrap`
      host.appendChild(el)
      const dx = (Math.random() - 0.5) * 24
      // A glowing glyph (the notes) pops in at once and stays bright for most of its rise; a plain sign
      // fades in and out around the middle.
      el.animate(
        glow
          ? [
              { transform: 'translate(0,0) scale(.5)', opacity: 0 },
              { transform: `translate(${dx * 0.2}px,${-rise * 0.15}px) scale(1.15)`, opacity: 1, offset: 0.12 },
              { transform: `translate(${dx * 0.7}px,${-rise * 0.7}px) scale(1)`, opacity: 1, offset: 0.72 },
              { transform: `translate(${dx}px,${-rise}px) scale(.9)`, opacity: 0 }
            ]
          : [
              { transform: 'translate(0,0) scale(.6)', opacity: 0 },
              { transform: `translate(${dx * 0.4}px,${-rise * 0.4}px) scale(1)`, opacity: 1, offset: 0.25 },
              { transform: `translate(${dx}px,${-rise}px) scale(.8)`, opacity: 0 }
            ],
        { duration: ms, easing: 'ease-out' }
      ).onfinish = () => el.remove()
    }
    const sparkle = (count, radius = BOX * 0.53) => {
      const c = center()
      for (let i = 0; i < count; i++) {
        const s = document.createElement('div')
        const a = (i / count) * Math.PI * 2
        s.style.cssText = `position:absolute;left:${c.x - 2.5}px;top:${c.y - 6}px;width:5px;height:5px;border-radius:50%;background:${C.sparkle};box-shadow:0 0 6px ${C.sparkle};pointer-events:none`
        host.appendChild(s)
        s.animate(
          [
            { transform: 'translate(0,0) scale(1)', opacity: 1 },
            { transform: `translate(${Math.cos(a) * radius * size}px,${(Math.sin(a) * radius - 6) * size}px) scale(.3)`, opacity: 0 }
          ],
          { duration: 700, easing: 'cubic-bezier(.2,.7,.3,1)' }
        ).onfinish = () => s.remove()
      }
    }
    const act = (keyframes, duration, easing = 'ease-in-out') => {
      busy = bob.animate(keyframes, { duration, easing, composite: 'add' })
      busy.onfinish = busy.oncancel = () => (busy = null)
      return busy
    }

    // ---------- mood: what happened lately colors what it does ----------
    // Each mood is a level 0..1 that fades over minutes; the strongest leans the idle picks and now and
    // then shows as a small sign over its head.
    const mood = { happy: 0, curious: 0, bored: 0, sleepy: 0, worried: 0 }
    const feel = (name, amount) => name in mood && (mood[name] = Math.max(0, Math.min(1, mood[name] + amount)))
    const topMood = () => {
      let best = null
      for (const [k, v] of Object.entries(mood)) if (v > 0.35 && (!best || v > mood[best])) best = k
      return best
    }
    const SIGNS = {
      happy: ['♡', C.heart],
      curious: ['?', C.calm],
      bored: ['…', C.dim],
      sleepy: ['z', C.calm],
      worried: ['!?', C.alert],
      surprised: ['!', C.alert],
      giggle: ['嘻', C.heart], // a hint from its hiding place, and when found
      smug: ['哼哼', C.dim], // you never found it
      blush: ['///', C.heart], // caught in the act
      ...cfg.emotes
    }
    const emote = (name) => {
      const sign = SIGNS[name]
      if (sign) floatUp(sign[0], sign[1], { x: center().x + BOX * 0.28 * size, y: center().y - BOX * 0.53 * size, rise: 20, ms: 1500 })
    }
    let lastTouch = Date.now()
    const touched = () => {
      lastTouch = Date.now()
      mood.bored *= 0.3
    }
    const moodTimer = setInterval(() => {
      for (const k in mood) mood[k] *= 0.9 // every 30 s: halves in about 3 minutes
      const hour = new Date().getHours()
      if (hour >= 23 || hour < 6) feel('sleepy', 0.08)
      if (Date.now() - lastTouch > 8 * 60000 && !document.hidden) feel('bored', 0.06)
    }, 30000)

    // ---------- speech: now and then a short line in a bubble over its head ----------
    // Few and far between: idle lines at least 6 minutes apart, any line at least 45 s apart, at most 12 a
    // day. Milestones, greetings and late-night worry skip the spacing (they are rare by nature).
    // A character with no `lines` never speaks.
    const L = {
      idle: [], night: [], done: [], failed: [], welcome: [], name: [], late: [], milestone: [], found: [], notFound: [], caught: [], lantern: [],
      // Its feelings speaking (companion_emotion.js): low spirits, lonely, the first low of the day, a sulk and
      // being won back, too many failures, and a tier closer ({tier} is the new tier's name) or further apart.
      low: [], lonely: [], lowFirst: [], sulk: [], consoled: [], anxious: [], tierUp: [], tierDown: [],
      ...cfg.lines
    }
    const pick = (list) => (Array.isArray(list) && list.length ? list[(Math.random() * list.length) | 0] : null)
    const today = () => new Date().toLocaleDateString('sv') // YYYY-MM-DD, local time
    const BOND_KEY = `orca-companion:${id}:bond`
    let bond = { met: today(), days: 0, last: '', hours: Array(24).fill(0), celebrated: [], lateWarned: '', said: { date: today(), n: 0 } }
    try {
      bond = { ...bond, ...JSON.parse(localStorage.getItem(BOND_KEY) || 'null') }
    } catch {}
    // Its feelings live in the same save (bond.emo); companion_emotion.js is the model. A pet that knew you
    // before it had feelings starts at affection 60, the days together counted toward closeness.
    const EM = cfg.emotion === false ? null : T.companionEmotion ?? null
    const EW = EM?.words(cfg.emotion?.words)
    const ES = EM?.speed?.(cfg.emotion?.transitionSpeed) ?? null // how fast the mood moves up / down; null: one pace
    const EF = EM?.fade?.(cfg.emotion?.fadeBias) ?? null // bad moments wear off faster than good ones; null: their own hours
    let emo = EM ? (bond.emo ? EM.normalize(bond.emo) : EM.migrate(bond)) : null
    const saveBond = () => {
      if (emo) bond.emo = EM.serialize(emo)
      store(BOND_KEY, JSON.stringify(bond))
    }
    const emoEvent = (kind, arg) => Boolean(emo) && EM.event(emo, kind, Date.now(), arg)
    let bubble = null
    let bubbleTimer = 0
    let lastSaid = 0
    let lastIdleSaid = 0
    const hush = () => {
      clearTimeout(bubbleTimer)
      if (!bubble) return
      const el = bubble
      bubble = null
      el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translate(-50%, -4px)' }], { duration: 260, easing: 'ease-in' }).onfinish = () => el.remove()
    }
    const say = (text, { idle = false, force = false } = {}) => {
      const now = Date.now()
      if (!text || stopped || document.hidden || !['home', 'visiting'].includes(mode) || !canSpeak()) return false
      if (bond.said.date !== today()) bond.said = { date: today(), n: 0 }
      if (!force && (now - lastSaid < 45000 || bond.said.n >= conf().speech.dailyCap || (idle && now - lastIdleSaid < (6 * 60000) / freq('talk')))) return false
      text = CONFIG.withName(text, conf().you.name)
      bond.said.n++
      saveBond()
      lastSaid = now
      if (idle) lastIdleSaid = now
      hush()
      const el = document.createElement('div')
      bubble = el
      el.setAttribute('role', 'status')
      // Long lines wrap inside the box (nowrap let them spill past max-width). The box is sized for the
      // whole line up front (the rest of it sits there invisible), its bottom just over the pet's head, so
      // typing it out never makes it jump or cover the pet. Measured once per line, not per character.
      el.style.cssText =
        'position:absolute;left:0;top:0;transform:translateX(-50%);width:max-content;max-width:240px;padding:6px 12px;border-radius:12px;' +
        'background:color-mix(in srgb,var(--popover,#1b1b24) 94%,transparent);color:var(--popover-foreground,#eee);border:1px solid var(--border,#444);' +
        'box-shadow:0 10px 24px -10px rgb(0 0 0 / .7);font:13px/1.55 var(--app-font-family,system-ui);letter-spacing:.02em;' +
        'white-space:normal;overflow-wrap:anywhere;text-wrap:balance;pointer-events:none;' +
        (cfg.bubbleStyle ?? '')
      const shown = document.createTextNode('')
      const rest = document.createElement('span')
      rest.style.visibility = 'hidden'
      rest.textContent = String(text)
      el.append(shown, rest)
      host.appendChild(el)
      const { width: w, height: h } = el.getBoundingClientRect()
      el.style.left = `${Math.min(Math.max(center().x, w / 2 + 8), innerWidth - w / 2 - 8)}px`
      el.style.top = `${Math.max(8, center().y - HALF * size - 6 - h)}px`
      el.animate([{ opacity: 0, transform: 'translate(-50%, 6px) scale(.96)' }, { opacity: 1, transform: 'translate(-50%, 0) scale(1)' }], { duration: 240, easing: 'cubic-bezier(.2,.8,.3,1)' })
      // Typed out a character at a time, the way someone talks.
      const chars = [...String(text)]
      let i = 0
      const type = () => {
        if (bubble !== el) return
        shown.data = chars.slice(0, ++i).join('')
        rest.textContent = chars.slice(i).join('')
        if (i < chars.length) bubbleTimer = setTimeout(type, 55)
        else bubbleTimer = setTimeout(hush, 2400 + chars.length * 110)
      }
      type()
      return true
    }
    const later = (ms, fn) => setTimeout(() => !stopped && fn(), ms)

    // ---------- bond: remembers the days you spent together and when you usually work ----------
    // Kept only in this Orca profile's localStorage; nothing leaves the machine.
    const MILESTONES = cfg.milestones ?? [7, 30, 100, 200, 365, 500, 1000]
    const greetLine = () => {
      const h = new Date().getHours()
      const g = L.greeting ?? {}
      return pick(h >= 5 && h < 11 ? g.morning : h >= 5 && h < 14 ? g.noon : h >= 5 && h < 18 ? g.afternoon : h >= 5 && h < 23 ? g.evening : g.night)
    }
    const celebrate = (n) => {
      busy?.cancel()
      busy = null
      twirl()
      sparkle(14, BOX * 0.62)
      sound('welcome', 0.06, 0.13)
      for (let i = 0; i < 8; i++) later(i * 120, () => floatUp(i % 2 ? '♡' : '✦', i % 2 ? C.heart : C.sparkle, { x: spot.x + Math.random() * BOX, y: spot.y + 6, rise: 44, ms: 1600 }))
      feel('happy', 0.6)
      const line = pick(L.milestone)
      if (line) later(900, () => say(line.replaceAll('{n}', String(n)), { force: true }))
    }
    const greet = () => {
      const h = new Date().getHours()
      emote(h >= 23 || h < 5 ? 'sleepy' : 'happy')
      act([t(0, 0), t(-3, -8, -10), t(0, 0), t(3, -8, 10), t(0, 0)], 1300, 'cubic-bezier(.3,.7,.4,1)')
      const line = CONFIG.withName(greetLine(), conf().you.name, true)
      if (line) later(500, () => say(line, { force: true }))
    }
    // Counts a new day the first time it sees you that day (also past midnight with Orca open).
    let meetTimer = 0
    const meetToday = () => {
      if (bond.last === today()) return
      bond.days++
      bond.last = today()
      saveBond()
      const meet = () => {
        if (stopped) return
        if (document.hidden || !document.hasFocus() || mode !== 'home') return (meetTimer = setTimeout(meet, 5000))
        const n = bond.days
        if (MILESTONES.includes(n) && !bond.celebrated.includes(n) && on('milestones')) {
          bond.celebrated.push(n)
          emoEvent('milestone')
          saveBond()
          ;(reactions.milestone ?? celebrate)(n, api)
        } else if (n > 1 && on('greet')) (reactions.greet ?? greet)(api)
      }
      meetTimer = setTimeout(meet, 4500)
    }
    const bondTimer = setInterval(() => !stopped && meetToday(), 60000)
    // Notes the hour you send things at, and worries when it is much later than you are usually around.
    const noteSent = () => {
      const h = new Date().getHours()
      bond.hours[h]++
      const total = bond.hours.reduce((a, b) => a + b, 0)
      if (h < 5) emoEvent('late') // up in the small hours: a cloud until 05:00, not a mark against you
      if ((h >= 23 || h < 5) && total >= 60 && bond.hours[h] / total < 0.03 && bond.lateWarned !== today() && on('late')) {
        bond.lateWarned = today()
        emote('worried')
        feel('worried', 0.15)
        later(600, () => say(pick(L.late), { force: true }))
      }
      saveBond()
    }

    // ---------- moves ----------
    const twirl = () => {
      if (busy || !['home', 'visiting'].includes(mode)) return
      busy = bob.animate(
        [
          { transform: 'translateY(0) rotate(0deg) scale(1)' },
          { transform: `translateY(${-BOX * 0.22}px) rotate(200deg) scale(1.12)`, offset: 0.55 },
          { transform: 'translateY(0) rotate(360deg) scale(1)' }
        ],
        { duration: 900, easing: 'cubic-bezier(.3,.7,.3,1)', composite: 'add' }
      )
      sparkle(7)
      busy.onfinish = busy.oncancel = () => (busy = null)
    }
    const happy = () => {
      setFace('happy', 1700)
      bob.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-7px) scale(1.06)' }, { transform: 'translateY(0)' }], { duration: 420, easing: 'ease-out', composite: 'add' })
      for (let i = 0; i < 5; i++)
        setTimeout(() => !stopped && floatUp(i % 2 ? '♡' : '✦', i % 2 ? C.heart : C.sparkle, { x: spot.x + BOX * 0.3 + Math.random() * BOX * 0.4 }), i * 110)
      sound('pet', 0.07, 0.1)
      feel('happy', 0.5)
      touched()
    }
    const ears = (keyframes, duration, easing) => animateParts('ears', keyframes, { duration, easing, composite: 'add' })
    const deg = (...ds) => ds.map((d) => ({ transform: `rotate(${d}deg)` }))

    const builtInActs = {
      // A quick float up-left, then up-right, wriggling. The default signature move.
      wiggle: {
        weight: (c) => 3 + c.mood.happy * 2,
        run: () => {
          act(
            at([t(0, 0), t(-10, -12, -16), t(-3, -16, 4), t(10, -13, 16), t(3, -7, -7), t(-2, -2, 3), t(0, 0)], [0, 0.2, 0.35, 0.55, 0.72, 0.86, 1]),
            1300
          )
          animateParts('flutter', [{ transform: 'scaleX(1)' }, { transform: 'scaleX(.8)' }, { transform: 'scaleX(1.04)' }, { transform: 'scaleX(1)' }], { duration: 1300, composite: 'add' })
        }
      },
      lookAround: {
        weight: (c) => 3 + c.mood.curious * 3 + c.mood.worried * 2,
        run: () => {
          act(at([t(0, 0), t(-2, 0, -11), t(-2, 0, -11), t(2, -1, 10), t(2, -1, 10), t(0, 0)], [0, 0.2, 0.42, 0.62, 0.84, 1]), 2600)
          ears(deg(0, -6, 5, 0), 2600)
        }
      },
      stretch: {
        weight: (c) => 2 + c.mood.bored * 2,
        run: () => act(at([t(0, 0), t(0, 4, 0, 1.08, 0.9), t(0, -6, 0, 0.92, 1.14), t(0, -6, 0, 0.92, 1.14), t(0, 1, 0, 1.05, 0.95), t(0, 0)], [0, 0.18, 0.4, 0.62, 0.82, 1]), 1900)
      },
      earFlick: {
        weight: (c) => (parts('ears').length ? 2 + c.mood.worried * 2 : 0),
        run: () => {
          act([t(0, 0), t(0, -2), t(0, 0)], 700)
          ears(deg(0, -12, 9, -7, 4, 0), 700, 'ease-out')
        }
      },
      loop: {
        weight: (c) => 2 + c.mood.happy * 2,
        run: () => {
          const ring = Array.from({ length: 9 }, (_, i) => {
            const a = (i / 8) * Math.PI * 2
            return { ...t(Math.sin(a) * 14, -Math.sin(a / 2) * 22, (i / 8) * 360), offset: i / 8 }
          })
          act(ring, 1500)
          sparkle(5, BOX * 0.38)
        }
      },
      doze: {
        weight: (c) => (c.night ? 3 : 0.5) + c.mood.sleepy * 4,
        run: () => {
          setFace('sleep', 2600)
          act(at([t(0, 0), t(0, 4, 8), t(0, 1, 2), t(0, 6, 12), t(0, -3, -4), t(0, 0)], [0, 0.25, 0.4, 0.68, 0.84, 1]), 2800)
        }
      },
      hum: {
        weight: (c) => 2 + c.mood.happy * 3,
        run: () => {
          act([t(0, 0), t(-3, -2, -6), t(3, -2, 6), t(-3, -2, -6), t(0, 0)], 2400)
          for (let i = 0; i < 4; i++) setTimeout(() => !stopped && floatUp(i % 2 ? '♪' : '♫', C.note, { x: center().x + (i % 2) * 10, y: spot.y + 4, rise: 34, ms: 1600 }), i * 450)
        }
      },
      chaseStar: {
        weight: (c) => 2 + c.mood.happy * 2 + c.mood.curious,
        run: () => {
          const dx = (Math.random() < 0.5 ? -1 : 1) * (36 + Math.random() * 20)
          const dy = -18 - Math.random() * 16
          const star = document.createElement('div')
          star.textContent = '✦'
          star.style.cssText = `position:absolute;left:${center().x + dx}px;top:${center().y - 6 + dy}px;font:600 11px/1 system-ui;color:${C.alert};text-shadow:0 0 8px ${C.alert};pointer-events:none`
          host.appendChild(star)
          star.animate([{ opacity: 0, transform: 'scale(.4)' }, { opacity: 1, transform: 'scale(1)' }, { opacity: 1, transform: 'scale(1) rotate(90deg)' }, { opacity: 0, transform: 'scale(2.2) rotate(140deg)' }], { duration: 1700, easing: 'ease-out' }).onfinish = () => star.remove()
          act(at([t(0, 0), t(dx * 0.15, dy * 0.15, -dx / 6), t(dx * 0.7, dy * 0.7, dx / 5), t(dx * 0.7, dy * 0.7, 0), t(0, 0)], [0, 0.2, 0.5, 0.62, 1]), 1800)
          setTimeout(() => !stopped && sound('star', 0.03), 900)
        }
      },
      peek: {
        weight: (c) => (c.near ? 4 + c.mood.curious * 2 : 0),
        run: () => {
          if (!pointer) return
          const dx = pointer.x - center().x
          const dy = pointer.y - center().y
          const lean = Math.max(-1, Math.min(1, dx / 200))
          act(at([t(0, 0), t(lean * 8, Math.sign(dy) * 3, lean * 14), t(lean * 8, Math.sign(dy) * 3, lean * 14), t(0, 0)], [0, 0.3, 0.75, 1]), 2000)
        }
      },
      cheer: {
        weight: (c) => (c.working ? 3 : 0),
        run: () => {
          act([t(0, 0), t(0, -9, -6), t(0, 0), t(0, -9, 6), t(0, 0)], 1100, 'cubic-bezier(.3,.7,.4,1)')
          sparkle(4, BOX * 0.34)
        }
      },
      sigh: {
        weight: (c) => c.mood.bored * 4 + c.mood.sleepy,
        run: () => {
          act(at([t(0, 0), t(0, -3, 0, 0.97, 1.04), t(0, 6, 0, 1.05, 0.93), t(0, 6, 0, 1.05, 0.93), t(0, 0)], [0, 0.25, 0.55, 0.78, 1]), 2600)
          setTimeout(() => !stopped && emote('bored'), 900)
        }
      },
      // Sings: your own audio file when `sing` names one (see playAudio), else a silent hum with notes.
      // Not picked when idle; a word ("唱歌", "sing") or play('sing') asks for it.
      sing: { weight: 0, run: () => sing() },
      // Juggles three stars until the returned cleanup is called (the default scene for being caught in
      // the act), or for six seconds when nothing calls it.
      juggle: {
        weight: 0,
        run: () => {
          const stars = []
          for (let i = 0; i < 3; i++) {
            const star = document.createElement('div')
            star.textContent = '✦'
            star.style.cssText = `position:absolute;left:${HALF - 6}px;top:${BOX * 0.06}px;font:600 ${Math.round(BOX * 0.33)}px/1 system-ui;color:${C.sparkle};text-shadow:0 0 10px ${C.alert};pointer-events:none`
            bobInner.appendChild(star)
            stars.push(star)
            const arc = Array.from({ length: 13 }, (_, k) => {
              const a = (k / 12) * Math.PI * 2
              return { transform: `translate(${(Math.cos(a) * BOX * 0.37).toFixed(1)}px,${(-Math.abs(Math.sin(a)) * BOX * 0.47 + BOX * 0.1).toFixed(1)}px) rotate(${k * 30}deg)` }
            })
            star.animate(arc, { duration: 1100, iterations: Infinity, delay: -i * 366 })
          }
          const hop = bob.animate([t(0, 0), t(0, -5), t(0, 0)], { duration: 400, iterations: Infinity, composite: 'add' })
          const done = () => (clearTimeout(stopAt), hop.cancel(), stars.forEach((s) => s.remove()))
          const stopAt = setTimeout(done, 6000)
          return done
        }
      },
      // Wanders off a little way, looks around there, and drifts back home.
      wander: {
        weight: (c) => 1.5 + c.mood.bored * 3 + c.mood.curious * 3,
        run: async () => {
          const from = { ...spot }
          const dx = (Math.random() < 0.5 ? -1 : 1) * (50 + Math.random() * 80)
          const there = clamp({ x: from.x + dx, y: from.y + (Math.random() - 0.5) * 60 })
          roaming = true
          busy = { cancel() {}, playState: 'running' } // a placeholder so nothing else starts meanwhile
          bob.animate([t(0, 0), t(0, -4, Math.sign(dx) * 10), t(0, 0)], { duration: 1800, composite: 'add' })
          await flyTo(there, 1800)
          busy = null
          if (stopped || drag || mode !== 'home') return (roaming = false)
          acts.lookAround()
          await wait(3000 + Math.random() * 2500)
          if (stopped || drag || mode !== 'home' || spot.x !== there.x || spot.y !== there.y) return (roaming = false)
          bob.animate([t(0, 0), t(0, -4, -Math.sign(dx) * 10), t(0, 0)], { duration: 1800, composite: 'add' })
          await flyTo(homeSpot(), 1800)
          roaming = false
        }
      }
    }

    // The character's own acts join (or replace, or with null remove) the built-in ones.
    const actTable = { ...builtInActs }
    for (const [name, spec] of Object.entries(cfg.acts ?? {})) {
      if (spec === null) delete actTable[name]
      else if (typeof spec === 'function') actTable[name] = { weight: 2, run: spec }
      else actTable[name] = { weight: 2, ...spec }
    }
    const signatureName = cfg.signature && actTable[cfg.signature] ? cfg.signature : 'wiggle'

    // ---------- settings: what the panel switched on or off (CONFIG above; panel: companion_settings.js) ----------
    // Read at every trigger point; rebuilt only when the saved object changes. A switch that is off only
    // stops the behaviour from starting on its own: 「試試看」 still plays it (preview below).
    const petInfo = {
      cfg,
      acts: new Set(Object.keys(actTable)),
      parts: new Set(Object.keys(P).filter((k) => P[k].length)),
      speaks: Object.values(L).some((v) => (Array.isArray(v) ? v.length > 0 : v && typeof v === 'object' && Object.values(v).some((a) => a?.length))),
      sounds: Boolean(S),
      song: Boolean(typeof cfg.sing === 'string' || cfg.sing?.asset),
      songVolume: cfg.sing?.volume,
      glow: Boolean(glowColor),
      emotion: Boolean(EM)
    }
    const SECTIONS = CONFIG.catalog(petInfo)
    const BASE = CONFIG.defaults(SECTIONS, petInfo)
    let confMemo = { raw: undefined, value: null }
    const conf = () => {
      const raw = T.state?.companions?.[id] ?? null
      if (!confMemo.value || confMemo.raw !== raw) confMemo = { raw, value: CONFIG.normalize(raw, BASE) }
      return confMemo.value
    }
    const on = (feature) => conf().features[feature] !== false // a row this pet does not show counts as on
    const freq = (feature) => conf().freq[feature] ?? 1
    let previewUntil = 0 // a preview speaks and sounds even when switched off or in quiet hours
    const previewing = () => Date.now() < previewUntil
    const canSpeak = () => previewing() || (on('speech') && !CONFIG.quietAt(conf()))
    const canSound = () => previewing() || (on('sound') && !CONFIG.quietAt(conf()))
    const acts = {}
    for (const [name, spec] of Object.entries(actTable)) {
      acts[name] = () => {
        try {
          return spec.run(api)
        } catch (error) {
          console.warn(`[companion ${id}] act ${name} failed`, error)
        }
      }
    }
    const signature = () => {
      if (busy || drag || mode !== 'home') return
      ;(acts[signatureName] ?? acts.wiggle)?.()
    }

    // Reactions: what words, clicks and events trigger. A character may replace any of them.
    const reactions = {
      happy,
      twirl,
      signature,
      goodNews: () => (twirl(), feel('happy', 0.3), setTimeout(() => !stopped && emote('happy'), 500)),
      thanks: () => (signature(), emote('happy'), feel('happy', 0.2)),
      sleepy: () => (emote('sleepy'), acts.doze?.(), feel('sleepy', 0.3)),
      worried: () => (emote('worried'), (acts.earFlick ?? acts.lookAround)?.(), feel('worried', 0.2)),
      curious: () => (emote('curious'), acts.lookAround?.(), feel('curious', 0.2)),
      name: () => (happy(), later(700, () => say(pick(L.name)))),
      poke: () => {
        act([t(0, 0), t(0, -8, 0, 1.06, 0.94), t(0, 0)], 420, 'cubic-bezier(.3,.7,.4,1)')
        emote(topMood() ?? 'happy')
        feel('happy', 0.1)
        touched()
      },
      ...cfg.reactions
    }
    // A name that is neither a reaction nor an act (a typo in `words`, an act left out of a pet someone
    // shared) does not leave it frozen mid-pose: it warns once per name and does an ordinary idle act.
    const firstMiss = missing.once()
    const warnMissing = (kind, name) => firstMiss(kind, name) && console.warn(`[companion ${id}] ${kind} "${name}" not found; ${kind === 'act' ? 'idling instead' : 'going on without it'}`)
    const playable = (n) => Boolean(reactions[n] ?? acts[n])
    const play = (name) => {
      if (missing.resolve(name, playable) === 'idle') {
        warnMissing('act', String(name))
        if (mode === 'home' && !drag && !stopped) {
          busy?.cancel()
          busy = null
          lastAct = pickAct()
          acts[lastAct]?.()
        }
        return false
      }
      busy?.cancel()
      busy = null // a cancelled action clears itself only on the next tick
      ;(reactions[name] ?? acts[name])(api)
      return true
    }

    // ---------- idle repertoire: something small every so often, never the same twice in a row ----------
    let pointer = null
    let vigil = null
    let lastAct = ''
    const pickAct = () => {
      const hour = new Date().getHours()
      // The longer feelings lean the picks too: a good day reads as happy, a lonely one as bored.
      const l = emo ? EM.lean(emo) : null
      const lift = (k) => Math.max(0, Math.min(1, mood[k] + (l?.[k] ?? 0)))
      const ctx = {
        mood: l ? { ...mood, happy: lift('happy'), bored: lift('bored'), worried: lift('worried') } : mood,
        hour,
        night: hour >= 22 || hour < 6,
        near: Boolean(pointer && Math.hypot(pointer.x - center().x, pointer.y - center().y) < 260),
        working: Boolean(vigil)
      }
      const weights = {}
      for (const [name, spec] of Object.entries(actTable)) {
        if (name === lastAct || !on(name)) continue
        const w = (typeof spec.weight === 'function' ? spec.weight(ctx) : spec.weight) * freq(name)
        if (w > 0) weights[name] = w
      }
      let r = Math.random() * Object.values(weights).reduce((a, b) => a + b, 0)
      for (const [name, w] of Object.entries(weights)) if ((r -= w) <= 0) return name
      return signatureName
    }
    const [idleMin, idleMax] = cfg.idleEvery ?? [12000, 30000]
    let idleTimer = 0
    const scheduleIdle = () => {
      idleTimer = setTimeout(() => {
        if (!document.hidden && mode === 'home' && !busy && !drag && on('idle')) {
          lastAct = pickAct()
          const feeling = topMood()
          if (feeling && lastAct !== 'sigh' && on('mood') && Math.random() < 0.4) emote(feeling)
          acts[lastAct]?.()
          const h = new Date().getHours()
          const pool = emo?.lone >= 60 && L.lonely.length ? L.lonely : emo?.mood < 50 && L.low.length ? L.low : h >= 22 || h < 5 ? (L.night.length ? L.night : L.idle) : L.idle
          if (Math.random() < 0.15 * freq('talk')) later(1200, () => say(pick(pool), { idle: true }))
        }
        scheduleIdle()
      }, (idleMin + Math.random() * (idleMax - idleMin)) / freq('idle'))
    }
    scheduleIdle()

    // ---------- blinking ----------
    let blinkTimer = 0
    const blink = () => {
      blinkTimer = setTimeout(() => {
        if (mode !== 'asleep' && !document.hidden && on('blink')) animateParts('eyes', [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.12)' }, { transform: 'scaleY(1)' }], { duration: 170, composite: 'add' })
        blink()
      }, 2500 + Math.random() * 4500)
    }
    blink()

    // ---------- startle: the pointer whips past close by ----------
    let lastPointer = null
    let startleCooldown = 0
    const startle = (fromX) => {
      busy?.cancel()
      const dir = Math.sign(center().x - fromX) || 1
      act(at([t(0, 0), t(dir * 10, -9, dir * 14, 0.94, 1.06), t(dir * 6, -2, dir * 4), t(0, 0)], [0, 0.22, 0.6, 1]), 650, 'cubic-bezier(.2,.8,.3,1)')
      ears(deg(0, -10, 0), 650)
      emote('surprised')
      feel('worried', 0.12)
      feel('curious', 0.25)
    }

    // ---------- gaze: eyes and body turn toward the pointer when it comes near ----------
    head.style.transformOrigin = '50% 85%'
    head.style.transition = 'transform .45s cubic-bezier(.3,.7,.4,1)'
    for (const el of parts('eyes')) el.style.transition = 'transform .25s ease-out'
    const eyeReach = cfg.eyeTravel ?? [2.2, 1.6] // in the drawing's own units (viewBox)
    // The eyes are HTML boxes now (see liftParts), so a glance is in screen px. Unchanged values are not
    // written again: each write restarts the transition (a style recalc per pointer frame for the same look).
    const eyeK = figure ? BOX / (vb.width || 120) : 1
    let eyesNow = ''
    let headNow = ''
    const lookEyes = (x = 0, y = 0) => {
      const v = x || y ? `translate(${(x * eyeK).toFixed(1)}px,${(y * eyeK).toFixed(1)}px)` : ''
      if (v === eyesNow) return
      eyesNow = v
      for (const el of parts('eyes')) el.style.transform = v
    }
    const turnHead = (v) => v !== headNow && (head.style.transform = headNow = v)
    let gazeQueued = 0 // a frame id, or -1 while the trailing timer waits
    let gazeAt = null // a point a preview asks it to look at
    let gazeTimer = 0
    let gazeLast = 0
    // At most every 60 ms: the head eases over .45 s and the eyes over .25 s anyway, so following each
    // pointer frame only restarted those transitions for the same look. A trailing call catches the last move.
    const GAZE_MS = 60
    const gaze = () => {
      gazeQueued = 0
      if (stopped) return
      const now = performance.now()
      if (now - gazeLast < GAZE_MS) {
        gazeQueued = -1
        gazeTimer = setTimeout(gaze, GAZE_MS - (now - gazeLast))
        return
      }
      gazeLast = now
      const awake = mode === 'home' || mode === 'following'
      const target = gazeAt ?? pointer
      const dx = target ? target.x - center().x : 0
      const dy = target ? target.y - center().y : 0
      const dist = Math.hypot(dx, dy)
      const reach = gazeAt ? Infinity : 360 * size
      if (!awake || drag || !target || dist < 8 || dist > reach || !(gazeAt || on('gaze'))) {
        turnHead('')
        lookEyes()
        return
      }
      const pull = gazeAt ? 1 : Math.min(1, (reach - dist) / (reach * 0.5)) // full attention when close, fading far away
      const ux = dx / dist
      const uy = dy / dist
      lookEyes(ux * eyeReach[0] * pull, uy * eyeReach[1] * pull)
      turnHead(`rotate(${(ux * 7 * pull).toFixed(1)}deg) translate(${(ux * 2 * pull).toFixed(1)}px,${(Math.min(0, uy) * 1.5 * pull).toFixed(1)}px)`)
    }
    const onPointer = (e) => {
      const now = performance.now()
      const p = { x: e.clientX, y: e.clientY, t: now }
      if (lastPointer && mode === 'home' && !drag && now > startleCooldown && now - lastPointer.t < 50 && on('startle')) {
        const speed = Math.hypot(p.x - lastPointer.x, p.y - lastPointer.y) / Math.max(1, now - lastPointer.t)
        const near = Math.hypot(p.x - center().x, p.y - center().y) < BOX * 1.1 * size
        if (near && speed > 3) {
          startleCooldown = now + 20000
          startle(p.x)
        }
      }
      lastPointer = p
      pointer = p
      if (seek?.spot && mode === 'hiding') seekNear(p)
      // Far away with its head already straight there is nothing to turn: no frame is asked for.
      const far = Math.hypot(p.x - center().x, p.y - center().y) > 400 * size
      if (!gazeQueued && !(far && !headNow && !eyesNow)) gazeQueued = requestAnimationFrame(gaze)
    }
    addEventListener('pointermove', onPointer, { capture: true, passive: true })

    // ---------- typing: sways along with your rhythm ----------
    // keydown plus compositionupdate: Windows IMEs send keydown only for the first composing key, while
    // compositionupdate fires on every key that changes the underlined text. Throttled to one sway per 150 ms.
    let swaySide = 1
    let lastSway = 0
    const onTypeSway = (e) => {
      if (!isTerminal(e.target) || e.ctrlKey || e.altKey || e.metaKey) return
      if (mode !== 'home' || busy || drag || document.hidden || !on('sway')) return
      const now = performance.now()
      if (now - lastSway < 150) return
      lastSway = now
      swaySide = -swaySide
      bob.animate([t(0, 0), t(swaySide * 1.2, -2, swaySide * 4, 1.02, 0.98), t(0, 0)], { duration: 260, easing: 'ease-out', composite: 'add' })
    }
    addEventListener('keydown', onTypeSway, { capture: true, passive: true })
    addEventListener('compositionupdate', onTypeSway, { capture: true, passive: true })

    // ---------- what you type: reacts to the line you send, and to a run of deletions ----------
    // The line lives only in memory and is dropped on Enter; nothing is stored or sent anywhere.
    // Its own name comes first: a happy hop and, maybe, an answer.
    const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const names = [].concat(cfg.names ?? []).filter(Boolean)
    const nameWord = names.length ? [{ re: new RegExp(names.map(escapeRe).join('|'), 'i'), react: 'name' }] : []
    const words = [...nameWord, ...(cfg.words ?? []), ...(cfg.defaultWords === false ? [] : DEFAULT_WORDS)]
    let line = ''
    let lastWord = -Infinity // performance.now() starts near 0 on a fresh window
    let erased = []
    let lastPuzzled = -Infinity
    let lastGit = -Infinity
    const puzzled = () => {
      act(at([t(0, 0), t(1, 1, 14), t(1, 1, 14), t(0, 0)], [0, 0.25, 0.75, 1]), 1800)
      emote('curious')
    }
    const onTypedChar = (e) => {
      if (!isTerminal(e.target) || e.ctrlKey || e.altKey || e.metaKey || e.isComposing || e.key === 'Process') return
      if (e.key === 'Enter') {
        const sent = line
        line = ''
        noteSent()
        const now = performance.now()
        if (mode !== 'home' || drag) return
        // A git commit or push (opt-in) comes first and has its own, shorter spacing.
        const git = gitMoment(sent)
        if (git && on(git === 'push' ? 'gitPush' : 'gitCommit') && now - lastGit > 5000) {
          lastGit = lastWord = now
          return play(git === 'push' ? 'gitPush' : 'gitCommit')
        }
        if (now - lastWord < 8000 || !on('words')) return
        const hit = words.find((w) => w.re.test(sent))
        if (!hit || (hit.react === 'sing' && !on('sing'))) return
        lastWord = now
        const felt = { thanks: 'thanks', worried: 'bug', sing: 'sing' }[hit.react]
        if (felt) emoEvent(felt)
        busy?.cancel()
        busy = null
        try {
          typeof hit.react === 'function' ? hit.react(api) : play(hit.react)
        } catch (error) {
          console.warn(`[companion ${id}] word reaction failed`, error)
        }
      } else if (e.key === 'Backspace') {
        line = line.slice(0, -1)
        const now = performance.now()
        erased = erased.filter((t0) => now - t0 < 2500)
        erased.push(now)
        // Erasing and erasing: it tilts its head at you.
        if (erased.length >= 8 && now - lastPuzzled > 20000 && mode === 'home' && !busy && !drag && on('puzzled')) {
          lastPuzzled = now
          erased = []
          puzzled()
        }
      } else if (e.key.length === 1) line = (line + e.key).slice(-200)
    }
    const onTypedIme = (e) => isTerminal(e.target) && e.data && (line = (line + e.data).slice(-200))
    addEventListener('keydown', onTypedChar, { capture: true, passive: true })
    addEventListener('compositionend', onTypedIme, { capture: true, passive: true })

    // ---------- petting: rub the pointer back and forth over it ----------
    let petDir = 0
    let petFlips = 0
    let petReset = 0
    let petCooldown = 0
    const onHover = (e) => {
      if (drag || e.buttons || !['home', 'asleep'].includes(mode) || !on('pet')) return
      const dir = Math.sign(e.movementX)
      if (!dir || dir === petDir) return
      petDir = dir
      petFlips++
      clearTimeout(petReset)
      petReset = setTimeout(() => (petFlips = 0), 600)
      if (petFlips < 5 || performance.now() < petCooldown) return
      petFlips = 0
      petCooldown = performance.now() + 2500
      if (mode === 'asleep') wake()
      // Sulking in its corner: each pat counts; the third wins it back.
      if (sulking) return sulkPetted()
      bond.pets = (bond.pets || 0) + 1
      const tierBefore = emo && EM.tierIndex(emo.aff)
      emoEvent('pet')
      saveBond()
      reactions.happy()
      if (emo) applyFeelings(tierBefore)
    }
    home.addEventListener('pointermove', onHover)

    // ---------- the typing streak from power-mode brightens the glow ----------
    let baseGlow = 0.3
    let glowTimer = 0
    const onCombo = (e) => on('comboGlow') && comboGlow(e.detail)
    const comboGlow = (n) => {
      if (mode !== 'home' || !glowColor) return
      glow.style.opacity = String(baseGlow + Math.min(1, n / 60) * (1 - baseGlow))
      clearTimeout(glowTimer)
      glowTimer = setTimeout(
        () => glow.animate([{ opacity: glow.style.opacity }, { opacity: baseGlow }], { duration: 900 }).finished.then(() => (glow.style.opacity = String(baseGlow))).catch(() => {}),
        1600
      )
      if (n % 50 === 0) twirl()
    }
    addEventListener('orca-themer:combo', onCombo)

    // ---------- toasts: a twirl ----------
    const seenToasts = new WeakSet()
    const toasts = new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) {
          if (!(n instanceof HTMLElement)) continue
          const toast = n.matches?.('[data-sonner-toast]') ? n : n.querySelector?.('[data-sonner-toast]')
          if (toast && !seenToasts.has(toast)) {
            seenToasts.add(toast)
            if (on('toast')) twirl()
          }
        }
    })
    toasts.observe(document.body, { childList: true, subtree: true })

    // ---------- agents: keeps vigil while they work, knocks on the tab that waits for you ----------
    // Orca tabs: [data-testid="sortable-tab"] with data-agent-activity-status = working | permission | done | failed.
    const setVigil = (on) => {
      if (on && !vigil && glowColor) vigil = glow.animate([{ opacity: 0.35 }, { opacity: 0.9 }], { duration: 2200, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' })
      else if (on && !vigil) vigil = { cancel() {} }
      if (!on && vigil) {
        vigil.cancel()
        vigil = null
      }
    }
    // The glow also fades for the combo, the droop and the sleep; the breathing loop gets back to the
    // compositor after each (see keepComposited).
    keepComposited(glow, () => (vigil?.effect ? vigil : null), (a) => (vigil = a))
    // Something failed: it visibly sags for a couple of seconds (head down, body squashed, ears flat, the
    // fluttering part folded, glow out), then slowly picks itself back up. Reduced motion keeps only the dim.
    const droop = () => {
      if (mode !== 'home') return
      // Big enough to read at 64 px: it sinks a third of its height, tips over, the ears fold flat and the
      // wool deflates; each transform plays in its own box (stacked), so all of it stays on the compositor.
      const D = 3200
      const sag = (from, to) => [from, { ...to, offset: 0.16 }, { ...to, offset: 0.74 }, from]
      if (!T.reducedMotion?.()) {
        bob.animate(sag({ transform: 'translateY(0)' }, { transform: `translateY(${BOX * 0.32}px) rotate(-18deg) scale(.9,.76)` }), { duration: D, easing: 'cubic-bezier(.3,.7,.3,1)', composite: 'add' })
        animateParts('ears', sag({ transform: 'scaleY(1) rotate(0deg)' }, { transform: 'scaleY(.35) rotate(14deg)' }), { duration: D, easing: 'ease-out', composite: 'add' })
        animateParts('flutter', sag({ transform: 'scale(1)' }, { transform: 'scale(.5,.6)' }), { duration: D, easing: 'ease-out', composite: 'add' })
      }
      bob.animate(sag({ opacity: 1 }, { opacity: 0.45 }), { duration: D, easing: 'ease-out' })
      if (glowColor) glow.animate(sag({ opacity: baseGlow }, { opacity: 0 }), { duration: D, easing: 'ease-out' })
      later(300, () => emote('worried'))
    }
    let visitingTab = null
    let knock = null
    const visit = async (tab) => {
      if (tab && mode === 'hiding') endSeek() // a tab waiting for you beats the game
      if (tab && mode === 'home' && !busy && !drag) {
        setMode('visiting', '有分頁在等你')
        visitingTab = tab
        // A tab of a worktree not in front: it knocks on that worktree's row in the sidebar instead.
        await loadStore()
        if (mode !== 'visiting' || visitingTab !== tab || stopped) return
        const r = tabRect(tab)
        await flyTo(clamp({ x: r.left + r.width / 2 - HALF, y: r.bottom + 2 + edge() }), 800)
        if (mode !== 'visiting' || stopped) return
        knock = bob.animate(deg(0, -9, 7, 0), { duration: 900, iterations: Infinity, composite: 'add' })
        floatUp('!', C.alert, { x: center().x + 8, y: spot.y, rise: 18, ms: 900 })
      } else if (!tab && mode === 'visiting') {
        leaveVisit()
      }
    }
    const leaveVisit = async () => {
      knock?.cancel()
      knock = null
      visitingTab = null
      setMode('flying', '不用敲門了，飛回家')
      await flyTo(homeSpot(), 800)
      if (!stopped) setMode('home', '敲完門回到家')
    }
    const lastStatus = new WeakMap()
    let knockHold = 0
    const readStatus = () => {
      if (stopped) return
      let working = false
      let waiting = null
      let finished = false
      let failed = false
      for (const tab of document.querySelectorAll('[data-testid="sortable-tab"]')) {
        const s = tab.getAttribute('data-agent-activity-status')
        const prev = lastStatus.get(tab)
        lastStatus.set(tab, s)
        if (s === 'working') working = true
        // The one on screen first: another worktree's tabs are mounted too, only not laid out.
        if (s === 'permission' && (!waiting || (!shown(waiting) && shown(tab)))) waiting = tab
        if (prev === 'working' && s === 'done') finished = true
        if (prev && prev !== s && s === 'failed') failed = true
      }
      setVigil(working && on('vigil'))
      // Its feelings keep the books first: a failure counts even when it is too busy, switched off or too
      // recently sad to droop over it. Done within the hour after a failure is a relief as well.
      if (emo && (finished || failed)) {
        if (finished) emoEvent('pass'), emoEvent('agentDone')
        if (failed) emoEvent('agentFail')
        saveBond()
        applyFeelings()
      }
      if (finished && on('done')) twirl(), feel('happy', 0.2), later(900, () => say(pick(L.done)))
      if (failed && on('droop')) droop(), feel('worried', 0.45), later(900, () => say(pick(L.failed)))
      if (Date.now() < knockHold) return // a preview knocks on a tab that does not wait for you
      const want = on('knock') ? waiting : null
      if (want !== visitingTab) visit(want)
    }
    let statusQueued = 0
    const statusObserver = new MutationObserver(() => {
      if (!statusQueued) statusQueued = requestAnimationFrame(() => ((statusQueued = 0), readStatus()))
    })
    statusObserver.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-agent-activity-status'] })
    const statusTimer = setInterval(readStatus, 3000) // tabs that appear or close
    readStatus()

    // ---------- away and back: a welcome after more than 10 minutes ----------
    const away = () => document.hidden || !document.hasFocus()
    let awaySince = 0
    const onLeave = () => (awaySince ||= Date.now())
    const welcome = () => {
      wake()
      if (mode !== 'home') return
      busy?.cancel()
      emote('surprised')
      setFace('happy', 1400)
      act([t(0, 0), t(0, -12, -8), t(0, 0), t(0, -8, 8), t(0, 0)], 1200, 'cubic-bezier(.3,.7,.4,1)')
      ears(deg(0, -8, 6, 0), 1200)
      sparkle(8)
      sound('welcome', 0.05, 0.11)
      feel('happy', 0.4)
      mood.bored = 0
      later(1000, () => say(CONFIG.withName(pick(L.welcome), conf().you.name, true)))
    }
    let welcomeTimer = 0
    const onBack = () => {
      if (away()) return onLeave()
      const gone = awaySince ? Date.now() - awaySince : 0
      awaySince = 0
      if (gone > 60000) emoEvent('back', gone) // it stops missing you the moment you are back
      // Sometimes (opt-in) you catch it doing something of its own; otherwise the plain welcome.
      if (gone > (cfg.welcomeAfter ?? 10 * 60000)) welcomeTimer = setTimeout(() => !stopped && !caught() && on('welcome') && reactions.welcome?.(api), 300)
    }
    reactions.welcome ??= welcome
    addEventListener('blur', onLeave)
    addEventListener('focus', onBack)
    document.addEventListener('visibilitychange', onBack)

    // ---------- sleep after a while without input ----------
    let sleepTimer = 0
    let zTimer = 0
    let dozing = null
    const sleepAfter = () => {
      const hour = new Date().getHours()
      return (cfg.sleepAfter ?? (hour >= 18 || hour < 6 ? 120000 : 90000)) / freq('sleep')
    }
    const sleep = (force = false) => {
      if (mode !== 'home' || document.hidden || (!force && (busy || !on('sleep')))) return
      setMode('asleep', force ? '試試看睡覺' : '一陣子沒動靜')
      setFace('sleep')
      hold([{ opacity: 1 }, { opacity: 0.75 }], { duration: 1600, fill: 'forwards' })
      dozing = bob.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(-10deg) translateY(4px)' }], { duration: 1800, easing: 'ease-in-out', fill: 'forwards', composite: 'add' })
      const z = () => {
        floatUp('z', C.calm, { x: center().x + BOX * 0.22, y: spot.y + BOX * 0.12, rise: 24, ms: 2400 })
        zTimer = setTimeout(z, 2600)
      }
      z()
    }
    let lastActive = Date.now()
    let sleepHold = 0 // a sleep preview: activity does not wake it until then
    const wake = () => {
      if (mode === 'asleep' && Date.now() < sleepHold) return
      lastActive = Date.now()
      clearTimeout(sleepTimer)
      sleepTimer = setTimeout(sleep, sleepAfter())
      if (mode !== 'asleep') return
      setMode('home', '醒來')
      clearTimeout(zTimer)
      release()
      dozing?.cancel()
      dozing = null
      setFace(null)
      home.animate([{ opacity: 0.75 }, { opacity: 1 }], { duration: 300 })
    }
    const activity = ['pointermove', 'keydown', 'wheel', 'pointerdown']
    for (const ev of activity) addEventListener(ev, wake, { capture: true, passive: true })
    wake()

    // ---------- feelings: the minute tick, and what the thresholds look like ----------
    // The model (companion_emotion.js) only moves when ticked: once a minute, and once now to catch up on
    // the days Orca was closed. Nothing here runs per frame or per keystroke.
    let sulking = null
    let low = null // the 低落 look: ears held down, a little dimmer
    let lowSaidDay = ''
    let lastAnxLine = 0
    const hereNow = () => !away() && Date.now() - lastActive < 10 * 60000
    const setLow = (flag) => {
      if (flag === Boolean(low)) return
      if (!flag) {
        low.forEach((a) => a.cancel())
        low = null
        return
      }
      low = [home.animate([{ opacity: 1 }, { opacity: 0.85 }], { duration: 1200, fill: 'forwards' })]
      if (!T.reducedMotion?.()) for (const [i, el] of parts('ears').entries()) low.push(el.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${i % 2 ? -12 : 12}deg)` }], { duration: 1200, easing: 'ease-out', fill: 'forwards', composite: 'add' }))
    }
    // Reads the state after a tick or an event and lets it show; tierBefore / bandBefore are from before,
    // for the one line said when a threshold is crossed.
    const applyFeelings = (tierBefore = null, bandBefore = null) => {
      if (stopped || !emo) return
      const now = Date.now()
      const v = EM.view(emo, now, EW, EF)
      setLow(v.mood < EM.P.lowBelow && !sulking)
      if (v.mood < EM.P.lowBelow && bandBefore != null && bandBefore >= EM.P.lowBelow && lowSaidDay !== EM.dayKey()) {
        lowSaidDay = EM.dayKey()
        later(800, () => (emote('bored'), say(pick(L.lowFirst), { force: true })))
      }
      if (tierBefore != null && v.tier !== tierBefore) {
        const up = v.tier > tierBefore
        const line = pick(up ? L.tierUp : L.tierDown)
        later(1500, () => {
          emote(up ? 'happy' : 'bored')
          if (up) happy()
          if (line) say(line.replaceAll('{tier}', v.tierName), { force: true })
        })
      }
      if (v.mood < EM.P.sulkBelow) sulk()
      if (v.anx >= 70 && now - lastAnxLine > 30 * 60000 && free() && !busy) {
        lastAnxLine = now
        emote('worried')
        say(pick(L.anxious), { force: true })
      }
    }
    const emoTick = () => {
      if (stopped || !emo) return
      const now = Date.now()
      const tierBefore = EM.tierIndex(emo.aff)
      const bandBefore = EM.moodBand(emo.mood)[0]
      EM.tick(emo, now, { present: hereNow(), sinceTouch: now - lastTouch, speed: ES, fade: EF })
      saveBond()
      applyFeelings(tierBefore, bandBefore)
    }
    if (emo) {
      EM.tick(emo, Date.now(), { present: !away(), sinceTouch: Infinity, speed: ES, fade: EF }) // quietly: the welcome is greet's
      saveBond()
    }
    const emoTimer = emo ? setInterval(emoTick, 60000) : 0
    const emoFirst = emo ? setTimeout(() => applyFeelings(), 1500) : 0

    // 消沉 (mood under 20): it drifts to the nearest bottom corner, turns half away, dims and says nothing
    // more, for up to 30 minutes, once a day at most. Three pats win it back (a 「被哄好了」 moodlet). Off in
    // the settings: 鬧彆扭. A preview (force) does not use up today's sulk or book anything.
    const sulk = (force = false) => {
      if (!emo || sulking || stopped) return false
      if (!force && (!on('sulk') || CONFIG.quietAt(conf()) || !free() || busy || mode !== 'home' || emo.today.sulked)) return false
      if (!force) {
        emo.today.sulked = true
        saveBond()
      }
      const me = (sulking = { pets: 0, anims: [], since: Date.now(), timer: 0, preview: force })
      setLow(false)
      hush()
      busy?.cancel()
      roaming = true
      busy = { cancel: () => endSulk('cancel'), playState: 'running' }
      const left = center().x < innerWidth / 2
      const side = left ? -1 : 1
      flyTo(clamp({ x: left ? 10 : innerWidth - BOX - 10, y: innerHeight - BOX - 48 }), 1500).then(() => {
        if (stopped || sulking !== me) return
        if (!T.reducedMotion?.()) {
          me.anims.push(bob.animate([t(0, 0), t(side * 5, 6, side * 15, 0.96, 0.96)], { duration: 900, easing: 'ease-out', fill: 'forwards', composite: 'add' }))
          for (const [i, el] of parts('ears').entries()) me.anims.push(el.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${i % 2 ? -19 : 19}deg)` }], { duration: 900, easing: 'ease-out', fill: 'forwards', composite: 'add' }))
        }
        me.anims.push(home.animate([{ opacity: 1 }, { opacity: 0.62 }], { duration: 900, fill: 'forwards' }))
        floatUp('……', C.dim, { x: center().x - side * BOX * 0.3, y: spot.y, rise: 18, ms: 2600 })
        later(700, () => sulking === me && say(pick(L.sulk), { force: true }))
        me.timer = setTimeout(() => sulking === me && endSulk('timeout'), 30 * 60000)
      })
      return true
    }
    const endSulk = (why) => {
      if (!sulking) return
      const me = sulking
      sulking = null
      clearTimeout(me.timer)
      me.anims.forEach((a) => a.cancel())
      busy = null
      const back = () => {
        if (stopped || drag || mode !== 'home') return void (roaming = false)
        flyTo(homeSpot(), 1100).then(() => (roaming = false))
      }
      if (why !== 'consoled') return back()
      if (!me.preview) emoEvent('comforted'), saveBond()
      home.animate([{ opacity: 0.62 }, { opacity: 1 }], { duration: 500 })
      happy()
      later(600, () => say(pick(L.consoled), { force: true }))
      later(1800, back)
      later(2000, () => applyFeelings())
    }
    // A pat while it sulks: a small flinch, then the third one wins it back.
    const sulkPetted = () => {
      if (!sulking) return
      sulking.pets++
      touched()
      if (sulking.pets >= 3) return endSulk('consoled')
      bob.animate([t(0, 0), t(0, -3, 0, 1.02), t(0, 0)], { duration: 320, easing: 'ease-out', composite: 'add' })
      floatUp(sulking.pets === 1 ? '……' : '…？', C.dim, { y: spot.y, rise: 16, ms: 1600 })
    }

    // ---------- size: the wheel over it (0.5x to 2.5x, remembered) ----------
    const onWheel = (e) => {
      if (!on('wheel')) return // the page scrolls as if it were not there
      e.preventDefault()
      if (seek) return // tucked behind an edge: resizing would push it out of its hiding place
      size = Math.min(2.5, Math.max(0.5, size * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
      if (Math.abs(size - 1) < 0.04) size = 1
      place(clamp(spot))
      store(SIZE_KEY, String(size))
    }
    home.addEventListener('wheel', onWheel, { passive: false })

    // ---------- drag, and throw with inertia ----------
    let justDragged = false
    let flightRaf = 0
    let landTimer = 0
    const throwIt = (vx, vy) => {
      setMode('flying', '被甩出去')
      const back = homeSpot()
      const p = { ...spot }
      let last = performance.now()
      const step = (now) => {
        const dt = Math.min(32, now - last)
        last = now
        p.x += vx * dt
        p.y += vy * dt
        const min = edge()
        const maxX = innerWidth - BOX - min
        const maxY = innerHeight - BOX - min
        if (p.x < min || p.x > maxX) {
          vx = -vx * 0.6
          p.x = Math.min(Math.max(p.x, min), maxX)
          sparkle(5, BOX * 0.3)
        }
        if (p.y < min || p.y > maxY) {
          vy = -vy * 0.6
          p.y = Math.min(Math.max(p.y, min), maxY)
          sparkle(5, BOX * 0.3)
        }
        const k = Math.pow(0.94, dt / 16)
        vx *= k
        vy *= k
        place(p, Math.max(-28, Math.min(28, vx * 26)))
        if (Math.hypot(vx, vy) > 0.03) {
          flightRaf = requestAnimationFrame(step)
          return
        }
        flightRaf = 0
        place(p)
        // A short dizzy wobble, then it drifts back to where it lives.
        bob.animate(deg(0, 12, -10, 0), { duration: 700, composite: 'add' })
        emote('surprised')
        landTimer = setTimeout(async () => {
          if (stopped) return
          await flyTo(back, 1100)
          if (stopped) return
          setMode('home', '落地飛回家')
          signature()
        }, 700)
      }
      flightRaf = requestAnimationFrame(step)
    }
    const onDown = (e) => {
      hush()
      touched()
      if (e.button !== 0 || !['home', 'asleep', 'visiting'].includes(mode) || !(on('drag') || on('throw'))) return
      busy?.cancel()
      wake()
      drag = { dx: e.clientX - spot.x, dy: e.clientY - spot.y, startX: e.clientX, startY: e.clientY, moved: false, lastX: e.clientX, samples: [] }
      try {
        home.setPointerCapture(e.pointerId) // keeps the drag even when the pointer outruns it
      } catch {}
    }
    const onMove = (e) => {
      if (!drag) return
      if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return
      if (!drag.moved) {
        drag.moved = true
        loops.slice(1).forEach((a) => (a.playbackRate = 3))
        if (mode === 'visiting') {
          knock?.cancel()
          visitingTab = null
          setMode('home', '敲門時被拖走')
        }
      }
      const tilt = Math.max(-18, Math.min(18, (e.clientX - drag.lastX) * 1.5))
      drag.lastX = e.clientX
      drag.samples.push({ x: e.clientX, y: e.clientY, t: performance.now() })
      if (drag.samples.length > 6) drag.samples.shift()
      place(clamp({ x: e.clientX - drag.dx, y: e.clientY - drag.dy }), tilt)
    }
    const onUp = () => {
      if (!drag) return
      const { moved, samples } = drag
      drag = null
      if (!moved) return
      justDragged = true
      setTimeout(() => (justDragged = false), 0)
      loops.slice(1).forEach((a) => (a.playbackRate = 1))
      const first = samples[0]
      const last = samples[samples.length - 1]
      const dt = last && first ? last.t - first.t : 0
      const vx = dt > 0 ? (last.x - first.x) / dt : 0
      const vy = dt > 0 ? (last.y - first.y) / dt : 0
      // A flick (fast release) throws it; a calm drop moves its home.
      if (dt > 0 && performance.now() - last.t < 80 && Math.hypot(vx, vy) > 0.8 && on('throw')) return throwIt(vx, vy)
      if (!on('drag')) {
        // Only throwing is allowed: a calm drop floats back home instead of moving it.
        setMode('flying', '放下，不能搬家')
        return void flyTo(homeSpot(), 700).then(() => !stopped && mode === 'flying' && setMode('home', '飛回家'))
      }
      place(spot)
      saveSpot()
      signature()
    }
    home.addEventListener('pointerdown', onDown)
    home.addEventListener('pointermove', onMove)
    home.addEventListener('pointerup', onUp)
    home.addEventListener('pointercancel', onUp)

    // ---------- follow mode: double-click it; right-click anywhere stops (never Esc) ----------
    let cursor = null
    let lastMove = 0
    let followRaf = 0
    let trailAt = 0
    const trail = (x, y) => {
      if (cfg.trail === false) return
      const d = document.createElement('div')
      d.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:5px;height:5px;border-radius:50%;background:${C.trail};box-shadow:0 0 8px 2px ${C.trail};pointer-events:none`
      host.appendChild(d)
      d.animate([{ opacity: 0.9, transform: 'scale(1)' }, { opacity: 0, transform: 'translateY(6px) scale(.3)' }], { duration: 2200, easing: 'ease-out' }).onfinish = () => d.remove()
    }
    const followStep = (now) => {
      followRaf = 0
      if (mode !== 'following' || !cursor) return
      // Resting the pointer on it lets you catch it (to double-click it home).
      const over = Math.abs(cursor.x - center().x) <= HALF * size && Math.abs(cursor.y - center().y) <= HALF * size
      if (over) return
      const target = clamp({ x: cursor.x + 18 + edge(), y: cursor.y + 14 + edge() })
      const nx = spot.x + (target.x - spot.x) * 0.14
      const ny = spot.y + (target.y - spot.y) * 0.14
      place({ x: nx, y: ny }, Math.max(-14, Math.min(14, (nx - spot.x) * 1.2)))
      const far = Math.hypot(target.x - nx, target.y - ny)
      if (now - trailAt > 40 && far > 3) {
        trailAt = now
        trail(nx + HALF - 2, ny + BOX * 0.7)
      }
      if (far > 0.5 || now - lastMove < 300) followRaf = requestAnimationFrame(followStep)
      else place(spot)
    }
    const onFollowMove = (e) => {
      cursor = { x: e.clientX, y: e.clientY }
      lastMove = performance.now()
      if (!followRaf) followRaf = requestAnimationFrame(followStep)
    }
    const stopFollow = () => {
      if (mode !== 'following') return
      setMode('home', '不跟了')
      removeEventListener('pointermove', onFollowMove, true)
      place(spot)
      saveSpot()
      signature()
    }
    // Why right-click and not Esc: in the terminal Esc interrupts Claude Code, and a double-click can't land
    // on a pet that keeps moving away from the pointer.
    const onRightFollow = (e) => {
      if (mode !== 'following') return
      e.preventDefault()
      e.stopPropagation()
      stopFollow()
    }
    addEventListener('contextmenu', onRightFollow, true)
    const toggleFollow = () => {
      feel('happy', 0.25)
      if (mode === 'following') return stopFollow()
      if (!['home', 'asleep'].includes(mode)) return
      wake()
      setMode('following', '雙擊，跟著游標')
      addEventListener('pointermove', onFollowMove, true)
      twirl()
      sound('follow', 0.05)
    }

    // ---------- clicks: one = a poke (or go answer the waiting tab; or hide, when hide-and-seek is on), two = follow ----------
    let clickTimer = 0
    const singleClick = () => {
      if (mode === 'hiding') return seek && (emoEvent('played'), comeHome(true)) // found it
      if (mode === 'visiting') {
        // A tab of another worktree (not laid out): that worktree comes to the front first.
        const id = visitingTab?.getAttribute('data-tab-id')
        if (shown(visitingTab) || !id) openTab(visitingTab)
        else goToTab(id)
        return leaveVisit()
      }
      if (mode === 'asleep') return wake()
      if (mode !== 'home' || busy) return
      if (on('seek')) return hide()
      reactions.poke()
    }
    const onClick = (e) => {
      e.stopPropagation()
      if (justDragged) return
      clearTimeout(clickTimer)
      clickTimer = setTimeout(singleClick, 260)
    }
    const onDblClick = (e) => {
      e.stopPropagation()
      clearTimeout(clickTimer)
      if (on('follow') || mode === 'following') toggleFollow()
    }
    home.addEventListener('click', onClick)
    home.addEventListener('dblclick', onDblClick)
    // Right-click on it opens its settings. While it follows you, the window's right-click (captured
    // first) stops that instead, so this only ever means "settings".
    const onMenu = (e) => {
      e.preventDefault()
      e.stopPropagation()
      T.openCompanionSettings?.(id)
    }
    home.addEventListener('contextmenu', onMenu)

    // A small prop (a stamp, a plane, a lantern) dropped into `parent`; plain DOM moved with WAAPI.
    const prop = (parent, html, css) => {
      const el = document.createElement('div')
      el.innerHTML = html
      el.style.cssText = `position:absolute;pointer-events:none;${css}`
      parent.appendChild(el)
      return el
    }
    const sideOf = () => (center().x > innerWidth - 150 ? -1 : 1) // the roomier side

    // ---------- audio: plays a file of your own, never one bundled here ----------
    // ~/.orca/themer/assets/<theme id>/<name>.(ogg|mp3|m4a|wav) surfaces as --asset-<name>; asset('name')
    // gives its URL. Nothing plays while the window is hidden, with `sounds: false`, or when Orca's
    // notification volume is 0; any key or click in the terminal stops it at once.
    const asset = (name) => {
      const v = getComputedStyle(document.documentElement).getPropertyValue(`--asset-${name}`).trim()
      return v.match(/^url\(\s*(["']?)(.*)\1\s*\)$/)?.[2] ?? ''
    }
    const soundMuted = async () => {
      try {
        return (await window.api?.settings?.get?.())?.notifications?.customSoundVolume === 0
      } catch {
        return false
      }
    }
    let playing = null
    const stopAudio = (fadeMs = 0) => {
      if (!playing) return
      const s = playing
      playing = null
      clearInterval(s.fade)
      clearTimeout(s.end)
      if (song) stopSing()
      if (!fadeMs) return s.audio.pause()
      const from = s.audio.volume
      const t0 = performance.now()
      const fade = setInterval(() => {
        const k = Math.min(1, (performance.now() - t0) / fadeMs)
        s.audio.volume = from * (1 - k)
        if (k >= 1) clearInterval(fade), s.audio.pause()
      }, 40)
    }
    // `src`: an asset name or a URL. Resolves true once it is playing; false when it cannot (no file, muted).
    const playAudio = async (src, { start = 0, length = 0, volume = 0.35, fadeIn = 800, fadeOut = 1500 } = {}) => {
      if (!S || !src || playing || stopped || document.hidden || !canSound()) return false
      const url = /^[a-z][a-z0-9+.-]*:/i.test(src) ? src : asset(src)
      // No such file in the assets folder: say so once, and the caller carries on without sound (sing
      // falls back to its silent hum, an act just keeps moving).
      if (!url) return warnMissing('sound', `--asset-${src}`), false
      if (await soundMuted()) return false
      if (playing || stopped || document.hidden) return false
      const audio = new Audio(url)
      audio.volume = 0
      const s = { audio, fade: 0, end: 0 }
      playing = s
      try {
        await new Promise((ok, fail) => {
          audio.addEventListener('loadedmetadata', ok, { once: true })
          audio.addEventListener('error', () => (warnMissing('sound', src), fail()), { once: true })
        })
        audio.currentTime = Math.max(0, Number(start) || 0)
        await audio.play()
      } catch {
        if (playing === s) playing = null
        return false
      }
      if (playing !== s) return audio.pause(), false
      const peak = Math.min(1, Math.max(0, Number(volume) || 0))
      const t0 = performance.now()
      s.fade = setInterval(() => {
        const k = Math.min(1, (performance.now() - t0) / Math.max(1, fadeIn))
        audio.volume = peak * k
        if (k >= 1) clearInterval(s.fade)
      }, 40)
      const ms = (length > 0 ? length : audio.duration - audio.currentTime) * 1000
      if (Number.isFinite(ms)) s.end = setTimeout(() => playing === s && stopAudio(fadeOut), Math.max(0, ms - fadeOut))
      audio.addEventListener('ended', () => playing === s && stopAudio(), { once: true })
      return true
    }
    const hushAudio = (e) => playing && (e.type === 'visibilitychange' ? document.hidden : isTerminal(e.target) || e.target?.closest?.('.xterm')) && stopAudio()
    addEventListener('keydown', hushAudio, true)
    addEventListener('pointerdown', hushAudio, true)
    document.addEventListener('visibilitychange', hushAudio)

    // Sings: a slow wide sway with notes drifting up. With `sing: { asset, start, length, volume }` and that
    // file in place, the file plays along (fades in and out); without one it is a silent four-second hum.
    const SING = typeof cfg.sing === 'string' ? { asset: cfg.sing } : cfg.sing && typeof cfg.sing === 'object' ? cfg.sing : null
    let song = null
    const stopSing = () => {
      if (!song) return
      const s = song
      song = null
      clearTimeout(s.notes)
      clearTimeout(s.end)
      s.sway?.cancel()
      if (busy === s.hold) busy = null
      stopAudio(600)
    }
    const sing = async () => {
      if (song || mode !== 'home' || drag || stopped) return false
      const s = (song = { sway: null, notes: 0, end: 0, hold: null })
      s.hold = { cancel: stopSing, playState: 'running' }
      busy?.cancel()
      busy = s.hold
      const played = SING?.asset ? await playAudio(SING.asset, { start: SING.start ?? 0, length: SING.length ?? 20, volume: conf().sound.song }) : false
      if (song !== s) return false
      if (mode !== 'home') return stopSing(), false
      const ms = played ? (SING.length ?? 20) * 1000 : 4000
      // A sway you can see from across the window, and notes a third of its size that glow as they rise.
      s.sway = bob.animate([t(0, 0), t(-5, -3, -12), t(0, -5, 0, 1.04), t(5, -3, 12), t(0, 0)], { duration: 3200, iterations: Infinity, easing: 'ease-in-out', composite: 'add' })
      setFace('happy', ms)
      const notes = (i = 0) => {
        if (song !== s) return
        const side = i % 2 ? 1 : -1
        floatUp(['♪', '♫', '♩', '♪'][i % 4], i % 4 === 3 ? C.heart : C.note, { x: center().x + side * BOX * 0.34 * size, y: center().y - BOX * 0.55 * size, rise: 60 * size, ms: 2600, px: Math.round(BOX * 0.44 * size), glow: true })
        s.notes = setTimeout(() => notes(i + 1), 420 + Math.random() * 300)
      }
      notes()
      s.end = setTimeout(() => song === s && stopSing(), ms)
      feel('happy', 0.2)
      return true
    }

    // ---------- hide-and-seek (opt-in): one click and it tucks itself behind an edge somewhere ----------
    // Behind the tab bar, a pane divider, the file tree, the status bar, a toast, or the window's own edge,
    // so only the top of its head shows past it, later its eyes. Now and then it leans out to look around
    // and ducks back; the pointer coming close makes it duck fast. The longer you don't find it the bolder
    // it gets, with a ✦ or a giggle drifting out as a hint. Click it to find it; after `giveUpAfter` it
    // gives up, pops out a little smug, and flies home.
    // How it is drawn: `home` sits with its center on the edge, turned so its "up" points out of the
    // hiding place, and is clipped (once per hide) to the outward half; `bob` slides along that "up"
    // (transform only) to show more or less of the drawing. How far the ears and eyes reach is read from
    // the pet's own SVG once per hide, so any drawing lines up with the edge. Rects are measured when it
    // hides and after a resize; the pointer check reuses pointermove, at most every 50 ms, against cached numbers.
    const SEEK_CFG = cfg.hideAndSeek && typeof cfg.hideAndSeek === 'object' ? cfg.hideAndSeek : {} // on/off: on('seek')
    const SEEK_GIVE_UP = SEEK_CFG.giveUpAfter ?? 45000
    const CLIP = `polygon(${-2 * BOX}px ${-2 * BOX}px, ${3 * BOX}px ${-2 * BOX}px, ${3 * BOX}px ${HALF}px, ${-2 * BOX}px ${HALF}px)`
    let seek = null
    const seekLater = (fn, ms) => {
      const s = seek
      const id = setTimeout(() => {
        s?.timers.delete(id)
        if (seek === s && !stopped) fn()
      }, ms)
      s?.timers.add(id)
      return id
    }
    const visibleRect = (el) => {
      const r = el?.getBoundingClientRect()
      return r && r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight ? r : null
    }
    // The largest ancestor that keeps the same edge (`key`) as `el`, within a size limit: the panel a row
    // or strip belongs to.
    const panelOf = (el, key, ok) => {
      let best = visibleRect(el)
      for (let p = el?.parentElement; best && p && p !== document.body; p = p.parentElement) {
        const r = visibleRect(p)
        if (!r || Math.abs(r[key] - best[key]) > 2 || !ok(r)) break
        best = r
      }
      return best
    }
    // Live rects, read only here (when it hides, and after a resize). Every lookup is optional: a missing
    // hook just means fewer places, and the window's own edges are always there.
    const measureSeek = () => {
      const tab = [...document.querySelectorAll('[data-testid="sortable-tab"]')].find(visibleRect)
      let tabs = null
      for (let p = tab?.parentElement; p && p !== document.body; p = p.parentElement) {
        const r = visibleRect(p)
        if (r && r.width >= 240 && r.height < 64) tabs = r
        if (r && r.height >= 64) break
      }
      tabs ??= visibleRect(document.getElementById('titlebar-tabs')) ?? visibleRect(document.querySelector('.titlebar'))
      const sidebar = visibleRect(document.querySelector('.bg-worktree-sidebar[data-os-file-drop-owner]'))
      const fileRow = document.querySelector('[data-file-explorer-row]') ?? document.querySelector('.right-sidebar-activity-strip')
      const files = fileRow && panelOf(fileRow, 'left', (r) => r.width < innerWidth * 0.6)
      let status = null
      for (let p = document.querySelector('.status-bar-usage-cluster'); p && p !== document.body; p = p.parentElement) {
        const r = visibleRect(p)
        if (r && r.height < 48 && r.width >= innerWidth * 0.5 && r.bottom >= innerHeight - 4) {
          status = r
          break
        }
      }
      const paneEls = [...document.querySelectorAll('.pane[data-pane-id]')]
      const panes = (paneEls.length ? paneEls : [...document.querySelectorAll('.xterm')]).map(visibleRect).filter(Boolean)
      const dividers = [...document.querySelectorAll('.pane-divider')].map((el) => ({ rect: visibleRect(el), vertical: el.classList.contains('is-vertical') })).filter((d) => d.rect)
      const toasts = [...document.querySelectorAll('[data-sonner-toast]')].map(visibleRect).filter(Boolean)
      // Not over what you are typing into: the terminal's input sits at its cursor.
      const avoid = []
      const typing = document.activeElement
      if (typing instanceof HTMLElement && (typing.isContentEditable || /^(INPUT|TEXTAREA)$/.test(typing.tagName))) {
        const r = typing.getBoundingClientRect()
        if (r.width || r.height) avoid.push(isTerminal(typing) ? { left: r.left - 40, right: r.right + 160, top: r.top - 20, bottom: r.bottom + 20 } : r)
      }
      return { rects: { tabs, sidebar, files, status, panes, dividers, toasts }, avoid }
    }
    const pickSeekSpot = (want = null) => {
      const view = { w: innerWidth, h: innerHeight }
      const { rects, avoid } = measureSeek()
      return SEEK.pick(SEEK.spots(rects, view), { view, box: BOX * size, pointer, from: center(), avoid, want })
    }
    // Slides along "up" (px, + is further behind the edge) that hide the drawing, show its top, or its eyes,
    // from the SVG's own extent: read once per hide.
    const seekGeom = () => {
      if (seek?.geom) return seek.geom
      let top = BOX * 0.15
      let eyesBottom = BOX * 0.55
      if (DRAWN) {
        const k = BOX / (vb.height || 120)
        top = (DRAWN.top - vb.y) * k
        if (DRAWN.eyesBottom != null) eyesBottom = (DRAWN.eyesBottom - vb.y) * k
      }
      const g = { duck: HALF + 2 - top, tips: HALF - 6 - top, rest: (b) => Math.round(HALF - 13 - top + ((HALF - 2 - eyesBottom) - (HALF - 13 - top)) * b), pop: -BOX * 0.7 }
      if (seek) seek.geom = g
      return g
    }
    const seekPoseNow = () => {
      if (!seek?.pose) return { x: 0, y: seek?.d ?? 0, deg: 0 }
      const m = new DOMMatrix(getComputedStyle(seek.pose.effect?.target ?? bob).transform) // the pose plays in a box of its own (stacked)
      return { x: m.e, y: m.f, deg: (Math.atan2(m.b, m.a) * 180) / Math.PI }
    }
    // Slides to a pose: y (+ is further behind the edge), a little sideways x, a head tilt.
    const seekPose = (y, ms, { x = 0, deg = 0, easing = 'cubic-bezier(.3,.7,.4,1)' } = {}) => {
      if (!seek) return null
      const cur = seekPoseNow()
      const old = seek.pose
      seek.pose = bob.animate([t(cur.x, cur.y, cur.deg), t(x, y, deg)], { duration: ms, easing, fill: 'forwards', composite: 'add' })
      old?.cancel()
      seek.d = y
      return seek.pose
    }
    const seekBold = () => Math.min(1, (Date.now() - seek.since) / 40000) // 0 → 1 over 40 s unfound
    const seekRest = () => seekGeom().rest(seekBold()) // the top of its head at first, later the eyes too
    const seekOut = (k) => {
      const [nx, ny] = SEEK.OUT[seek.spot.dir]
      return { x: seek.spot.x + nx * k, y: seek.spot.y + ny * k }
    }
    // A hint drifting out of the hiding place: a ✦ or a giggle.
    const seekHint = (kind = Math.random() < 0.55 ? 'star' : 'giggle') => {
      if (!seek?.spot) return
      const [nx, ny] = SEEK.OUT[seek.spot.dir]
      const p = seekOut(18 * size)
      const el = document.createElement('div')
      const [glyph, color] = kind === 'giggle' ? SIGNS.giggle : ['✦', C.sparkle]
      el.textContent = glyph
      el.style.cssText = `position:absolute;left:${p.x - 6}px;top:${p.y - 8}px;font:600 ${kind === 'giggle' ? 11 : 10}px/1 var(--app-font-family,system-ui);color:${color};text-shadow:0 0 6px ${color};pointer-events:none;white-space:nowrap`
      host.appendChild(el)
      const side = (Math.random() - 0.5) * 22
      const go = 34 + Math.random() * 18
      el.animate(
        [
          { transform: 'translate(0,0) scale(.5)', opacity: 0 },
          { transform: `translate(${nx * go * 0.4 + ny * side * 0.3}px,${ny * go * 0.4 + nx * side * 0.3}px) scale(1)`, opacity: 0.95, offset: 0.3 },
          { transform: `translate(${nx * go + ny * side}px,${ny * go + nx * side}px) scale(.8) rotate(${side * 4}deg)`, opacity: 0 }
        ],
        { duration: 1700, easing: 'ease-out' }
      ).onfinish = () => el.remove()
    }
    // Leans out to look around, then settles back behind the edge. Bolder the longer it lasts.
    const seekLean = () => {
      if (!seek?.spot || seek.ducked) return
      const b = seekBold()
      const side = Math.random() < 0.5 ? -1 : 1
      const out = -6 - 16 * b
      const tilt = 8 + 8 * b
      seekPose(out, 380, { x: side * (2 + 4 * b), deg: side * tilt })
      ears(deg(0, -side * 8, 0), 700)
      const stay = 700 + 700 * b
      if (b > 0.3) {
        seekLater(() => seekPose(out, 520, { x: -side * (2 + 4 * b), deg: -side * tilt }), stay)
        seekLater(() => seekPose(seekRest(), 320, { easing: 'cubic-bezier(.4,0,.6,1)' }), stay + 1020)
      } else seekLater(() => seekPose(seekRest(), 320, { easing: 'cubic-bezier(.4,0,.6,1)' }), stay)
      if (Math.random() < 0.25 + 0.4 * b) seekLater(() => seekHint(), 300)
    }
    const seekSchedule = () => {
      if (!seek) return
      clearTimeout(seek.next)
      const b = seekBold()
      seek.next = seekLater(() => {
        seekLean()
        seekSchedule()
      }, (6000 - 3800 * b) * (0.7 + Math.random() * 0.6))
    }
    // Puts it (already invisible) at a spot, clipped and turned, fully behind the edge, then lets the top
    // of its head come up.
    const seekAt = (s) => {
      seek.spot = s
      spot = { x: s.x - HALF, y: s.y - HALF }
      home.style.clipPath = CLIP
      home.style.transform = `translate(${spot.x}px, ${spot.y}px) rotate(${SEEK.ROT[s.dir]}deg)` + (size !== 1 ? ` scale(${size})` : '')
      seek.pose?.cancel()
      seek.pose = null
      loops[0].pause() // the idle bob would move it in and out of the edge
      loops[0].currentTime = 0
      const g = seekGeom()
      seek.d = g.duck
      seek.ducked = false
      seek.coming = 0
      seekPose(g.duck, 1)
      release() // the fade goes: it is fully behind the edge, so nothing shows yet
      seekLater(() => seekPose(seekRest(), 700), 700)
      seekSchedule()
    }
    // Cleans up the game. `snap`: put it straight back home (another behaviour takes over).
    const endSeek = (snap = true) => {
      if (!seek) return
      const s = seek
      seek = null
      s.timers.forEach(clearTimeout)
      clearTimeout(s.next)
      clearTimeout(s.giveUp)
      clearTimeout(s.resized)
      s.pose?.cancel()
      home.style.clipPath = ''
      loops[0].play()
      setFace(null)
      later(0, lanternTick) // the lantern comes back once the game is over
      if (!snap) return
      release()
      setMode('home', '捉迷藏中斷')
      place(homeSpot())
      home.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 })
    }
    // Out from behind the edge (found: happy; given up: smug), then home.
    const comeHome = async (found) => {
      if (!seek) return
      const s = seek
      s.timers.forEach(clearTimeout)
      s.timers.clear()
      clearTimeout(s.next)
      clearTimeout(s.giveUp)
      s.ducked = false
      setMode('flying', found ? '被找到了' : '沒被找到，時間到')
      setFace('happy')
      const g = seekGeom()
      const pop = seekPose(g.pop, found ? 300 : 520, { easing: 'cubic-bezier(.3,1.5,.5,1)' })
      if (found) {
        sparkle(6, BOX * 0.4)
        sound('pet', 0.05, 0.09)
        for (let i = 0; i < 3; i++) later(i * 120, () => seekHint(i === 1 ? 'giggle' : 'star'))
        feel('happy', 0.3)
      } else {
        later(400, () => ears(deg(0, -10, 6, 0), 900))
        later(500, () => seekHint('giggle'))
        feel('bored', 0.1)
      }
      await pop?.finished.catch(() => {})
      await wait(found ? 350 : 900)
      if (seek !== s || stopped) return
      // Off the edge: the clip goes, the turn unwinds on the way home, the slide eases back to 0.
      endSeek(false)
      const unslide = bob.animate([t(0, g.pop), t(0, 0)], { duration: 900, easing: 'cubic-bezier(.45,.05,.3,1)', composite: 'add' })
      await flyTo(homeSpot(), 900)
      unslide.cancel()
      if (stopped || mode !== 'flying') return
      setMode('home', '捉迷藏結束回到家')
      setFace(null)
      if (found) {
        twirl()
        later(600, () => say(pick(L.found), { force: true }))
      } else {
        emote('smug')
        later(600, () => say(pick(L.notFound), { force: true }))
      }
    }
    // The pointer near its hiding place (called from onPointer, throttled): duck fast, peek again later.
    const seekNear = (p) => {
      const now = performance.now()
      if (now - seek.checked < 50) return
      seek.checked = now
      const c = seekOut(16 * size)
      const d = Math.hypot(p.x - c.x, p.y - c.y)
      if (d < BOX * 1.7 * size && !seek.ducked) {
        seek.ducked = true
        seek.timers.forEach(clearTimeout)
        seek.timers.clear()
        clearTimeout(seek.next)
        seekPose(seekGeom().tips, 140, { easing: 'cubic-bezier(.2,.9,.3,1)' })
        ears(deg(0, -12, 0), 380)
        if (now - seek.startled > 4000) {
          seek.startled = now
          const q = seekOut(26 * size)
          floatUp('!', C.alert, { x: q.x - 3, y: q.y - 10, rise: 14, ms: 700 })
        }
      } else if (seek.ducked && d > BOX * 2.65 * size && !seek.coming) {
        seek.coming = seekLater(() => {
          seek.coming = 0
          seek.ducked = false
          seekPose(seekRest(), 600)
          seekSchedule()
        }, 900 + Math.random() * 600)
      } else if (seek.ducked && d <= BOX * 2.65 * size && seek.coming) {
        clearTimeout(seek.coming)
        seek.timers.delete(seek.coming)
        seek.coming = 0
      }
    }
    // Hides now. `want` (a spot name: tabs, sidebar, files, status, pane, divider, toast, window) is for
    // previews; normally any spot will do.
    const hide = (want = null) => {
      if (seek) endSeek()
      if (!['home', 'asleep'].includes(mode) || drag) return false
      wake()
      busy?.cancel()
      busy = null
      hush()
      hideLantern(false) // a lit lantern would give the hiding place away
      setMode('hiding', want ? '試試看捉迷藏' : '開始捉迷藏')
      seek = { spot: null, since: Date.now(), timers: new Set(), next: 0, giveUp: 0, resized: 0, pose: null, d: 0, ducked: false, coming: 0, checked: 0, startled: 0, geom: null }
      const s = seek
      hold([{ opacity: 1, transform: `${home.style.transform} scale(1)` }, { opacity: 0, transform: `${home.style.transform} scale(.4)` }], { duration: 280, fill: 'forwards' }).onfinish = () => {
        if (seek !== s || stopped) return
        const where = pickSeekSpot(want)
        if (!where) return endSeek()
        seekAt(where)
        s.giveUp = setTimeout(() => seek === s && !stopped && comeHome(false), SEEK_GIVE_UP)
      }
      return true
    }
    // Window resized while it hides: the rects moved, so it finds a new place of the same kind.
    const reseek = () => {
      if (!seek?.spot) return
      const where = pickSeekSpot(seek.spot.name)
      if (where) seekAt(where)
    }

    // ---------- git (opt-in): a stamp on commit, a paper plane on push ----------
    // Only the line you sent is read (gitMoment above); a chain counts its last commit/push.
    const stamp = () => {
      if (mode !== 'home') return
      const side = sideOf()
      const S = BOX * 0.6 * size
      const px = center().x + side * BOX * 0.8 * size
      const py = spot.y + BOX * 0.12 * size
      // It leans over and presses; the mark lands at the press and glows, with a ring spreading out of it.
      act(at([t(0, 0), t(side * 2, -7, side * 6, 0.96, 1.06), t(side * 2, -7, side * 6, 0.96, 1.06), t(side * 3, 3, side * 8, 1.06, 0.92), t(side * 2, 0, side * 5), t(side * 2, 0, side * 5), t(0, 0)], [0, 0.2, 0.34, 0.46, 0.56, 0.82, 1]), 2200)
      ears(at(deg(0, 8, 0), [0, 0.5, 1]), 2200)
      setFace('happy', 2300)
      const land = 2200 * 0.46
      const mark = prop(host, '✓', `left:${px - S / 2}px;top:${py - S / 2}px;width:${S}px;height:${S}px;border-radius:50%;border:${Math.max(2, S * 0.07)}px solid ${C.heart};box-shadow:0 0 10px ${C.heart};color:${C.heart};display:grid;place-items:center;font:800 ${Math.round(S * 0.55)}px/1 system-ui;text-shadow:0 0 6px ${C.heart};opacity:0`)
      if (T.reducedMotion?.()) {
        mark.animate([{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: 1600 }).onfinish = () => mark.remove()
        return
      }
      mark.animate(
        [
          { opacity: 0, transform: 'scale(1.5) rotate(-18deg)' },
          { opacity: 1, transform: 'scale(.92) rotate(-8deg)', offset: 0.08 },
          { opacity: 1, transform: 'scale(1) rotate(-8deg)', offset: 0.75 },
          { opacity: 0, transform: 'translateY(-10px) scale(1.04) rotate(-8deg)' }
        ],
        { duration: 2400, delay: land, easing: 'ease-out', fill: 'backwards' }
      ).onfinish = () => mark.remove()
      later(land, () => {
        const ring = prop(host, '', `left:${px - S * 0.5}px;top:${py - S * 0.5}px;width:${S}px;height:${S}px;border-radius:50%;border:2.5px solid ${C.heart};box-shadow:0 0 12px ${C.heart}`)
        ring.animate([{ opacity: 0.9, transform: 'scale(.7)' }, { opacity: 0, transform: 'scale(2)' }], { duration: 700, easing: 'ease-out' }).onfinish = () => ring.remove()
        sound('star', 0.05, 0.09)
      })
      feel('happy', 0.25)
    }
    const PLANE = `<svg viewBox="0 0 40 28" width="100%" height="100%" style="overflow:visible"><path d="M2 13L38 2 28 26 21 17z" fill="${C.note}" stroke="${C.dim}" stroke-width="1.3" stroke-linejoin="round"/><path d="M38 2L21 17 18 26 15 15z" fill="${C.calm}" stroke="${C.dim}" stroke-width="1.1" stroke-linejoin="round"/></svg>`
    const plane = () => {
      if (mode !== 'home') return
      const side = sideOf()
      const W = BOX * 0.72 * size
      const x0 = center().x + side * BOX * 0.53 * size
      const y0 = spot.y + BOX * 0.22 * size
      const sheet = prop(host, PLANE, `left:${x0 - W / 2}px;top:${y0 - W * 0.35}px;width:${W}px;height:${W * 0.7}px;opacity:0;filter:drop-shadow(0 0 5px ${C.note})`)
      if (T.reducedMotion?.()) {
        sheet.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 1600 }).onfinish = () => sheet.remove()
        return
      }
      // Unfolds out of a crease, then flies a curve up and off the top-right corner, a glitter trail behind.
      const x1 = innerWidth + 50
      const y1 = -50
      const cx = x0 + (x1 - x0) * 0.3
      const cy = y0 - 90
      const N = 14
      const on = (u) => [(1 - u) * (1 - u) * x0 + 2 * (1 - u) * u * cx + u * u * x1, (1 - u) * (1 - u) * y0 + 2 * (1 - u) * u * cy + u * u * y1]
      const frames = [{ opacity: 0, offset: 0, transform: 'translate(0,0) scale(.3,1) rotate(-30deg)' }, { opacity: 1, offset: 0.2, transform: 'translate(0,0) scale(1) rotate(-30deg)' }, { opacity: 1, offset: 0.3, transform: 'translate(-4px,2px) scale(1) rotate(-40deg)' }]
      const dur = 1700 + Math.hypot(x1 - x0, y1 - y0) * 1.3
      for (let i = 1; i <= N; i++) {
        const u = i / N
        const [px, py] = on(u)
        const [qx, qy] = on(Math.min(1, u + 0.02))
        const ang = (Math.atan2(qy - py, qx - px) * 180) / Math.PI
        frames.push({ opacity: 1, offset: 0.3 + 0.7 * u, transform: `translate(${(px - x0).toFixed(1)}px,${(py - y0).toFixed(1)}px) rotate(${ang.toFixed(1)}deg) scale(${(1 - u * 0.25).toFixed(2)})` })
      }
      sheet.animate(frames, { duration: dur, easing: 'cubic-bezier(.4,.1,.7,.9)', fill: 'forwards' }).onfinish = () => sheet.remove()
      for (let i = 1; i < 10; i++) {
        const u = 0.3 + (i / 10) * 0.65
        later(dur * u, () => {
          const [px, py] = on(((u - 0.3) / 0.7) * 0.97)
          floatUp(i % 2 ? '✦' : '✧', i % 2 ? C.sparkle : C.note, { x: px, y: py, rise: 16, ms: 1100, px: 14 + (i % 3) * 3 })
        })
      }
      // Wind-up and throw: crouches back, flings up and to the side, then watches it go.
      act(at([t(0, 0), t(-side * 3, 3, -side * 10, 1.05, 0.93), t(-side * 3, 3, -side * 10, 1.05, 0.93), t(side * 4, -9, side * 16, 0.94, 1.1), t(side * 3, -4, side * 10), t(side * 3, -4, side * 10), t(0, 0)], [0, 0.18, 0.3, 0.44, 0.58, 0.88, 1]), 3000)
      animateParts('flutter', [{ transform: 'scaleX(1)' }, { transform: 'scaleX(1.2)', offset: 0.44 }, { transform: 'scaleX(1)' }], { duration: 3000, composite: 'add' })
      later(700, () => sound('follow', 0.04, 0.08))
      feel('happy', 0.25)
    }
    reactions.gitCommit ??= stamp
    reactions.gitPush ??= plane

    // ---------- caught in the act (opt-in): it was doing something of its own when you came back ----------
    // A scene is an act whose run() returns a cleanup function (the prop goes away when it jumps); the
    // built-in `juggle` is one. It jumps, hides the prop, blushes, says a `caught` line, then the warm
    // half of the welcome.
    const CAUGHT = cfg.caught && typeof cfg.caught === 'object' ? cfg.caught : {} // on/off: on('caught')
    let lastCaught = -Infinity
    let lastScene = ''
    let caughtScene = null
    const caught = (force = false) => {
      if (!force && (!on('caught') || Date.now() - lastCaught < (CAUGHT.cooldown ?? 30 * 60000) / freq('caught') || !free() || busy || Math.random() > (CAUGHT.chance ?? 0.6) * freq('caught'))) return false
      if (!free() || caughtScene) return false
      const names = (CAUGHT.scenes ?? ['juggle']).filter((n) => acts[n])
      const pool = names.filter((n) => n !== lastScene)
      const name = typeof force === 'string' && acts[force] ? force : pool[(Math.random() * pool.length) | 0] ?? names[0]
      if (!name) return false
      lastScene = name
      lastCaught = Date.now()
      busy?.cancel()
      busy = null
      let cleanup = acts[name]()
      const sc = (caughtScene = { timer: 0, hold: null })
      const stop = () => {
        if (caughtScene !== sc) return
        caughtScene = null
        clearTimeout(sc.timer)
        try {
          typeof cleanup === 'function' && cleanup()
        } catch {}
        cleanup = null
        if (busy === sc.hold) busy = null
      }
      sc.stop = stop
      sc.hold = { cancel: stop, playState: 'running' }
      busy = sc.hold
      sc.timer = setTimeout(() => {
        if (stopped || caughtScene !== sc) return
        // Then you are back: it jumps, the prop goes away, and it acts as if nothing happened.
        emote('surprised')
        feel('worried', 0.2)
        try {
          typeof cleanup === 'function' && cleanup()
        } catch {}
        cleanup = null
        bob.animate(at([t(0, 0), t(0, -16, 0, 0.9, 1.14), t(0, -16, 0, 0.9, 1.14), t(0, 0, 0, 1.06, 0.92), t(0, 0)], [0, 0.2, 0.38, 0.62, 1]), { duration: 900, composite: 'add', easing: 'ease-out' })
        ears(at(deg(0, -16, -16, 0), [0, 0.2, 0.7, 1]), 1400)
        sound('star', 0.04)
        sc.timer = setTimeout(() => {
          if (stopped || caughtScene !== sc) return
          // Flustered: little marks, rocks side to side as if hands were behind its back.
          for (let i = 0; i < 3; i++) later(i * 220, () => floatUp(SIGNS.blush[0], SIGNS.blush[1], { x: spot.x + BOX * 0.1 + i * BOX * 0.34, y: spot.y + BOX * 0.15 + (i % 2) * 8, rise: 16, ms: 1400 }))
          bob.animate([t(0, 0), t(-3, 0, -8), t(3, 0, 8), t(-3, 0, -8), t(3, 0, 8), t(0, 0)], { duration: 1800, composite: 'add' })
          later(500, () => say(pick(L.caught), { force: true }))
          sc.timer = setTimeout(() => {
            if (caughtScene !== sc) return
            stop()
            // The usual welcome, but quiet: it has already jumped and spoken.
            if (!stopped && mode === 'home') {
              sparkle(6)
              sound('welcome', 0.04, 0.11)
              feel('happy', 0.4)
              mood.bored = 0
            }
          }, 2300)
        }, 1100)
      }, 1300)
      return true
    }

    // ---------- nuzzle (opt-in): the pointer rests on it for a moment and it leans in to rub against it ----------
    const NUZZLE = cfg.nuzzle && typeof cfg.nuzzle === 'object' ? cfg.nuzzle : {} // on/off: on('nuzzle')
    let nuzzleTimer = 0
    let nuzzleAt = -Infinity
    let restAt = null
    const nuzzle = (force = false) => {
      if (!force && (!free() || busy || performance.now() - nuzzleAt < (NUZZLE.cooldown ?? 90000) || !pointer || petFlips > 1)) return false
      if (stopped || mode !== 'home') return false
      nuzzleAt = performance.now()
      const c = center()
      const dx = (pointer?.x ?? c.x) - c.x
      const dy = (pointer?.y ?? c.y) - c.y
      const d = Math.sign(dx) || 1
      const lean = Math.min(11, 5 + Math.abs(dx) / 5)
      const up = Math.max(-5, Math.min(5, dy / 6))
      // Leans a long way toward it, rubs back and forth three times, eyes closed in contentment.
      act(at([t(0, 0), t(d * lean, up + 2, d * 18, 1.08, 0.95), t(d * (lean - 3), up, d * 10, 1.06, 0.97), t(d * (lean + 2), up + 1, d * 22, 1.08, 0.95), t(d * (lean - 3), up, d * 10, 1.06, 0.97), t(d * (lean + 2), up + 1, d * 22, 1.08, 0.95), t(d * (lean - 2), up, d * 12), t(d * (lean - 2), up, d * 12), t(0, 0)], [0, 0.14, 0.28, 0.4, 0.52, 0.64, 0.74, 0.88, 1]), 3000)
      ears(at(deg(0, -d * 14, -d * 14, 0), [0, 0.18, 0.8, 1]), 3000)
      setFace('happy', 3100)
      const hx = c.x + d * BOX * 0.53 * size
      floatUp('♡', C.heart, { x: hx - 8, y: spot.y - 4 * size, rise: 40, ms: 2400, px: 30 + 4 * size })
      later(700, () => floatUp('♡', C.heart, { x: hx + 8, y: spot.y + 4 * size, rise: 34, ms: 2000, px: 20 + 3 * size }))
      sound('pet', 0.04)
      feel('happy', 0.3)
      touched()
      return true
    }
    // The pointer must have been still on it for `after` ms, and not be rubbing it (petting is its own thing).
    const onRest = (e) => {
      if (mode !== 'home' || drag || e.buttons || !on('nuzzle')) return
      if (restAt && Math.hypot(e.clientX - restAt.x, e.clientY - restAt.y) < 3) return
      restAt = { x: e.clientX, y: e.clientY }
      clearTimeout(nuzzleTimer)
      nuzzleTimer = setTimeout(() => !stopped && petFlips === 0 && nuzzle(), NUZZLE.after ?? 2500)
    }
    const offRest = () => {
      clearTimeout(nuzzleTimer)
      restAt = null
    }
    home.addEventListener('pointermove', onRest)
    home.addEventListener('pointerleave', offRest)
    home.addEventListener('pointerdown', offRest)
    reactions.nuzzle ??= () => nuzzle(true)

    // ---------- read-along (opt-in): on a Markdown tab it leans toward the editor and nods as it reads ----------
    // A `glasses` part in the drawing (hidden otherwise) goes on for the while. Comes off when the tab
    // changes, it is moved or put to sleep, or it has read for `for` ms.
    const READ = cfg.readAlong && typeof cfg.readAlong === 'object' ? cfg.readAlong : {} // on/off: on('read')
    for (const el of parts('glasses')) el.style.opacity = '0'
    let reading = null
    let lastRead = -Infinity
    const activeTab = frontTab
    const tabTitle = (tab) => tab?.getAttribute('data-tab-title') ?? tab?.textContent ?? ''
    const endReading = () => {
      if (!reading) return
      const r = reading
      reading = null
      clearTimeout(r.timer)
      r.anims.forEach((a) => a.cancel())
      lookEyes()
      for (const el of parts('glasses')) el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-7px)' }], { duration: 320 }).onfinish = () => (el.style.opacity = '0')
      if (busy === r.hold) busy = null
      // Looks up from the page with a small hop of relief.
      if (!stopped && mode === 'home' && !drag) bob.animate([t(0, 0), t(0, -5, 0, 0.97, 1.05), t(0, 0)], { duration: 500, composite: 'add', easing: 'ease-out' })
    }
    const read = (force = false) => {
      if (reading) return true
      const tab = activeTab()
      if (!force && (!on('read') || !free() || busy || !tab || !isReadable(tabTitle(tab)) || Date.now() - lastRead < (READ.every ?? 8 * 60000) / freq('read') || Date.now() - lastActive > 90000 || Math.random() > (READ.chance ?? 0.5))) return false
      if (!free()) return false
      lastRead = Date.now()
      // The editor on screen: another worktree's editors stay mounted with a zero-size box.
      const r = [...document.querySelectorAll('.monaco-editor, .markdown-body, [data-testid="markdown-preview"]')].map(visibleRect).find(Boolean)
      const dir = r ? Math.sign(r.left + r.width / 2 - center().x) || 1 : 1
      const rd = (reading = { tab, anims: [], timer: 0, until: Date.now() + (READ.for ?? 45000), hold: null })
      rd.hold = { cancel: endReading, playState: 'running' }
      busy?.cancel()
      busy = rd.hold
      for (const el of parts('glasses')) {
        el.style.opacity = ''
        el.animate([{ opacity: 0, transform: 'translateY(-6px) scale(1.15)' }, { opacity: 1, transform: 'translateY(1px) scale(1)', offset: 0.6 }, { opacity: 1, transform: 'none' }], { duration: 650, easing: 'ease-out' })
      }
      rd.anims.push(
        bob.animate([t(0, 0), t(dir * 3, -3, dir * 4), t(dir * 4, 3, dir * 12, 1.02, 0.97)], { duration: 1100, delay: 500, easing: 'ease-in-out', fill: 'forwards', composite: 'add' }),
        // Slow, absorbed nodding as it reads on.
        bob.animate([{ transform: 'rotate(0deg)' }, { transform: `rotate(${dir * 3}deg)` }], { duration: 1500, delay: 1700, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', composite: 'add' })
      )
      sparkle(5, BOX * 0.4)
      lookEyes(dir * 2, 1.2)
      later(1500, () => reading === rd && floatUp('…', C.calm, { x: center().x + BOX * 0.25 * size, y: center().y - BOX * 0.56 * size, rise: 20, ms: 2200 }))
      return true
    }
    const readTick = () => {
      if (stopped) return
      if (reading) {
        const tab = activeTab()
        if (tab !== reading.tab || !isReadable(tabTitle(tab)) || mode !== 'home' || drag || document.hidden || Date.now() > reading.until) endReading()
      } else if (on('read')) read()
    }
    const readTimer = setInterval(readTick, 4000)

    // ---------- lantern (opt-in): lit the first time it is home after `from` o'clock, kept through the evening ----------
    // Also across reloads (the day it was lit is in the bond), put out at the `until` o'clock day roll.
    const LANTERN = cfg.lantern && typeof cfg.lantern === 'object' ? cfg.lantern : {} // on/off: on('lantern')
    const LANTERN_SVG =
      LANTERN.svg ??
      '<svg viewBox="0 0 24 36" width="100%" height="100%" style="overflow:visible"><path d="M12 1v5" stroke="#b08a4a" stroke-width="1.6" stroke-linecap="round"/><path d="M6 7h12l-1.5 3h-9z" fill="#8a4b2a"/><path d="M7 10h10c1.6 4.5 1.6 10 0 14.5H7C5.4 20 5.4 14.5 7 10z" fill="#ffd98a" stroke="#c9963f" stroke-width="1.1"/><path d="M12 14c2.2 2.6 2.2 5.6 0 8-2.2-2.4-2.2-5.4 0-8z" fill="#fff5d6"/><path d="M6.5 24.5h11l-1.5 3h-8z" fill="#8a4b2a"/><path d="M12 28v4" stroke="#b08a4a" stroke-width="1.4"/></svg>'
    let lantern = null
    const lanternDay = () => new Date(Date.now() - (LANTERN.until ?? 5) * 3600000).toLocaleDateString('sv') // the evening's day key: rolls at `until` o'clock
    const showLantern = (ceremony) => {
      if (lantern || stopped) return
      const left = center().x > innerWidth / 2 // keep it on the roomier side
      const W = BOX * 0.4
      const H = BOX * 0.62
      const box = prop(home, '', `${left ? 'right' : 'left'}:${BOX * 0.94}px;top:${BOX * 0.22}px;width:${W}px;height:${H}px`)
      const halo = prop(box, '', `left:${-W * 1.3}px;top:${-H * 0.6}px;width:${W * 3.6}px;height:${W * 3.6}px;border-radius:50%;background:radial-gradient(closest-side,color-mix(in srgb,${C.alert} 85%,transparent),color-mix(in srgb,${C.alert} 35%,transparent) 55%,transparent);opacity:0;mix-blend-mode:screen`)
      const body = prop(box, LANTERN_SVG, `left:0;top:0;width:${W}px;height:${H}px;transform-origin:50% 0;opacity:0`)
      const Lt = (lantern = { box, halo, body, anims: [] })
      if (T.reducedMotion?.()) {
        body.style.opacity = '1'
        halo.style.opacity = '.7'
        return
      }
      // The lighting below overlaps these loops, which parks them on the main thread; once it ends each
      // gets a composited copy (keepComposited). Nothing on body or halo holds a transform with fill: 'forwards'
      // while they loop: a loop hidden under one still costs a frame every frame.
      keepComposited(body, () => (lantern === Lt ? Lt.anims[0] : null), (a) => (Lt.anims[0] = a))
      keepComposited(halo, () => (lantern === Lt ? Lt.anims[1] : null), (a) => (Lt.anims[1] = a))
      Lt.anims.push(
        // Sways softly like a hanging lamp, and breathes a warm light.
        body.animate([{ transform: 'rotate(-5deg)' }, { transform: 'rotate(5deg)' }], { duration: 2600, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', delay: 700 }),
        halo.animate([{ opacity: 0.55, transform: 'scale(.94)' }, { opacity: 0.9, transform: 'scale(1.06)' }], { duration: 1800, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out', delay: 900 })
      )
      // Lights: the lantern rises into place from below, the flame catches, the glow blooms.
      body.animate([{ opacity: 0, transform: 'translateY(18px) scale(.6)' }, { opacity: 1, transform: 'translateY(-2px) scale(1.05)', offset: 0.7 }, { opacity: 1, transform: 'none' }], { duration: ceremony ? 900 : 400, easing: 'ease-out' })
      halo.animate([{ opacity: 0, transform: 'scale(.4)' }, { opacity: ceremony ? 1 : 0.7, transform: 'scale(1.15)', offset: 0.6 }, { opacity: 0.7, transform: 'scale(1)' }], { duration: ceremony ? 1500 : 600, delay: ceremony ? 700 : 0, easing: 'ease-out', fill: 'backwards' })
      body.style.opacity = '1'
      halo.style.opacity = '.7'
      if (ceremony) {
        sparkle(6, BOX * 0.53)
        sound('welcome', 0.04, 0.2)
        for (let i = 0; i < 3; i++) later(800 + i * 260, () => lantern === Lt && floatUp(i % 2 ? '✦' : '·', C.alert, { x: center().x + (left ? -1 : 1) * BOX * 0.62 * size, y: spot.y + 4 * size, rise: 26, ms: 1400 }))
      }
    }
    const hideLantern = (ceremony) => {
      if (!lantern) return
      const Lt = lantern
      lantern = null
      Lt.anims.forEach((a) => a.cancel())
      if (stopped || !ceremony || T.reducedMotion?.()) return Lt.box.remove()
      // Blows it out: the glow gasps and fades, a wisp goes up, the lantern sinks away.
      Lt.halo.animate([{ opacity: 0.8 }, { opacity: 1, offset: 0.12 }, { opacity: 0 }], { duration: 900, fill: 'forwards' })
      Lt.body.animate([{ opacity: 1, transform: 'none' }, { opacity: 1, transform: 'none', offset: 0.5 }, { opacity: 0, transform: 'translateY(14px) scale(.7)' }], { duration: 1400, fill: 'forwards', easing: 'ease-in' }).onfinish = () => Lt.box.remove()
      floatUp('~', C.dim, { x: center().x + (Lt.box.style.right ? -1 : 1) * BOX * 0.62 * size, y: spot.y + 4 * size, rise: 30, ms: 1500, px: 18 })
    }
    const lanternTick = (force = false) => {
      if (stopped) return
      if (!force && !on('lantern')) return void (lantern && hideLantern(false))
      const phase = force ? 'light' : lanternPhase({ hour: new Date().getHours(), day: lanternDay(), lit: bond.lanternDay, from: LANTERN.from ?? 18, until: LANTERN.until ?? 5 })
      if (phase === 'out') return void (lantern && hideLantern(!away()))
      if (phase === 'keep') return void (!lantern && mode !== 'hiding' && showLantern(false))
      if (!force && (away() || mode !== 'home' || drag)) return // lights it when it is home and you are here
      bond.lanternDay = lanternDay()
      saveBond()
      showLantern(true)
      if (mode === 'home') later(1200, () => say(pick(L.lantern), { force: true }))
    }
    const firstLantern = setTimeout(lanternTick, 6000)
    const lanternTimer = setInterval(lanternTick, 30000)

    // ---------- the settings panel's handle on it (companion_settings.js) ----------
    // preview(id, from) plays one row now, as it would happen, past its switch, chance and cooldown.
    // `from` is where the button is (the gaze preview looks there).
    const ready = () => {
      if (mode === 'following') stopFollow()
      if (mode === 'hiding') endSeek()
      if (mode === 'visiting') {
        knock?.cancel()
        knock = null
        visitingTab = null
        setMode('home', '試試看前清乾淨')
        place(homeSpot())
      }
      if (reading) endReading()
      caughtScene?.stop()
      wake()
      busy?.cancel()
      busy = null
      return mode === 'home' && !drag
    }
    const sideways = () => (center().x > innerWidth / 2 ? -1 : 1)
    let previewTurn = 0
    const previews = {
      gaze: (from) => {
        gazeAt = from ?? { x: innerWidth / 2, y: innerHeight / 2 }
        gaze()
        later(2600, () => ((gazeAt = null), gaze()))
      },
      pet: () => reactions.happy(api),
      nuzzle: () => nuzzle(true),
      seek: () => {
        if (!hide()) return false
        later(7000, () => mode === 'hiding' && comeHome(true))
      },
      drag: async () => {
        setMode('flying', '試試看拖曳')
        await flyTo(clamp({ x: spot.x + sideways() * 110, y: spot.y - 40 }), 900)
        await wait(500)
        if (stopped || mode !== 'flying') return
        await flyTo(homeSpot(), 900)
        if (stopped || mode !== 'flying') return
        setMode('home', '試試看拖曳結束')
        signature()
      },
      throw: () => throwIt(sideways() * 1.6, -0.9),
      wheel: () => bob.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.45)', offset: 0.35 }, { transform: 'scale(1.45)', offset: 0.6 }, { transform: 'scale(.8)', offset: 0.8 }, { transform: 'scale(1)' }], { duration: 1800, easing: 'ease-in-out', composite: 'add' }),
      follow: () => {
        toggleFollow()
        later(6000, () => mode === 'following' && stopFollow())
      },
      startle: () => startle(center().x + sideways() * -60),
      sway: () => {
        for (let i = 0; i < 8; i++)
          later(i * 190, () => {
            swaySide = -swaySide
            bob.animate([t(0, 0), t(swaySide * 2, -3, swaySide * 7, 1.03, 0.97), t(0, 0)], { duration: 300, easing: 'ease-out', composite: 'add' })
          })
      },
      comboGlow: () => {
        for (let i = 1; i <= 50; i++) later(i * 24, () => comboGlow(i))
      },
      words: () => play(['goodNews', 'thanks', 'sleepy', 'curious', ...(names.length ? ['name'] : [])][previewTurn++ % (names.length ? 5 : 4)]),
      puzzled,
      sing: () => play('sing'),
      gitCommit: () => play('gitCommit'),
      gitPush: () => play('gitPush'),
      idle: () => acts[(lastAct = pickAct())]?.(),
      wander: () => acts.wander?.(),
      mood: () => emote(topMood() || ['happy', 'curious', 'sleepy', 'bored', 'worried'][previewTurn++ % 5]),
      sleep: () => {
        sleep(true)
        sleepHold = Date.now() + 4800
        later(5000, wake)
      },
      blink: () => animateParts('eyes', [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.12)' }, { transform: 'scaleY(1)' }], { duration: 170, composite: 'add' }),
      toast: () => twirl(),
      read: () => {
        if (!read(true)) return false
        reading.until = Date.now() + 7000
      },
      lantern: () => {
        hideLantern(false)
        bond.lanternDay = ''
        lanternTick(true)
        later(6000, () => (hideLantern(true), later(1600, lanternTick)))
      },
      welcome: () => reactions.welcome?.(api),
      caught: () => caught(true),
      greet: () => (reactions.greet ?? greet)(api),
      milestones: () => (reactions.milestone ?? celebrate)(Math.max(1, bond.days), api),
      late: () => (emote('worried'), say(pick(L.late), { force: true })),
      vigil: () => {
        setVigil(true)
        later(6000, readStatus)
      },
      knock: () => {
        const tab = frontTab() ?? [...document.querySelectorAll(TAB)].find(shown) ?? document.querySelector(TAB)
        if (!tab) return false
        knockHold = Date.now() + 5500
        visit(tab)
        later(5600, () => mode === 'visiting' && visitingTab === tab && leaveVisit())
      },
      done: () => (twirl(), later(900, () => say(pick(L.done), { force: true }))),
      droop: () => droop(),
      // The sulk as it would happen, then (unless you pat it three times first) it comes round on its own.
      sulk: () => {
        if (!sulk(true)) return false
        later(9000, () => sulking?.preview && endSulk('consoled'))
      },
      speech: () => say(pick(L.idle) ?? pick(L.welcome), { force: true }),
      sound: () => sound('welcome', 0.05, 0.11),
      chime: () => sound('pet', 0.07, 0.1),
      song: () => play('sing'),
      name: () => say(CONFIG.withName(greetLine() ?? pick(L.welcome) ?? pick(L.idle), conf().you.name, true), { force: true })
    }
    const ownPreview = (rowId) => CONFIG.items(SECTIONS).find((i) => i.id === rowId)?.run
    const previewOf = (rowId) => ownPreview(rowId) ?? previews[rowId]
    // Settings changed (here or in another window): what is on screen follows them at once.
    // Only a switch that just went off (or the sleep timing) changes what is on screen; a preview, a
    // theme switch or another window's unrelated change leaves the pet alone.
    let seen = conf()
    if (seen.features.debugState) trace.sync(mode) // switched on before this window opened
    const refresh = () => {
      if (stopped || previewing()) return // picked up by the next change after the preview
      const was = seen
      const now = conf()
      if (now === was) return
      seen = now
      if (was.features.debugState !== now.features.debugState) trace.sync(mode)
      const wentOff = (f) => was.features[f] !== false && now.features[f] === false
      if (mode === 'following' && wentOff('follow')) stopFollow()
      if (mode === 'hiding' && wentOff('seek')) endSeek()
      if (reading && wentOff('read')) endReading()
      if (!canSpeak()) hush()
      if (playing && !canSound()) stopAudio(600)
      if (wentOff('sleep') || was.freq.sleep !== now.freq.sleep) {
        const at = lastActive
        wake() // wakes it, or re-times the next nap
        lastActive = at
      }
      if (wentOff('lantern')) lanternTick()
      if (sulking && wentOff('sulk')) endSulk('cancel')
      if (wentOff('vigil') || wentOff('knock')) readStatus()
    }
    addEventListener('orca-themer:state', refresh)
    const panel = {
      sections: SECTIONS,
      defaults: BASE,
      get: conf,
      has: (rowId) => Boolean(previewOf(rowId)),
      preview(rowId, from) {
        const fn = previewOf(rowId)
        if (stopped || !fn || !ready()) return false
        previewUntil = Date.now() + 4000 // long enough for its own delayed line or chime
        try {
          return fn(ownPreview(rowId) ? api : from) !== false
        } catch (error) {
          console.warn(`[companion ${id}] preview ${rowId} failed`, error)
          return false
        }
      },
      stats: () => ({ days: bond.days, pets: bond.pets || 0, met: bond.met, celebrated: bond.celebrated.length }),
      // Forgets the days together, the petting and the hours it learned; starts over today.
      forget() {
        if (sulking) endSulk('cancel')
        bond = { met: today(), days: 0, last: '', hours: Array(24).fill(0), celebrated: [], lateWarned: '', said: { date: today(), n: 0 }, pets: 0 }
        if (emo) emo = EM.create()
        setLow(false)
        meetToday()
        if (ready()) {
          emote('curious')
          acts.lookAround?.()
        }
      },
      setSize(n) {
        if (seek) return false
        size = Math.min(2.5, Math.max(0.5, Number(n) || 1))
        if (Math.abs(size - 1) < 0.04) size = 1
        place(clamp(spot))
        store(SIZE_KEY, String(size))
        return true
      },
      resetHome() {
        saved = null
        try {
          localStorage.removeItem(SPOT_KEY)
        } catch {}
        if (mode === 'home' && !drag) {
          roaming = false
          flyTo(homeSpot(), 900)
        }
      }
    }

    // ---------- what character files and dev tools can use ----------
    const api = {
      id,
      label: cfg.label ?? id,
      drawing: cfg.svg, // the SVG markup as given (the live svg has its moving parts lifted out)
      host,
      root: home,
      svg,
      parts,
      colors: C,
      mood,
      acts,
      reactions,
      get spot() {
        return { ...spot }
      },
      get size() {
        return size
      },
      get mode() {
        return mode
      },
      get busy() {
        return Boolean(busy)
      },
      center,
      act,
      t,
      at,
      feel,
      emote,
      sparkle,
      floatUp,
      setFace,
      say,
      lines: L,
      get bond() {
        return bond
      },
      chime: (freqs, gain = 0.05, gap) => S && canSound() && chime(freqs, gain * (S.gain ?? 1) * conf().sound.chime, gap),
      play,
      animateParts,
      openTab,
      // Your own audio (see "audio" above), and the opt-in behaviours, each callable now for a preview.
      asset,
      playAudio,
      stopAudio,
      sing,
      hide,
      found: () => Boolean(seek) && (comeHome(true), true),
      giveUp: () => Boolean(seek) && (comeHome(false), true),
      get hiding() {
        return seek && { spot: seek.spot, ducked: seek.ducked, bold: seekBold() }
      },
      seekSpots: () => SEEK.spots(measureSeek().rects, { w: innerWidth, h: innerHeight }),
      caught: (scene = true) => (wake(), busy?.cancel(), (busy = null), caught(scene)),
      nuzzle: () => nuzzle(true),
      // What an agent tab does to it, callable for a preview: the breathing glow while one works, the
      // sag when one fails (done is `play('twirl')`).
      vigil: (on = true) => (setVigil(on), true),
      droop: () => (droop(), true),
      read: (on = true) => (on ? read(true) : (endReading(), true)),
      get reading() {
        return Boolean(reading)
      },
      lantern: (on = true) => (on ? (hideLantern(false), (bond.lanternDay = ''), lanternTick(true), true) : (hideLantern(true), true)),
      get lit() {
        return Boolean(lantern)
      },
      // The settings panel (companion_settings.js) and your own acts: is a row on, how often (a multiplier).
      on,
      freq,
      get settings() {
        return conf()
      },
      panel,
      preview: (rowId, from) => panel.preview(rowId, from),
      // Its feelings (null with `emotion: false`): view() for the panel; event(kind) books one from your own
      // acts ('asked', 'ignored', 'played', 'fail', 'pass'...); set() puts a value where a threshold can be
      // watched; tick() runs the minute tick now; sulk()/consoled() play the sulk.
      emotion: emo
        ? {
            view: () => emo && EM.view(emo, Date.now(), EW, EF),
            event: (kind, arg) => {
              const tierBefore = EM.tierIndex(emo.aff)
              const ok = emoEvent(kind, arg)
              saveBond()
              applyFeelings(tierBefore)
              return ok
            },
            set: (part) => {
              for (const k of ['mood', 'aff', 'close', 'anx', 'lone']) if (typeof part?.[k] === 'number' && Number.isFinite(part[k])) emo[k] = Math.max(0, Math.min(100, part[k]))
              if (part?.sulkedToday === false) emo.today.sulked = false
              saveBond()
              return EM.view(emo, Date.now(), EW, EF)
            },
            tick: () => (emoTick(), EM.view(emo, Date.now(), EW, EF)),
            sulk: () => sulk(true),
            consoled: () => Boolean(sulking) && (endSulk('consoled'), true),
            get sulking() {
              return sulking ? { pets: sulking.pets, since: sulking.since, preview: sulking.preview } : null
            },
            get low() {
              return Boolean(low)
            }
          }
        : null
    }
    T.companions.set(id, api)
    meetToday()
    try {
      cfg.onStart?.(api)
    } catch (error) {
      console.warn(`[companion ${id}] onStart failed`, error)
    }

    return () => {
      stopped = true
      trace.stop()
      if (T.companions.get(id) === api) T.companions.delete(id)
      loops.forEach((a) => a.cancel())
      setVigil(false)
      knock?.cancel()
      dozing?.cancel()
      release()
      cancelAnimationFrame(flightRaf)
      cancelAnimationFrame(followRaf)
      cancelAnimationFrame(gazeQueued)
      clearTimeout(gazeTimer)
      cancelAnimationFrame(statusQueued)
      for (const timer of [faceTimer, glowTimer, sleepTimer, zTimer, clickTimer, idleTimer, blinkTimer, petReset, landTimer, welcomeTimer, nuzzleTimer, firstLantern]) clearTimeout(timer)
      for (const timer of [reposition, moodTimer, statusTimer, bondTimer, readTimer, lanternTimer, emoTimer]) clearInterval(timer)
      clearTimeout(meetTimer)
      clearTimeout(emoFirst)
      clearTimeout(sulking?.timer)
      endSeek(false)
      stopSing()
      stopAudio()
      caughtScene?.stop()
      endReading()
      hideLantern(false)
      hush()
      saveBond()
      toasts.disconnect()
      statusObserver.disconnect()
      removeEventListener('resize', onResize)
      removeEventListener('orca-themer:state', refresh)
      removeEventListener('orca-themer:combo', onCombo)
      removeEventListener('blur', onLeave)
      removeEventListener('focus', onBack)
      document.removeEventListener('visibilitychange', onBack)
      removeEventListener('pointermove', onFollowMove, true)
      removeEventListener('contextmenu', onRightFollow, true)
      removeEventListener('pointermove', onPointer, { capture: true })
      removeEventListener('keydown', onTypeSway, { capture: true })
      removeEventListener('compositionupdate', onTypeSway, { capture: true })
      removeEventListener('keydown', onTypedChar, { capture: true })
      removeEventListener('compositionend', onTypedIme, { capture: true })
      removeEventListener('keydown', hushAudio, true)
      removeEventListener('pointerdown', hushAudio, true)
      document.removeEventListener('visibilitychange', hushAudio)
      for (const ev of activity) removeEventListener(ev, wake, { capture: true })
      try {
        cfg.onStop?.(api)
      } catch {}
      home.remove()
      if (!T.companions.size) host.remove() // leftover sparkles go with it
    }
  }
})()
