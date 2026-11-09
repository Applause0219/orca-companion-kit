// docs/hooks-notification-windows.md shows Windows toast hooks for Claude Code. These checks keep its
// settings snippet valid JSON, keep both notification kinds covered, and keep the Stop hook loop-safe.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const doc = read('docs/hooks-notification-windows.md')
const blocks = (lang) => [...doc.matchAll(new RegExp('```' + lang + '\\r?\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1])

const settings = (() => {
  const block = blocks('json').find((b) => b.includes('"hooks"'))
  assert.ok(block, 'no json block with "hooks"')
  return JSON.parse(block)
})()

test('the settings snippet is valid JSON with Notification and Stop hooks', () => {
  assert.ok(Array.isArray(settings.hooks?.Notification), 'hooks.Notification is not an array')
  assert.ok(Array.isArray(settings.hooks?.Stop), 'hooks.Stop is not an array')
})

test('Notification matchers cover permission_prompt and idle_prompt, each with its own kind', () => {
  const entries = settings.hooks.Notification
  for (const [matcher, kind] of [['permission_prompt', 'permission'], ['idle_prompt', 'idle']]) {
    const entry = entries.find((e) => new RegExp(`^(${e.matcher})$`).test(matcher))
    assert.ok(entry, `no Notification matcher covers ${matcher}`)
    for (const h of entry.hooks) {
      assert.equal(h.type, 'command')
      assert.match(h.command, /^powershell /, 'uses Windows PowerShell (WinRT toasts do not load in pwsh 7)')
      assert.ok(h.command.includes('-File "$CLAUDE_PROJECT_DIR/.claude/hooks/notify.ps1"'),
        `${matcher} must point at notify.ps1 through a quoted $CLAUDE_PROJECT_DIR`)
      assert.ok(h.command.endsWith(`-Kind ${kind}`), `${matcher} does not pass -Kind ${kind}`)
      assert.equal(h.async, true, 'a notification must not hold the agent up')
      assert.ok(h.timeout > 0)
    }
  }
})

test('the Stop hook is synchronous so its block decision counts', () => {
  for (const entry of settings.hooks.Stop) {
    for (const h of entry.hooks) assert.notEqual(h.async, true)
  }
})

test('every hook script path is anchored at $CLAUDE_PROJECT_DIR, not the current directory', () => {
  const all = [...settings.hooks.Notification, ...settings.hooks.Stop].flatMap((e) => e.hooks)
  assert.ok(all.length >= 3)
  for (const h of all) {
    const paths = h.command.match(/\S*\.claude\/hooks\/\S+/g) ?? []
    assert.ok(paths.length > 0, `no script path in: ${h.command}`)
    for (const p of paths) assert.ok(p.startsWith('"$CLAUDE_PROJECT_DIR/'), `relative script path: ${p}`)
  }
})

test('notify.ps1 never reads stdin and only accepts the two kinds', () => {
  const ps = blocks('powershell')[0]
  assert.ok(ps, 'notify.ps1 block is missing')
  assert.match(ps, /ValidateSet\('permission', 'idle'\)/)
  assert.match(ps, /ToastNotificationManager/)
  assert.doesNotMatch(ps, /\$input|ReadToEnd|\[Console\]::In|Read-Host|Invoke-Expression|iex /i)
})

test('notify.ps1 is pure ASCII, since Windows PowerShell 5.1 reads BOM-less scripts as ANSI', () => {
  const ps = blocks('powershell')[0]
  const bad = [...ps].filter((c) => c.charCodeAt(0) > 0x7e || (c.charCodeAt(0) < 0x20 && !'\r\n\t'.includes(c)))
  assert.deepEqual(bad, [], 'non-ASCII characters turn into mojibake in the toast')
  assert.match(doc, /UTF-8 with BOM/, 'the doc should say how to save the script if the text is changed to Chinese')
})

test('stop-check.mjs lets the agent stop when stop_hook_active is set or stdin is unreadable', () => {
  const code = blocks('js').find((b) => b.includes('stop_hook_active'))
  assert.ok(code, 'stop-check.mjs block is missing')
  const exitIdx = code.indexOf('process.exit(0)', code.indexOf('stop_hook_active'))
  const blockIdx = code.indexOf("decision: 'block'")
  assert.ok(exitIdx > 0 && blockIdx > exitIdx, 'stop_hook_active must be checked before blocking')
  assert.match(code, /catch \{ process\.exit\(0\) \}/)
})

test('README and hooks-to-states.md link to it', () => {
  assert.match(read('README.md'), /\(docs\/hooks-notification-windows\.md\)/)
  assert.match(read('docs/hooks-to-states.md'), /\(hooks-notification-windows\.md\)/)
  assert.match(doc, /\(hooks-to-states\.md\)/)
})
