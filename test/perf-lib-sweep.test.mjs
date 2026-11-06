// tools/perf-lib.mjs: what a killed perf or live-check run left behind (its isolated Orca, the daemon, the profile
// copy) is found by its work folder, whose name carries the tool's pid.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { orphanWorks, daemonHash } from '../tools/perf-lib.mjs'

test('perf-lib sweep: a work folder whose tool is gone is an orphan; a live (or reused) pid, or any other folder, is not', () => {
  const alive = (pid) => pid === 200
  const names = ['orca-perf-100', 'orca-perf-200', 'orca-live-check-300', 'orca-accept-400', 'orca-perf-x', 'other', 'orca-perf-300-old']
  assert.deepEqual(orphanWorks(names, alive), ['orca-perf-100', 'orca-live-check-300'])
})

test('perf-lib sweep: the daemon profile an executable runs from', () => {
  assert.equal(daemonHash(String.raw`D:\Data\Orca\daemon-host-profiles\8744cf1e248ebcc4\Orca.exe`), '8744cf1e248ebcc4')
  assert.equal(daemonHash(String.raw`D:\Data\Programs\orca\Orca.exe`), '')
  assert.equal(daemonHash(undefined), '')
})
