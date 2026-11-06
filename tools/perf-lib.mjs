// Shared helpers for the perf A/B: start an isolated, themed Orca and talk to it over the themer's
// dev channel (ROOT/dev/*.cmd.json). Only processes this file starts (in this run or an earlier one of these
// tools that was killed) are ever stopped.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import asar from '@electron/asar'
import { readOrcaVersion, recordChecked } from '../src/checkup.mjs'
import { exampleSources, seedBundled } from '../src/seed.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export { sleep }

// Every new --user-data-dir makes Orca copy its build (~270 MB) into daemon-host-profiles\<hash>, and Orca never
// deletes it. stop() removes the folders that appeared during this run once no process runs from them.
const DAEMON_PROFILES = path.join(process.env.LOCALAPPDATA ?? '', 'Orca', 'daemon-host-profiles')
const daemonProfiles = () => {
  try {
    return fs.readdirSync(DAEMON_PROFILES)
  } catch {
    return []
  }
}
// A run killed outright (a closed terminal, a low-memory stop) leaves its isolated Orca, the Orca daemon and its
// ~270 MB profile copy behind. The work folders carry the tool's pid; one whose tool is gone is an orphan, swept
// once per process before the first launch: what runs with that folder on its command line is stopped, the folder
// and the daemon profiles those processes ran from are removed.
export const WORK_RE = /^orca-(perf|live-check)-(\d+)$/
export const orphanWorks = (names, alive) => names.filter((n) => WORK_RE.test(n) && !alive(Number(n.match(WORK_RE)[2])))
export const daemonHash = (exe) => (String(exe ?? '').match(/daemon-host-profiles[\\/]([0-9a-f]+)[\\/]/i) ?? [])[1] ?? ''
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
let swept = false
export async function sweepOrphans({ temp = process.env.ORCA_PERF_TEMP || os.tmpdir(), log = () => {} } = {}) {
  if (swept) return
  swept = true
  let names = []
  try {
    names = fs.readdirSync(temp)
  } catch {
    return
  }
  for (const n of orphanWorks(names, pidAlive)) {
    const dir = path.join(temp, n)
    const needle = dir.replace(/'/g, "''")
    const script = `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }`
    let left = []
    try {
      left = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean)
    } catch {}
    const hashes = new Set(left.map((l) => daemonHash(l.split('|')[1])).filter(Boolean))
    for (const l of left) {
      try {
        execFileSync('taskkill.exe', ['/PID', l.split('|')[0], '/T', '/F'], { stdio: 'ignore' })
      } catch {}
    }
    if (left.length) await sleep(1500)
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    for (const h of hashes) fs.rmSync(path.join(DAEMON_PROFILES, h), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    log(`orphan ${n}: stopped ${left.length} process(es), removed its folder${hashes.size ? ` and daemon profile ${[...hashes].join(' ')}` : ''}`)
  }
}
// Recursive copy by hand: fs.cpSync(..., { recursive: true }) crashes Node 22 on Windows when a path has
// non-ASCII characters; copyFileSync does not.
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name)
    const d = path.join(to, e.name)
    if (e.isDirectory()) copyTree(s, d)
    else if (e.isFile()) fs.copyFileSync(s, d)
  }
}
// Ctrl+C mid-run still stops the copies it started and removes their profile folders.
const live = new Set()
process.once('SIGINT', async () => {
  for (const inst of [...live]) await stop(inst)
  process.exit(130)
})
function removeNewDaemonProfiles(before) {
  const fresh = daemonProfiles().filter((n) => !before.has(n))
  if (!fresh.length) return
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath } | ForEach-Object { $_.ExecutablePath }`
  const inUse = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).toLowerCase()
  for (const n of fresh) {
    const dir = path.join(DAEMON_PROFILES, n)
    if (inUse.includes(dir.toLowerCase() + path.sep)) continue
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    } catch {}
  }
}

/** The touches a theme lists in its @touches header (bundled themes and examples alike). */
export function themeTouches(themeId, repo = REPO) {
  const file = [path.join(repo, 'themes', `${themeId}.css`), path.join(repo, 'examples', 'themes', `${themeId}.css`)].find((f) => fs.existsSync(f))
  if (!file) throw new Error(`no theme ${themeId} in themes/ or examples/themes/`)
  const css = fs.readFileSync(file, 'utf8')
  const m = css.match(/@touches\s+([^\n*]+)/)
  return m ? m[1].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean) : []
}

/**
 * Launches `node src/themer.mjs --no-restart --user-data-dir=<work>/ud` with its own ROOT.
 * @param {{ work: string, themeId: string|null, touches: string[], seedUserData?: string }} o
 */
export async function launch({ work, themeId, touches, seedUserData, keep = false, extraArgs = [], repo = REPO }) {
  const root = path.join(work, 'root')
  const ud = path.join(work, 'ud')
  fs.mkdirSync(root, { recursive: true })
  // The examples (the Cotton Sky theme, Puff) go into the run's own root, as `npm run example` would.
  seedBundled(root, exampleSources(repo), { restoreDeleted: true })
  await sweepOrphans({ log: (m) => console.log(`[perf-lib] ${m}`) })
  const profilesBefore = new Set(daemonProfiles())
  if (seedUserData && !fs.existsSync(ud)) copyTree(seedUserData, ud)
  const all = themeId ? themeTouches(themeId, repo) : []
  fs.writeFileSync(
    path.join(root, 'settings.json'),
    JSON.stringify({ themeId, enabledSnippets: [], enabledTouches: touches, touchDefaultsApplied: all.map((t) => `${themeId}/${t}`) }, null, 2)
  )
  // Mark the update checkup as done, so it does not run in the middle of a measurement.
  const version = readOrcaVersion(asar, path.join(process.env.LOCALAPPDATA, 'Programs', 'orca', 'resources', 'app.asar'))
  if (version) recordChecked(path.join(root, 'orca-version.json'), version, true)
  const child = spawn(process.execPath, [path.join(repo, 'src', 'themer.mjs'), '--no-restart', `--user-data-dir=${ud}`, ...extraArgs], {
    cwd: repo,
    env: { ...process.env, ORCA_THEMER_ROOT: root, ORCA_THEMER_DEV: '1' },
    stdio: 'ignore',
    windowsHide: true,
    detached: Boolean(keep)
  })
  if (keep) child.unref()
  const inst = { child, root, ud, work, profilesBefore, devDir: path.join(root, 'dev'), seq: 0 }
  live.add(inst)
  inst.dev = (command, timeoutMs = 120000) => dev(inst, command, timeoutMs)
  // While the window reloads the themer briefly has no main window; those calls are retried.
  const transient = (e) => /main window not attached|navigated or closed|Execution context was destroyed|Cannot find context/i.test(e ?? '')
  const retrying = async (command, timeoutMs) => {
    const until = Date.now() + 30000
    for (;;) {
      const r = await inst.dev(command, timeoutMs)
      if (r.ok || !transient(r.error) || Date.now() > until) return r
      await sleep(500)
    }
  }
  inst.eval = async (expr, timeoutMs) => {
    const r = await retrying({ cmd: 'eval', expr }, timeoutMs)
    if (!r.ok) throw new Error(`eval failed: ${r.error}`)
    return r.value
  }
  inst.cdp = async (method, params = {}, timeoutMs) => {
    const r = await retrying({ cmd: 'cdp', method, params }, timeoutMs)
    if (!r.ok) throw new Error(`${method} failed: ${r.error}`)
    return r.value
  }
  inst.stop = () => stop(inst)
  // Wait for the main window and the runtime.
  const until = Date.now() + 90000
  for (;;) {
    if (Date.now() > until) {
      await stop(inst)
      throw new Error('isolated Orca did not come up')
    }
    await sleep(1000)
    if (!fs.existsSync(inst.devDir)) continue
    try {
      const ok = await inst.eval(`!!document.querySelector('.bg-worktree-sidebar') && !!window.__orcaThemer`, 5000)
      if (ok) break
    } catch {}
  }
  return inst
}

async function dev(inst, command, timeoutMs) {
  const id = `${process.pid}-${Date.now()}-${inst.seq++}`
  const file = path.join(inst.devDir, `${id}.cmd.json`)
  const out = path.join(inst.devDir, `${id}.result.json`)
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(command))
  fs.renameSync(`${file}.tmp`, file)
  const until = Date.now() + timeoutMs
  while (!fs.existsSync(out)) {
    if (Date.now() > until) throw new Error(`dev ${command.cmd} timed out`)
    await sleep(50)
  }
  for (let i = 0; ; i++) {
    try {
      const r = JSON.parse(fs.readFileSync(out, 'utf8'))
      fs.unlinkSync(out)
      return r
    } catch (e) {
      if (i > 20) throw e
      await sleep(30)
    }
  }
}

/** Process ids of the launcher's whole tree (the launcher, Orca and Orca's helpers). */
function treePids(rootPid) {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8' })
  const kids = new Map()
  for (const line of out.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!pid) continue
    if (!kids.has(ppid)) kids.set(ppid, [])
    kids.get(ppid).push(pid)
  }
  const all = []
  const walk = (p) => {
    all.push(p)
    for (const k of kids.get(p) ?? []) walk(k)
  }
  walk(rootPid)
  return all
}

/** Stops this launcher's tree only, then any leftover process that carries this run's user-data dir. */
export async function stop(inst) {
  live.delete(inst)
  try {
    execFileSync('taskkill.exe', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
  await sleep(1500)
  // Orca's helpers (terminal daemon) can outlive the tree; they carry our user-data path on the command line.
  const needle = inst.ud.replace(/'/g, "''")
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${needle}') } | ForEach-Object { $_.ProcessId }`
  const left = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).split(/\s+/).filter(Boolean).map(Number)
  for (const pid of left) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {}
  }
  if (inst.profilesBefore) {
    await sleep(1000)
    removeNewDaemonProfiles(inst.profilesBefore)
  }
}

export { treePids }
