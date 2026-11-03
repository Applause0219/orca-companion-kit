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

// A fake label and log, to count what the trace makes and writes.
const traceWith = (on) => {
  const made = []
  const lines = []
  const tr = stateTrace(() => on.value, {
    make: () => {
      const el = { textContent: '', removed: false, remove() { this.removed = true } }
      made.push(el)
      return el
    },
    log: (line) => lines.push(line)
  })
  return { tr, made, lines }
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

test('debugState: every change of mode in the engine goes through setMode, and the row is off by default', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'touches', 'companion.js'), 'utf8')
  const bare = src.split('\n').filter((l) => /(^|[^=!<>\w.])mode\s*=\s*['"]/.test(l) && !/let mode = 'home'/.test(l))
  assert.deepEqual(bare, [], 'assign mode with setMode(to, why)')
  assert.match(src, /f\('debugState',[^\n]*on: \(\) => false, preview: false/)
})
