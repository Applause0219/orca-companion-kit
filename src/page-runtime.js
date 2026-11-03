// Runs inside every Orca window (main world), injected before the page's own scripts.
// Owns one <style> kept last in <head>, the Ctrl+Alt+T picker, and theme "touches" (small JS effects:
// window.__orcaThemer.registerTouch(id, { label, description, start() { ...; return stop } })).
// Talks to the launcher through the CDP binding `orcaThemerSend`; the launcher calls `__orcaThemer.*`.
;(() => {
  if (window.__orcaThemer) return

  const STYLE_ID = 'orca-themer-style'
  const PICKER_ID = 'orca-themer-picker'
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches
  const touches = new Map() // id -> { start(ctx) -> stop }
  const running = new Map() // id -> stop
  const touchErrors = [] // { id, error } for touches whose start() threw
  const pickerItems = new Map() // id -> { label, sub, when?, run }: extra rows (a pet's settings panel)
  let overlay = null // a panel opened from the picker: { isOpen, close }; Ctrl+Alt+T closes it
  // The picker shortcut as macOS writes it (Control+Option+T), where the picker and notices name it.
  const MAC = /Mac/.test(globalThis.navigator?.platform ?? '')
  // Pet settings changed in this window and not yet echoed back by the launcher: id -> { json, at }.
  // A broadcast sent before the launcher saw them carries older values and must not undo them.
  const pendingCompanions = new Map()
  let state = { themes: [], snippets: [], themeId: null, enabledSnippets: [], enabledTouches: [] }
  let css = ''
  // The typing diagnosis switches these off for a few seconds at a time to compare.
  const suspended = { css: false, touches: false }

  function send(message) {
    try {
      window.orcaThemerSend?.(JSON.stringify(message))
    } catch {}
  }

  function styleElement() {
    let el = document.getElementById(STYLE_ID)
    if (!el) {
      el = document.createElement('style')
      el.id = STYLE_ID
    }
    const head = document.head
    if (head && head.lastElementChild !== el) head.appendChild(el)
    else if (!head && !el.isConnected) document.documentElement.appendChild(el)
    return el
  }

  // Why an observer: Orca adds lazy chunk stylesheets later; ours must stay last to win ties.
  const headObserver = new MutationObserver(() => {
    const el = document.getElementById(STYLE_ID)
    if (el && document.head && document.head.lastElementChild !== el) document.head.appendChild(el)
  })

  // Why: a page switching light/dark in place fires no event we can hook, and may rewrite <head> or the
  // root's style/class so our sheet is lost or loses its place. Re-apply under the same id (remove every
  // copy, then add one) but only when the scheme itself changed, so ordinary class toggles cost nothing.
  const schemeKey = () => {
    const html = document.documentElement
    const meta = document.querySelector?.('meta[name="color-scheme"]')
    return [meta?.getAttribute?.('content') ?? '', html?.style?.colorScheme ?? '', !!html?.classList?.contains('dark'), !!html?.classList?.contains('light')].join('|')
  }
  let lastScheme = null
  function reapplyTheme() {
    let el
    while ((el = document.getElementById(STYLE_ID))) el.remove()
    if (css) styleElement().textContent = suspended.css ? '' : css
  }
  const schemeObserver = new MutationObserver(() => {
    const key = schemeKey()
    if (key === lastScheme) return
    lastScheme = key
    reapplyTheme()
  })
  function observeScheme() {
    lastScheme ??= schemeKey()
    schemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    schemeObserver.observe(document.head, { childList: true, subtree: true, attributes: true, attributeFilter: ['content', 'name'] })
  }

  function whenReady(fn) {
    if (document.head && document.body) fn()
    else document.addEventListener('DOMContentLoaded', fn, { once: true })
  }

  function syncTouches() {
    // Only touches the current theme declares may run; switching themes stops the rest.
    const declared = state.themes.find((t) => t.id === state.themeId)?.touches ?? []
    const wanted = new Set(reducedMotion() || suspended.touches ? [] : state.enabledTouches.filter((id) => declared.includes(id)))
    for (const [id, stop] of running) {
      if (!wanted.has(id)) {
        try {
          stop?.()
        } catch {}
        running.delete(id)
      }
    }
    for (const id of wanted) {
      const touch = touches.get(id)
      if (touch && !running.has(id)) {
        try {
          running.set(id, touch.start() ?? null)
        } catch (error) {
          console.warn('[orca-themer] touch failed', id, error)
          send({ type: 'log', message: `touch ${id} failed to start: ${error?.stack ?? error}` })
          // Read by the launcher's checkup after an Orca update.
          touchErrors.push({ id, error: String(error?.stack ?? error).slice(0, 300) })
        }
      }
    }
  }

  const UI_CSS = `
#${PICKER_ID}{position:fixed;inset:0;z-index:2147483000;pointer-events:auto;display:grid;place-items:start center;padding-top:12vh;font:13px/1.45 var(--app-font-family,system-ui)}
#${PICKER_ID} .otp-scrim{position:absolute;inset:0;background:color-mix(in srgb,var(--background) 55%,transparent);backdrop-filter:blur(2px)}
#${PICKER_ID} .otp-panel{position:relative;width:min(420px,calc(100vw - 32px));max-height:70vh;display:flex;flex-direction:column;background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);border-radius:12px;box-shadow:0 24px 64px -12px rgb(0 0 0/.55);overflow:hidden;transform-origin:50% 0;animation:otp-in .18s cubic-bezier(.2,.8,.2,1)}
#${PICKER_ID}[data-closing] .otp-panel{animation:otp-out .14s ease-in forwards}
#${PICKER_ID} .otp-head{display:flex;justify-content:space-between;align-items:center;padding:12px 14px 8px;font-weight:600}
#${PICKER_ID} kbd{font:11px var(--font-mono,ui-monospace,monospace);color:var(--muted-foreground);border:1px solid var(--border);border-radius:4px;padding:1px 6px}
#${PICKER_ID} .otp-list{overflow:auto;padding:0 6px 6px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--muted-foreground) 40%,transparent) transparent}
#${PICKER_ID} .otp-section{padding:10px 8px 4px;font-size:11px;letter-spacing:.04em;color:var(--muted-foreground)}
#${PICKER_ID} .otp-row{all:unset;box-sizing:border-box;display:flex;gap:10px;align-items:center;width:100%;padding:8px;border-radius:8px;cursor:pointer}
#${PICKER_ID} .otp-row:hover,#${PICKER_ID} .otp-row:focus-visible{background:var(--accent);color:var(--accent-foreground)}
#${PICKER_ID} .otp-row:focus-visible{outline:2px solid var(--ring);outline-offset:-2px}
#${PICKER_ID} .otp-mark{flex:none;width:14px;height:14px;border-radius:50%;border:1.5px solid var(--muted-foreground);transition:background .15s,border-color .15s,box-shadow .15s}
#${PICKER_ID} .otp-row[data-kind]:not([data-kind=theme]) .otp-mark{border-radius:4px}
#${PICKER_ID} .otp-row[data-kind=action] .otp-mark{border:0;border-radius:0;width:14px;text-align:center;line-height:14px;font-size:13px;color:var(--muted-foreground)}
#${PICKER_ID} .otp-row[data-kind=action] .otp-mark::before{content:'›'}
#${PICKER_ID} .otp-row[aria-checked=true] .otp-mark{border-color:var(--primary);background:var(--primary);box-shadow:inset 0 0 0 2.5px var(--popover)}
#${PICKER_ID} .otp-text{display:flex;flex-direction:column;min-width:0}
#${PICKER_ID} .otp-sub{font-size:11.5px;color:var(--muted-foreground);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#otp-notice{position:fixed;left:50%;bottom:28px;z-index:2147483000;translate:-50% 0;max-width:min(560px,calc(100vw - 32px));padding:9px 16px;border-radius:999px;background:var(--popover);color:var(--popover-foreground);border:1px solid var(--border);box-shadow:0 12px 32px -8px rgb(0 0 0/.5);font:12.5px/1.45 var(--app-font-family,system-ui);animation:otp-in .18s cubic-bezier(.2,.8,.2,1)}
#${PICKER_ID} .otp-foot{padding:8px 14px 10px;font-size:11px;color:var(--muted-foreground);border-top:1px solid var(--border)}
@keyframes otp-in{from{opacity:0;transform:translateY(-6px) scale(.98)}}
@keyframes otp-out{to{opacity:0;transform:translateY(-4px) scale(.98)}}
@media (prefers-reduced-motion:reduce){#${PICKER_ID} .otp-panel{animation:none!important}}`

  function ensureUiStyle() {
    if (document.getElementById('orca-themer-ui')) return
    const el = document.createElement('style')
    el.id = 'orca-themer-ui'
    el.textContent = UI_CSS
    document.head.prepend(el)
  }

  function apply(next) {
    state = { ...state, ...next.state }
    if (next.state?.companions && pendingCompanions.size) {
      const merged = { ...next.state.companions }
      for (const [id, p] of pendingCompanions) {
        if (JSON.stringify(merged[id] ?? null) === p.json || Date.now() - p.at > 10000) pendingCompanions.delete(id)
        else merged[id] = JSON.parse(p.json)
      }
      state.companions = merged
    }
    css = next.css ?? css
    whenReady(() => {
      ensureUiStyle()
      styleElement().textContent = suspended.css ? '' : css
      headObserver.observe(document.head, { childList: true })
      observeScheme()
      document.documentElement.dataset.orcaTheme = state.themeId ?? ''
      syncTouches()
      renderPicker()
      dispatchEvent(new CustomEvent('orca-themer:state'))
    })
  }

  // ---------- picker ----------
  function renderPicker() {
    const root = document.getElementById(PICKER_ID)
    if (!root) return
    const list = root.querySelector('[data-list]')
    list.replaceChildren()
    const section = (title) => {
      const h = document.createElement('div')
      h.className = 'otp-section'
      h.textContent = title
      list.appendChild(h)
    }
    const row = (label, sub, checked, onPick, kind) => {
      const b = document.createElement('button')
      b.className = 'otp-row'
      b.dataset.kind = kind
      b.setAttribute('role', kind === 'theme' ? 'radio' : kind === 'action' ? 'button' : 'checkbox')
      if (kind !== 'action') b.setAttribute('aria-checked', String(checked))
      b.innerHTML = '<span class="otp-mark"></span><span class="otp-text"><span class="otp-label"></span><span class="otp-sub"></span></span>'
      b.querySelector('.otp-label').textContent = label
      b.querySelector('.otp-sub').textContent = sub ?? ''
      b.addEventListener('click', onPick)
      list.appendChild(b)
    }
    section('主題')
    row('Orca 原色', '不套任何主題', !state.themeId, () => send({ type: 'select-theme', id: null }), 'theme')
    for (const t of state.themes)
      row(t.name, t.description || t.author, state.themeId === t.id, () => send({ type: 'select-theme', id: t.id }), 'theme')
    if (state.snippets.length) {
      section('片段')
      for (const s of state.snippets)
        row(s.name, s.description, state.enabledSnippets.includes(s.id), () => send({ type: 'toggle-snippet', id: s.id }), 'snippet')
    }
    const available = state.themes.find((t) => t.id === state.themeId)?.touches ?? []
    if (available.length) {
      section(reducedMotion() ? '小巧思（系統設定減少動態，已暫停）' : '小巧思')
      for (const id of available) {
        const t = touches.get(id)
        row(t?.label ?? id, t?.description, state.enabledTouches.includes(id), () => send({ type: 'toggle-touch', id }), 'touch')
      }
    }
    const extras = [...pickerItems.values()].filter((item) => {
      try {
        return item.when?.() ?? true
      } catch {
        return false
      }
    })
    if (extras.length) {
      section('設定')
      for (const item of extras)
        row(item.label, item.sub, false, () => {
          closePicker()
          item.run()
        }, 'action')
    }
    if (lag || diagnosis) {
      section('效能')
      if (diagnosis?.running) row('正在量打字延遲…', '照常打字就好，30 秒到 1 分鐘', false, () => {}, 'perf')
      else if (diagnosis?.verdict) row(diagnosis.verdict, diagnosis.numbers, false, startDiagnosis, 'perf')
      else row(`最近打字偏慢（多數按鍵超過 ${LAG_MS} ms）`, '按這裡找原因：輪流關掉主題各部分，比較延遲', false, startDiagnosis, 'perf')
    }
    const first = list.querySelector('[aria-checked="true"]') ?? list.querySelector('button')
    if (root.dataset.justOpened) {
      delete root.dataset.justOpened
      first?.focus()
    }
  }

  function closePicker() {
    const root = document.getElementById(PICKER_ID)
    if (!root) return
    root.dataset.closing = ''
    const done = () => root.remove()
    if (reducedMotion()) done()
    else setTimeout(done, 140)
  }

  function openPicker() {
    if (document.getElementById(PICKER_ID)) return closePicker()
    const root = document.createElement('div')
    root.id = PICKER_ID
    root.dataset.justOpened = ''
    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', '主題')
    root.innerHTML = `
      <div class="otp-scrim" data-close></div>
      <div class="otp-panel">
        <div class="otp-head"><span>外觀</span><kbd>${MAC ? '⌃⌥T' : 'Ctrl Alt T'}</kbd></div>
        <div class="otp-list" data-list></div>
        <div class="otp-foot">主題在 ~/.orca/themer/themes、小巧思在 ~/.orca/themer/touches，存檔就會即時套用</div>
      </div>`
    root.querySelector('[data-close]').addEventListener('click', closePicker)
    // No Esc here: Esc belongs to Claude Code in the terminal. Ctrl+Alt+T again, the scrim or a pick closes it.
    root.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const items = [...root.querySelectorAll('.otp-row')]
        const i = items.indexOf(document.activeElement)
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
        e.preventDefault()
      }
    })
    document.body.appendChild(root)
    renderPicker()
    // After the open animation, so the launcher's one-off lookup does not cost it a frame.
    setTimeout(() => send({ type: 'picker-open' }), 250)
  }

  addEventListener(
    'keydown',
    (e) => {
      // e.code too: on macOS, Option changes the character a key types ('†' for T on a US layout).
      if (e.ctrlKey && e.altKey && !e.shiftKey && (e.key === 't' || e.key === 'T' || e.code === 'KeyT')) {
        e.preventDefault()
        e.stopPropagation()
        // The same shortcut closes a panel opened from the picker (a pet's settings).
        if (overlay?.isOpen?.()) return overlay.close()
        openPicker()
      }
    },
    true
  )

  // ---------- typing latency ----------
  // Event Timing says, per keystroke, how long until a frame showed it; watching costs nothing. A theme
  // rule once made every keystroke take ~800 ms (a page-wide ::selection), and only typing showed it.
  const LAG_MS = 200
  const strokes = [] // timeStamps of the last 40 keydowns
  const slowAt = new Map() // keydown timeStamp -> duration, for the ones the observer reported
  let lag = false
  let diagnosis = null // { running } | { verdict, numbers }
  let lagNoticeAt = 0
  let sample = null // set while diagnosing: collects [config, duration]

  function notice(text, ms = 7000) {
    document.getElementById('otp-notice')?.remove()
    const el = document.createElement('div')
    el.id = 'otp-notice'
    el.setAttribute('role', 'status')
    el.textContent = text
    document.body.appendChild(el)
    setTimeout(() => el.remove(), ms)
  }

  addEventListener('keydown', (e) => {
    strokes.push(e.timeStamp)
    if (strokes.length > 40) slowAt.delete(strokes.shift())
  }, { capture: true, passive: true })
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.name === 'keydown') slowAt.set(e.startTime, e.duration)
      if (strokes.length < 40 || diagnosis?.running) return
      // Keystrokes the observer skipped were faster than its 16 ms floor.
      const slow = strokes.filter((t) => (slowAt.get(t) ?? 0) > LAG_MS).length
      lag = slow >= strokes.length / 2
      if (lag && Date.now() - lagNoticeAt > 3600000) {
        lagNoticeAt = Date.now()
        notice(`打字變慢了。按 ${MAC ? '⌃⌥T' : 'Ctrl+Alt+T'}，在「效能」可以找原因`)
        send({ type: 'log', message: `slow typing: ${slow}/${strokes.length} keystrokes over ${LAG_MS} ms` })
      }
    }).observe({ type: 'event', durationThreshold: 16 })
  } catch {}

  // Rotates full theme / no CSS / no touches every 3 s while you type, then compares medians.
  function startDiagnosis() {
    if (diagnosis?.running) return
    closePicker()
    diagnosis = { running: true }
    const configs = [['full', false, false], ['noCss', true, false], ['noTouches', false, true]]
    const got = { full: [], noCss: [], noTouches: [] }
    let current = 'full'
    let k = 0
    const set = ([name, noCss, noTouches]) => {
      current = name
      suspended.css = noCss
      suspended.touches = noTouches
      styleElement().textContent = noCss ? '' : css
      syncTouches()
    }
    const pending = new Map() // timeStamp -> config at that keystroke
    let newest = 0 // startTime of the latest entry the observer delivered
    const onKey = (e) => pending.set(e.timeStamp, current)
    addEventListener('keydown', onKey, { capture: true, passive: true })
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        newest = Math.max(newest, e.startTime)
        if (e.name === 'keydown' && pending.has(e.startTime)) got[pending.get(e.startTime)].push(e.duration), pending.delete(e.startTime)
      }
    })
    observer.observe({ type: 'event', durationThreshold: 16 })
    notice('照常打字 30 秒到 1 分鐘，畫面會輪流變回原色，量完會告訴你', 6000)
    set(configs[0])
    const started = Date.now()
    const timer = setInterval(() => {
      // Entries come in order: a keystroke older than one already reported, and not reported itself, was under 16 ms.
      // (A slow page delivers entries late, so age alone would count slow keystrokes as fast.)
      for (const [t, name] of pending) if (t < newest) got[name].push(16), pending.delete(t)
      const enough = Object.values(got).every((v) => v.length >= 15)
      if ((enough && Date.now() - started > 18000) || Date.now() - started > 60000) {
        clearInterval(timer)
        set(['full', false, false])
        return setTimeout(finish, 1500) // let late entries arrive
      }
      set(configs[++k % configs.length])
    }, 3000)
    function finish() {
      for (const [t, name] of pending) if (t < newest) got[name].push(16)
      observer.disconnect()
      removeEventListener('keydown', onKey, { capture: true })
      set(['full', false, false])
      const med = (v) => (v.length ? Math.round([...v].sort((a, b) => a - b)[v.length >> 1]) : null)
      const m = { full: med(got.full), noCss: med(got.noCss), noTouches: med(got.noTouches) }
      const numbers = `中位數：全開 ${m.full ?? '–'} ms、關 CSS ${m.noCss ?? '–'} ms、關小巧思 ${m.noTouches ?? '–'} ms`
      let verdict
      if (m.full == null || m.noCss == null || m.noTouches == null) verdict = '打字太少，量不出來（按這裡再量一次）'
      else if (m.full <= LAG_MS) verdict = '現在不慢'
      else if (m.noCss < m.full / 2) verdict = '主題 CSS 讓打字變慢'
      else if (m.noTouches < m.full / 2) verdict = '小巧思讓打字變慢'
      else verdict = '不是主題造成的：關掉也一樣慢'
      diagnosis = { verdict, numbers }
      lag = false
      notice(`${verdict}。${numbers}`, 12000)
      send({ type: 'log', message: `typing diagnosis: ${verdict}; ${numbers}` })
      renderPicker()
    }
  }

  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => syncTouches())

  window.__orcaThemer = {
    apply,
    openPicker,
    // The launcher is about to reload this window: close the picker and say why, then resolve once that
    // frame is painted (Chromium keeps showing it until the reloaded page paints).
    beforeReload(text) {
      document.getElementById(PICKER_ID)?.remove()
      if (text && document.body) notice(text, 15000)
      return new Promise((resolve) => {
        setTimeout(resolve, 300)
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      })
    },
    // Registering an id again (a touch file was saved) stops the old version and starts the new one.
    registerTouch(id, touch) {
      if (running.has(id)) {
        try {
          running.get(id)?.()
        } catch {}
        running.delete(id)
      }
      touches.set(id, touch)
      syncTouches()
    },
    // A touch that only sets html[data-orca-touch-<id>] while it is on; the theme CSS keys on that attribute.
    registerAttrTouch(id, { label, description } = {}) {
      this.registerTouch(id, {
        label,
        description,
        start() {
          document.documentElement.setAttribute(`data-orca-touch-${id}`, '')
          return () => document.documentElement.removeAttribute(`data-orca-touch-${id}`)
        }
      })
    },
    // A row in the picker's 「設定」 section: { id, label, sub, when?: () => boolean, run }.
    registerPickerItem(item) {
      if (item?.id) pickerItems.set(item.id, item)
    },
    unregisterPickerItem(id) {
      pickerItems.delete(id)
    },
    setOverlay(next) {
      overlay = next
    },
    send,
    // A change made in this window shows at once; the launcher saves it and its broadcast follows.
    updateState(patch) {
      const before = state.companions ?? {}
      for (const [id, config] of Object.entries(patch?.companions ?? {}))
        if (config !== before[id]) pendingCompanions.set(id, { json: JSON.stringify(config ?? null), at: Date.now() })
      state = { ...state, ...patch }
      dispatchEvent(new CustomEvent('orca-themer:state'))
    },
    reducedMotion,
    log: (message) => send({ type: 'log', message: String(message) }),
    get state() {
      return state
    },
    get touchErrors() {
      return touchErrors.slice()
    },
    // The launcher's one summary after an Orca update, shown only when something stopped working.
    checkupNotice(text) {
      whenReady(() => notice(text, 30000))
    }
  }
  send({ type: 'hello', url: location.href })
})()
