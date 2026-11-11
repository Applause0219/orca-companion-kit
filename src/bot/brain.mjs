// Calls the user's own `claude -p` (their login, their quota). Prompt on stdin, no tools, arg arrays only.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_PERSONA = 'You are a helpful, concise assistant in a private Discord chat. Answer in the language the user writes in. Keep replies short unless asked for detail.'

/**
 * One claude call. `BOT_CLAUDE` may name a replacement: a .mjs/.js file (run with node) or an executable
 * (tests use this). Never throws: { ok, text, error }.
 */
export function callClaude({ prompt, system = '', model = '', env = process.env, timeoutMs = 120000, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const override = env.BOT_CLAUDE || ''
    const isScript = /\.(m?js|cjs)$/i.test(override)
    const cmd = override ? (isScript ? process.execPath : override) : 'claude'
    const args = ['-p', '--tools', '', '--no-session-persistence', '--disable-slash-commands', '--output-format', 'text']
    if (model) args.push('--model', model)
    if (system) args.push('--system-prompt', system)
    const argv = override && isScript ? [override, ...args] : args
    // An empty working folder, so nothing in a project is picked up as context.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-claude-'))
    let child
    let out = ''
    let err = ''
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fs.rmSync(cwd, { recursive: true, force: true })
      resolve(r)
    }
    try {
      child = spawnImpl(cmd, argv, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return done({ ok: false, text: '', error: e.message })
    }
    const timer = setTimeout(() => {
      child.kill()
      done({ ok: false, text: out, error: 'timed out' })
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => done({ ok: false, text: '', error: e.code === 'ENOENT' ? 'the claude command was not found (is Claude Code installed and on PATH?)' : e.message }))
    child.on('close', (code) => done(code === 0 && out.trim() ? { ok: true, text: out.trim(), error: '' } : { ok: false, text: out, error: err.trim().slice(0, 300) || `exit ${code}` }))
    child.stdin.on('error', () => {})
    child.stdin.end(prompt)
  })
}

/** Rolling chat history: keeps the last `max` turns. */
export function createHistory(max = 10) {
  const turns = []
  return {
    add(role, text) {
      turns.push({ role, text: String(text).slice(0, 4000) })
      while (turns.length > max * 2) turns.shift()
    },
    render: () => turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text}`).join('\n\n'),
    size: () => turns.length
  }
}

/** The persona text: <botDir>/persona.md when present, else the neutral default. */
export function loadPersona(dir) {
  try {
    const t = fs.readFileSync(path.join(dir, 'persona.md'), 'utf8').trim()
    if (t) return t
  } catch {}
  return DEFAULT_PERSONA
}
