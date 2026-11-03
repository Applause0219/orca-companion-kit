// docs/hooks-to-states.md maps Claude Code hook events to the pet's states. These checks keep it in step
// with the engine and states.md, and keep its safety notes from being dropped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const doc = read('docs/hooks-to-states.md')

test('hooks-to-states.md lists the six labels', () => {
  for (const label of ['thinking', 'reading', 'testing', 'success', 'error', 'waiting']) {
    assert.ok(doc.split('\n').some((l) => l.startsWith(`| \`${label}\``)), `label ${label} has no row`)
  }
})

test('the Orca statuses it names are the ones the engine reads', () => {
  const engine = read('src/touches/companion.js')
  for (const s of ['working', 'permission', 'done', 'failed']) {
    assert.ok(doc.includes(`\`${s}\``), `doc does not mention ${s}`)
    assert.ok(engine.includes(`'${s}'`), `engine no longer reads ${s}; update the doc`)
  }
  assert.ok(engine.includes('data-agent-activity-status') && doc.includes('data-agent-activity-status'))
})

test('the states it maps to exist in states.md', () => {
  const states = read('docs/states.md')
  for (const name of ['visiting', 'twirl', 'droop', 'home', 'agent 工作中']) {
    assert.ok(doc.includes(name), `doc does not mention ${name}`)
    assert.ok(states.includes(name), `states.md no longer has ${name}; update the doc`)
  }
})

test('it keeps the four safety notes', () => {
  assert.match(doc, /## 接 hook 時要注意的四件事/)
  assert.match(doc, /### 1\. `permission_prompt` 要最顯眼/)
  assert.match(doc, /### 2\. hook 要非同步/)
  assert.match(doc, /"async": true/)
  assert.match(doc, /### 3\. 不要把 stdin 直接塞進指令/)
  assert.match(doc, /JSON\.parse\(readFileSync\(0/)
  assert.match(doc, /### 4\. hook 用你的完整權限跑；擋 `\.env` 時 `Read` 和 `Bash` 都要擋/)
  assert.match(doc, /"Read\(\.\/\.env\)"/)
  assert.match(doc, /"Bash\(cat \.env\*\)"/)
  assert.match(doc, /\(https:\/\/github\.com\/anthropics\/claude-code\/blob\/main\/CHANGELOG\.md\)/)
})

test('it shows a PreToolUse hook that denies .env without reading it', () => {
  assert.match(doc, /#### 再補一道：用 `PreToolUse` hook 擋提到 `\.env` 的指令/)
  const start = doc.indexOf('`env-guard.mjs`：')
  assert.ok(start > 0, 'env-guard.mjs example is missing')
  const block = doc.slice(start).match(/```js\r?\n([\s\S]*?)```/)
  assert.ok(block, 'env-guard.mjs has no js block')
  const code = block[1]
  assert.match(code, /JSON\.parse\(readFileSync\(0, 'utf8'\)\)/)
  assert.match(code, /hookEventName: 'PreToolUse'/)
  assert.match(code, /permissionDecision: 'deny'/)
  // The only file it may read is stdin (fd 0); it must never open .env or write a log.
  const reads = code.match(/readFileSync\([^)]*\)/g) ?? []
  assert.deepEqual(reads, ["readFileSync(0, 'utf8')"])
  assert.doesNotMatch(code, /dotenv|createReadStream|readFile\(|openSync|writeFile|appendFile|createWriteStream|console\.(log|error)/)
  assert.doesNotMatch(code, /readFileSync\([^0]/)
  // A guard has to run before the tool does, so its settings must not be async.
  const settings = doc.slice(doc.indexOf('#### 再補一道'), start)
  assert.match(settings, /"command": "node env-guard\.mjs"/)
  assert.doesNotMatch(settings.match(/```json\r?\n([\s\S]*?)```/)[1], /"async"/)
})

test('the deny example is valid JSON and blocks .env through both Read and Bash', () => {
  const blocks = [...doc.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((m) => m[1])
  const block = blocks.find((b) => b.includes('"permissions"'))
  assert.ok(block, 'no json block with "permissions"')
  let parsed
  assert.doesNotThrow(() => { parsed = JSON.parse(block) }, 'the deny example is not valid JSON')
  const deny = parsed?.permissions?.deny
  assert.ok(Array.isArray(deny), 'permissions.deny is not an array')
  for (const tool of ['Read(', 'Bash(']) {
    const rules = deny.filter((r) => typeof r === 'string' && r.startsWith(tool))
    assert.ok(rules.length > 0, `no ${tool} rule in permissions.deny`)
    assert.ok(rules.some((r) => r.includes('.env')), `no ${tool} rule matches .env`)
  }
})

test('README links to hooks-to-states.md and it links back to states.md', () => {
  assert.match(read('README.md'), /\(docs\/hooks-to-states\.md\)/)
  assert.match(doc, /\(states\.md\)/)
})
