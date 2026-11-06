// The companion's pure rules (T.companionRules): where it may hide, which sent lines are a git commit or
// push, which tabs are worth reading along with, when the lantern is lit, and the built-in words. They
// take no DOM, so they are walked here with fixed rects, sample lines and a seeded random.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const REPO = path.resolve(import.meta.dirname, '..')
const ctx = { window: { __orcaThemer: { registerTouch() {} } } }
vm.createContext(ctx)
vm.runInContext(fs.readFileSync(path.join(REPO, 'src', 'touches', 'companion.js'), 'utf8'), ctx)
const { seek, gitMoment, isReadable, lanternPhase, defaultWords, missing, stateTrace } = ctx.window.__orcaThemer.companionRules
const { spots, pick, OUT, ROT } = seek

// A small repeatable random (mulberry32).
const seeded = (n) => () => {
  n = (n + 0x6d2b79f5) | 0
  let t = Math.imul(n ^ (n >>> 15), 1 | n)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const R = (left, top, right, bottom) => ({ left, top, right, bottom })
const view = { w: 1600, h: 900 }
// Roughly Orca: worktree sidebar on the left, tab strip on top, two terminal panes split by a divider,
// the file tree on the right, the status bar at the bottom, one toast.
const orca = {
  tabs: R(280, 40, 1300, 76),
  sidebar: R(0, 40, 280, 874),
  files: R(1300, 40, 1600, 874),
  status: R(0, 874, 1600, 900),
  panes: [R(280, 76, 790, 874), R(800, 76, 1300, 874)],
  dividers: [{ rect: R(790, 76, 800, 874), vertical: true }],
  toasts: [R(1180, 760, 1536, 820)]
}

test('seek: every kind of spot is offered, each on its own edge, facing out of it', () => {
  const all = spots(orca, view, seeded(1))
  const names = new Set(all.map((s) => s.name))
  for (const n of ['tabs', 'sidebar', 'files', 'status', 'pane', 'divider', 'toast', 'window']) assert.ok(names.has(n), n)
  const by = (n) => all.filter((s) => s.name === n)
  for (const s of by('tabs')) assert.deepEqual([s.y, s.dir], [76, 'down'])
  for (const s of by('sidebar')) assert.deepEqual([s.x, s.dir], [280, 'right'])
  for (const s of by('files')) assert.deepEqual([s.x, s.dir], [1300, 'left'])
  for (const s of by('status')) assert.deepEqual([s.y, s.dir], [874, 'up'])
  for (const s of by('divider')) assert.ok(s.x === 795 && ['left', 'right'].includes(s.dir))
  for (const s of by('toast')) assert.deepEqual([s.y, s.dir], [760, 'up'])
  assert.equal(by('window').map((s) => s.dir).sort().join(), 'down,left,right,up')
  for (const s of by('tabs')) assert.ok(s.x >= 320 && s.x <= 1260, `tabs x ${s.x}`) // off the strip's ends
  for (const s of all) assert.ok(OUT[s.dir] && s.dir in ROT, s.dir)
})

test('seek: real DOMRects work too (their fields are getters, so a spread of one is empty)', () => {
  class Rectish {
    #r
    constructor(r) {
      this.#r = r
    }
    get left() { return this.#r.left } // prettier-ignore
    get top() { return this.#r.top } // prettier-ignore
    get right() { return this.#r.right } // prettier-ignore
    get bottom() { return this.#r.bottom } // prettier-ignore
  }
  const all = spots({ toasts: [new Rectish(orca.toasts[0])], tabs: new Rectish(orca.tabs) }, view, seeded(2))
  assert.ok(all.some((s) => s.name === 'toast' && s.y === 760))
  assert.ok(all.some((s) => s.name === 'tabs'))
})

test('seek: the pick stays off the pointer, off what you type into, and away from where it was', () => {
  const rand = seeded(3)
  const cands = spots(orca, view, rand)
  const typing = { left: 300, top: 850, right: 700, bottom: 870 }
  for (let i = 0; i < 60; i++) {
    const s = pick(cands, { view, box: 64, pointer: { x: 795, y: 400 }, from: { x: 100, y: 800 }, avoid: [typing], rand })
    assert.ok(s, 'always a spot')
    assert.ok(Math.hypot(s.x - 795, s.y - 400) >= 160, `near the pointer: ${JSON.stringify(s)}`)
    assert.ok(Math.hypot(s.x - 100, s.y - 800) >= 220, `where it was: ${JSON.stringify(s)}`)
    assert.ok(!(s.x > 210 && s.x < 790 && s.y > 760 && s.y < 960), `over the typing: ${JSON.stringify(s)}`)
  }
  // `want` narrows the pick to that kind of spot when the window offers one.
  for (let i = 0; i < 20; i++) assert.equal(pick(cands, { view, want: 'status', rand }).name, 'status')
  assert.ok(pick(cands, { view, want: 'nothing-like-this', rand }), 'an unknown kind falls back to any spot')
})

test('seek: a bare window still has its four edges; a tiny one has nothing', () => {
  const tiny = { w: 40, h: 40 }
  assert.equal(pick(spots({}, tiny, seeded(4)), { view: tiny, box: 64 }), null)
  const bare = { w: 800, h: 600 }
  const s = pick(spots({}, bare, seeded(5)), { view: bare, box: 64, rand: seeded(6) })
  assert.equal(s.name, 'window')
})

test('git: commit and push are found in the typed line, the last of a chain wins', () => {
  assert.equal(gitMoment('git commit -m "fix"'), 'commit')
  assert.equal(gitMoment('  git commit'), 'commit')
  assert.equal(gitMoment('git push'), 'push')
  assert.equal(gitMoment('git push origin main --force'), 'push')
  assert.equal(gitMoment('git -C ../repo commit -am x'), 'commit')
  assert.equal(gitMoment('git -c user.name=me commit -m x'), 'commit')
  assert.equal(gitMoment('git add . && git commit -m "x"'), 'commit')
  assert.equal(gitMoment('git commit -m x && git push'), 'push')
  assert.equal(gitMoment('cd a; git push -u origin b'), 'push')
  assert.equal(gitMoment('git commit -m "x" | cat'), 'commit')
})

test('git: quoted strings are ignored, so a message about git is not a git moment', () => {
  assert.equal(gitMoment('git commit -m "git push"'), 'commit')
  assert.equal(gitMoment("git commit -m 'now git push it'"), 'commit')
  assert.equal(gitMoment('echo "git commit"'), null)
  assert.equal(gitMoment("echo 'git push'"), null)
  assert.equal(gitMoment('git commit -m "say \\"git push\\""'), 'commit')
  assert.equal(gitMoment('git commit -m "x" && echo "git push"'), 'commit')
})

test('git: other lines, dry runs and look-alikes do not count', () => {
  for (const l of ['git status', 'git log --oneline', 'git pull', 'echo git commit', 'github push', 'git commit --dry-run', 'git push --help', 'git push -h', 'gitk', 'git committer', 'git pushd', '', null, 'npm run commit'])
    assert.equal(gitMoment(l), null, String(l))
})

test('reading: Markdown files and READMEs, not other tabs', () => {
  for (const t of ['README.md', 'readme', 'Readme.txt', 'notes.markdown', 'CHANGELOG.MD', 'doc.mdx', ' notes.md ']) assert.ok(isReadable(t), t)
  for (const t of ['index.js', 'terminal 1', 'md.js', 'readmefile.js', 'Claude', '', undefined]) assert.ok(!isReadable(t), String(t))
})

test('lantern: lit once per evening, kept after a reload, out by morning', () => {
  for (let h = 0; h < 24; h++) {
    const evening = h >= 18 || h < 5
    assert.equal(lanternPhase({ hour: h, day: 'd1', lit: '' }), evening ? 'light' : 'out', `${h}`)
    if (evening) assert.equal(lanternPhase({ hour: h, day: 'd1', lit: 'd1' }), 'keep', `${h} kept`)
  }
  assert.equal(lanternPhase({ hour: 19, day: 'd2', lit: 'd1' }), 'light', 'the next evening is lit again')
  assert.equal(lanternPhase({ hour: 5, day: 'd2', lit: 'd1' }), 'out', 'the day roll puts it out')
  assert.equal(lanternPhase({ hour: 16, day: 'd1', lit: '', from: 16 }), 'light', 'an earlier evening')
  assert.equal(lanternPhase({ hour: 6, day: 'd1', lit: 'd1', until: 7 }), 'keep', 'a later morning')
})

test('words: the built-in list sings on a word, treats "沒有 bug" as good news, and asks before worrying', () => {
  const match = (line) => defaultWords.find((w) => w.re.test(line))?.react ?? null
  for (const line of ['唱歌', '唱首歌給我聽', '想聽搖籃曲', 'Sing for me', 'play the lullaby', '可以唱歌嗎？', 'can you sing?']) assert.equal(match(line), 'sing', line)
  assert.notEqual(match('git commit -m "missing file"'), 'sing')
  assert.notEqual(match('npm run singleton'), 'sing')
  assert.equal(match('沒有 bug 了'), 'goodNews')
  assert.equal(match('found a bug'), 'worried')
  assert.equal(match('thanks'), 'thanks')
  assert.equal(match('good night'), 'sleepy')
  assert.equal(match('為什麼會這樣'), 'curious')
  assert.equal(match('ls -la'), null)
})

test('missing: a word naming an act the pet does not have falls back to idle, and warns once per name', () => {
  // A shared pet with its 'dance' act taken out; its words still ask for it.
  const acts = { wiggle: 1, hop: 1, sing: 1 }
  const has = (n) => n in acts
  assert.equal(missing.resolve('hop', has), 'hop')
  assert.equal(missing.resolve('dance', has), 'idle')
  for (const bad of ['', null, undefined, 42]) assert.equal(missing.resolve(bad, has), 'idle', String(bad))
  const first = missing.once()
  const warned = ['dance', 'dance', 'dance'].filter((n) => missing.resolve(n, has) === 'idle' && first('act', n))
  assert.equal(warned.length, 1)
  assert.equal(first('act', 'spin'), true) // another missing act still gets its own warning
  assert.equal(first('sound', '--asset-lullaby'), true) // a missing sound is counted apart
  assert.equal(first('sound', '--asset-lullaby'), false)
  assert.equal(missing.once()('act', 'dance'), true) // each pet keeps its own list
})

test('idle: 50 seeded picks never do the same act twice in a row, and each wait stays in range', () => {
  const { idle } = ctx.window.__orcaThemer.companionRules
  // One act far heavier than the rest, so a repeat would show up at once if the rule slipped.
  const weights = { wiggle: 10, hop: 1, look: 1, stretch: 0.5, off: 0 }
  for (const seed of [1, 7, 42]) {
    const rand = seeded(seed)
    let last = ''
    const seen = new Set()
    for (let i = 0; i < 50; i++) {
      const act = idle.pick(weights, last, rand, 'wiggle')
      assert.notEqual(act, last, `seed ${seed}, pick ${i}: ${act} twice`)
      assert.notEqual(act, 'off', 'a zero weight is never picked')
      seen.add(act)
      last = act
    }
    assert.ok(seen.size >= 3, `seed ${seed}: only ${[...seen]}`)
  }
  // The default [12 s, 30 s], a pet's own idleEvery (8–15 s), and the idle frequency scaling both ends.
  for (const [range, freq] of [[[12000, 30000], 1], [[8000, 15000], 1], [[8000, 15000], 2], [[12000, 30000], 0.5]]) {
    const rand = seeded(3)
    for (let i = 0; i < 50; i++) {
      const ms = idle.delay(range, freq, rand)
      assert.ok(ms >= range[0] / freq && ms <= range[1] / freq, `${range} ×${freq}: ${ms}`)
    }
  }
})

test('idle: focus quiet holds the idle acts while you type and lets them back after quietMs (fake clock)', () => {
  const { idle } = ctx.window.__orcaThemer.companionRules
  // The engine's idle loop on a fake clock: each tick waits idle.delay, and acts only when not focused.
  // You type a key every 180 ms for the first 90 s, then stop.
  const run = (quietMs, range = [8000, 15000]) => {
    const rand = seeded(5)
    const typedUntil = 90000
    const lastKeyAt = (now) => (now < typedUntil ? now - (now % 180) : typedUntil - (typedUntil % 180))
    const acted = []
    for (let now = idle.delay(range, 1, rand); now < 180000; now += idle.delay(range, 1, rand)) {
      if (!idle.focused(lastKeyAt(now), now, quietMs)) acted.push(now)
    }
    return { acted, stoppedAt: lastKeyAt(typedUntil) }
  }
  // Off (0, or unset in the engine): it acts while you type, as before.
  assert.ok(run(0).acted.some((t) => t < 90000))
  for (const quietMs of [3000, 8000, 20000]) {
    const { acted, stoppedAt } = run(quietMs)
    assert.ok(acted.length, `${quietMs}: never came back`)
    for (const t of acted) assert.ok(t >= stoppedAt + quietMs, `${quietMs}: acted at ${t} ms, ${t - stoppedAt} ms after the last key`)
    // Back within one idle wait (max 15 s) of the quiet running out.
    assert.ok(acted[0] <= stoppedAt + quietMs + 15000, `${quietMs}: first act only at ${acted[0]}`)
  }
  // The edge: exactly quietMs after the last key is no longer focused; no key yet is never focused.
  assert.equal(idle.focused(1000, 1000 + 7999, 8000), true)
  assert.equal(idle.focused(1000, 1000 + 8000, 8000), false)
  assert.equal(idle.focused(-Infinity, 5, 8000), false)
})

test('idle: a rounding sliver still picks a new act; the fallback is only for "nothing else allowed"', () => {
  const { idle } = ctx.window.__orcaThemer.companionRules
  // A draw just under 1 never repeats the last act. (Whether it reaches the last-candidate branch is
  // checked case by case in the next test.)
  const weights = { a: 0.1, b: 0.2, c: 0.3, sig: 0.4 }
  assert.notEqual(idle.pick(weights, 'sig', () => 0.9999999999999999, 'sig'), 'sig')
  assert.equal(idle.pick({ sig: 1 }, 'sig', Math.random, 'sig'), 'sig') // the only act there is
  assert.equal(idle.pick({}, '', Math.random, 'sig'), 'sig')
})

test('idle: the rounding sliver really reaches "play the last candidate"', () => {
  const { idle } = ctx.window.__orcaThemer.companionRules
  // The same sums pick does, in the same order: the draw scaled by the total, then each weight taken off.
  // A case only counts if something is still left after the last weight, so the loop ends without a
  // match and only the closing `return names[names.length - 1]` can answer it.
  const left = (w, x) => {
    let r = x * Object.values(w).reduce((a, v) => a + v, 0)
    for (const v of Object.values(w)) r -= v
    return r
  }
  const draws = [1 - Number.EPSILON, 1 - Number.EPSILON / 2]
  // 0.1 / 0.2 / 0.3 and their kin look like they should leave a sliver, but they end on exactly 0 (the
  // loop's own `<= 0` catches them). The sure case: one big weight and a few just over half its ulp,
  // so every add rounds up and the total overshoots by more than the draw takes off.
  const k = 0.6 * Number.EPSILON
  const sure = [1, k, k, k]
  const sets = [sure, [0.1, 0.2, 0.3], [0.3, 0.2, 0.1], [0.1, 0.7, 0.2]]
  for (const x of draws) assert.ok(left(Object.fromEntries(sure.map((v, i) => [`a${i}`, v])), x) > 0, `the sure case @ ${x}`)
  for (let n = 2; n <= 12; n++) sets.push(Array(n).fill(0.1), Array.from({ length: n }, (_, i) => (i + 1) / 10))
  let reached = 0
  for (const vals of sets) {
    const weights = Object.fromEntries(vals.map((v, i) => [`a${i}`, v]))
    const names = Object.keys(weights)
    for (const x of draws) {
      if (!(left(weights, x) > 0)) continue
      reached++
      const before = names[0]
      const rest = Object.fromEntries(Object.entries(weights).filter(([n]) => n !== before))
      // With the act it just did still in the table: it is skipped, and the last of the others plays.
      const act = idle.pick({ ...weights, sig: 0.4 }, before, () => x, 'sig')
      if (left({ ...rest, sig: 0.4 }, x) > 0) assert.equal(act, 'sig', `${vals} @ ${x}`)
      assert.notEqual(act, before)
      // And with nothing skipped: the very last weight answers, never the fallback.
      assert.equal(idle.pick(weights, '', () => x, 'fallback'), names.at(-1), `${vals} @ ${x}`)
    }
  }
  assert.ok(reached > 0, 'no weight set left a sliver, so the last-candidate branch went untested')
})

test('idle: when only the signature act may play, it plays', () => {
  const { idle } = ctx.window.__orcaThemer.companionRules
  // Every other act switched off (weight 0): the signature is the one name left and the draw lands on it.
  assert.equal(idle.pick({ hop: 0, look: 0, sig: 1 }, 'hop', () => 0.5, 'sig'), 'sig')
  assert.equal(idle.pick({ hop: 0, look: 0, sig: 1 }, 'hop', () => 1 - Number.EPSILON, 'sig'), 'sig')
  // It just played and nothing else is on: the fallback brings it back rather than leaving the pet still.
  assert.equal(idle.pick({ hop: 0, sig: 1 }, 'sig', () => 0.5, 'sig'), 'sig')
})

test('hidden: going hidden pauses the running loops, coming back plays only those', () => {
  const { idle } = ctx.window.__orcaThemer.companionRules
  const anim = (playState) => ({
    playState,
    pause() {
      this.playState = 'paused'
    },
    play() {
      this.playState = 'running'
    }
  })
  const bob = anim('running')
  const ears = anim('running')
  const held = anim('paused') // paused on purpose (the bob while hiding)
  const gone = anim('idle') // cancelled
  const paused = idle.pause([bob, ears, held, gone, undefined])
  assert.deepEqual(paused, [bob, ears])
  assert.deepEqual([bob, ears, held, gone].map((a) => a.playState), ['paused', 'paused', 'paused', 'idle'])
  // Hidden twice in a row: nothing more to pause.
  assert.deepEqual(idle.pause([bob, ears, held]), [])
  // Something cancelled one while hidden: it is not brought back.
  ears.playState = 'idle'
  idle.resume(paused)
  assert.deepEqual([bob, ears, held, gone].map((a) => a.playState), ['running', 'idle', 'paused', 'idle'])
})

test('hidden: the engine pauses loops and stops the idle timer on visibilitychange, and lets go on stop', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'touches', 'companion.js'), 'utf8')
  assert.match(src, /document\.addEventListener\('visibilitychange', onVisibility\)/)
  assert.match(src, /document\.removeEventListener\('visibilitychange', onVisibility\)/)
  const body = src.split('const onVisibility = () => {')[1]?.split('\n    }\n')[0] ?? ''
  assert.match(body, /document\.hidden/)
  assert.match(body, /idleRules\.pause\(loops\)/)
  assert.match(body, /clearTimeout\(idleTimer\)/)
  assert.match(body, /idleRules\.resume\(pausedLoops\)/)
  assert.match(body, /scheduleIdle\(\)/)
  // The blink timer stops too, and is armed again on the way back.
  assert.match(body, /clearTimeout\(blinkTimer\)/)
  assert.match(body, /blinkTimer = 0/)
  assert.match(body, /idleRules\.rearm\(document\.hidden, blinkTimer, stopped\)\) blink\(\)/)
  // Declared before the handler runs for a window that starts hidden.
  assert.ok(src.indexOf('let blinkTimer = 0') < src.indexOf('const onVisibility = () => {'))
})

test('hidden: the blink timer is armed again only when visible, not pending and not stopped', () => {
  const { idle } = ctx.window.__orcaThemer.companionRules
  assert.equal(idle.rearm(false, 0, false), true) // back in sight after the timer was cleared
  assert.equal(idle.rearm(true, 0, false), false) // still hidden
  assert.equal(idle.rearm(false, 42, false), false) // a blink is already pending: never two timers
  assert.equal(idle.rearm(false, 0, true), false) // stopped on purpose
})

// A fake label and log, to count what the trace makes and writes.
// `where` is the pet's spot, as the engine's `at()` would read it.
const traceWith = (on, where = { x: 100, y: 200 }) => {
  const made = []
  const lines = []
  const tr = stateTrace(() => on.value, {
    make: () => {
      const el = {
        textContent: '',
        removed: false,
        style: { transform: '' },
        glides: [],
        remove() { this.removed = true },
        animate(frames, opts) {
          const a = { frames, opts, cancelled: false, cancel() { this.cancelled = true } }
          this.glides.push(a)
          return a
        }
      }
      made.push(el)
      return el
    },
    at: () => `translate(${where.x}px, ${where.y}px) translate(-50%, -100%)`,
    log: (line) => lines.push(line)
  })
  return { tr, made, lines, where }
}

test('debugState: switched off, a change makes no label and logs nothing', () => {
  const on = { value: false }
  const { tr, made, lines } = traceWith(on)
  tr.change('home', 'asleep', '一陣子沒動靜')
  tr.change('asleep', 'home', '醒來')
  tr.sync('home')
  tr.stop()
  assert.equal(made.length, 0)
  assert.equal(lines.length, 0)
})

test('debugState: switched on, the label shows the state and each change logs "old→new（why）" once', () => {
  const on = { value: true }
  const { tr, made, lines } = traceWith(on)
  tr.change('home', 'following', '雙擊，跟著游標')
  tr.change('following', 'following', 'again') // not a change: nothing
  tr.change('following', 'home', '不跟了')
  assert.equal(made.length, 1, 'one label, reused')
  assert.equal(made[0].textContent, 'home')
  assert.deepEqual(lines, ['home→following（雙擊，跟著游標）', 'following→home（不跟了）'])
  // Switched off between changes: the label goes, and the next change neither logs nor brings it back.
  on.value = false
  tr.sync('home')
  assert.equal(made[0].removed, true)
  tr.change('home', 'asleep', '一陣子沒動靜')
  assert.equal(made.length, 1)
  assert.equal(lines.length, 2)
  // On again: sync shows the state at once, without waiting for a change; stop takes it away.
  on.value = true
  tr.sync('asleep')
  assert.equal(made.length, 2)
  assert.equal(made[1].textContent, 'asleep')
  tr.stop()
  assert.equal(made[1].removed, true)
})

test('debugState: while hiding and flying the label is still there and moves by translate alone', () => {
  const on = { value: true }
  const { tr, made, where } = traceWith(on)
  tr.change('home', 'hiding', '開始捉迷藏')
  where.x = 0 // off to a hiding spot
  tr.follow()
  assert.equal(made.length, 1)
  assert.equal(made[0].removed, false, 'hiding keeps the label')
  assert.equal(made[0].textContent, 'hiding')
  assert.equal(made[0].style.transform, 'translate(0px, 200px) translate(-50%, -100%)')
  tr.change('hiding', 'flying', '被找到了')
  where.x = 300
  tr.follow(900, 'ease') // flyTo: the label glides with the pet
  assert.equal(made.length, 1)
  assert.equal(made[0].removed, false, 'flying keeps the label')
  assert.equal(made[0].textContent, 'flying')
  assert.equal(made[0].glides.length, 1)
  assert.deepEqual(Array.from(made[0].glides[0].frames, (f) => f.transform), ['translate(0px, 200px) translate(-50%, -100%)', 'translate(300px, 200px) translate(-50%, -100%)'])
  assert.equal(made[0].glides[0].opts.duration, 900)
  for (const f of [made[0].style.transform, ...made[0].glides[0].frames.map((x) => x.transform)]) assert.doesNotMatch(f, /rotate|scale/)
  // A throw places it every frame: the old glide gives way.
  where.y = 50
  tr.follow()
  assert.equal(made[0].glides[0].cancelled, true)
  assert.equal(made[0].glides.length, 1)
  assert.equal(made[0].style.transform, 'translate(300px, 50px) translate(-50%, -100%)')
})

test('debugState: switched off, following the pet makes no label', () => {
  const on = { value: false }
  const { tr, made } = traceWith(on)
  tr.change('home', 'hiding', '開始捉迷藏')
  tr.follow()
  tr.change('hiding', 'flying', '被找到了')
  tr.follow(900, 'ease')
  assert.equal(made.length, 0)
})

test('debugState: the engine hangs the label in the layer, not in the pet, and moves it with the pet', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'touches', 'companion.js'), 'utf8')
  const make = src.match(/stateTrace\(\(\) => on\('debugState'\), \{[\s\S]*?\r?\n {4}\}\)/)?.[0]
  assert.ok(make, 'the engine builds the trace')
  assert.match(make, /host\.appendChild\(el\)/, 'beside the pet: its clip, fade and turn do not reach the label')
  assert.doesNotMatch(make, /home\.appendChild/)
  assert.doesNotMatch(make, /rotate|scale\(|opacity|clip/)
  assert.match(src, /const place = [^\n]*\n[^\n]*\n[^\n]*\n\s*trace\.follow\(/, 'every place moves the label')
  assert.match(src, /home\.style\.clipPath = CLIP\r?\n[^\n]*\n\s*trace\.follow\(\)/, 'so does a hiding spot')
})

test('debugState: every change of mode in the engine goes through setMode, and the row is off by default', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'touches', 'companion.js'), 'utf8')
  const bare = src.split('\n').filter((l) => /(^|[^=!<>\w.])mode\s*=\s*['"]/.test(l) && !/let mode = 'home'/.test(l))
  assert.deepEqual(bare, [], 'assign mode with setMode(to, why)')
  assert.match(src, /f\('debugState',[^\n]*on: \(\) => false, preview: false/)
})

// Face swap: the old eyes fade out while the new ones fade in (opacity only, FADE_MS), and under reduced
// motion it is a plain switch with no animation. Fake elements record what was asked of them.
const faceEl = (opacity = '') => {
  const el = { style: { opacity }, calls: [] }
  el.animate = (keyframes, options) => {
    const a = { keyframes, options, cancelled: false, cancel() { this.cancelled = true } }
    el.calls.push(a)
    return a
  }
  return el
}
const faceGroups = () => ({ eyes: [faceEl(), faceEl()], happyEyes: [faceEl('0')], sleepEyes: [faceEl('0')] })
const plain = (v) => JSON.parse(JSON.stringify(v))

test('face: a swap cross-fades the old and new eyes on opacity, 150 ms', () => {
  const { face } = ctx.window.__orcaThemer.companionRules
  assert.equal(face.FADE_MS, 150)
  const g = faceGroups()
  const started = face.swap(g, 'happyEyes', false)
  assert.equal(started.length, 3, 'two open eyes out, the happy eyes in; the sleep eyes stay hidden')
  for (const el of g.eyes) {
    assert.equal(el.style.opacity, '0')
    assert.deepEqual(plain(el.calls[0].keyframes), [{ opacity: 1 }, { opacity: 0 }])
    assert.equal(el.calls[0].options.duration, 150)
  }
  assert.equal(g.happyEyes[0].style.opacity, '')
  assert.deepEqual(plain(g.happyEyes[0].calls[0].keyframes), [{ opacity: 0 }, { opacity: 1 }])
  assert.equal(g.sleepEyes[0].calls.length, 0)
  for (const a of started) assert.deepEqual(Object.keys(a.keyframes[0]), ['opacity'], 'opacity only')
})

test('face: under reduced motion the swap is instant, with no animation', () => {
  const { face } = ctx.window.__orcaThemer.companionRules
  const g = faceGroups()
  assert.equal(face.swap(g, 'sleepEyes', true).length, 0)
  for (const el of [...g.eyes, ...g.happyEyes, ...g.sleepEyes]) assert.equal(el.calls.length, 0)
  assert.deepEqual(g.eyes.map((e) => e.style.opacity), ['0', '0'])
  assert.equal(g.happyEyes[0].style.opacity, '0')
  assert.equal(g.sleepEyes[0].style.opacity, '')
})

test('face: a new swap cancels a fade still running, and the same face twice does nothing', () => {
  const { face } = ctx.window.__orcaThemer.companionRules
  const g = faceGroups()
  const fades = new WeakMap()
  const first = face.swap(g, 'happyEyes', false, 150, fades)
  assert.equal(face.swap(g, 'happyEyes', false, 150, fades).length, 0)
  face.swap(g, 'eyes', false, 150, fades)
  assert.ok(first.every((a) => a.cancelled), 'the half-done fades are cancelled')
  assert.deepEqual(g.eyes.map((e) => e.style.opacity), ['', ''])
  assert.equal(g.happyEyes[0].style.opacity, '0')
  // Reduced motion turning on mid-fade still cancels what is running.
  const again = face.swap(g, 'sleepEyes', false, 150, fades)
  face.swap(g, 'eyes', true, 150, fades)
  assert.ok(again.every((a) => a.cancelled))
})
