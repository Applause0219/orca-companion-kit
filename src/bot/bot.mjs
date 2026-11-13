// Private Discord DM bot: chat through your own `claude -p`, and read links (Instagram Reels, Threads, YouTube,
// ordinary pages) into notes and skill drafts. Runs standalone: `npm run bot`. No Orca needed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callClaude, createHistory, loadPersona } from './brain.mjs'
import { SETUP_HELP, botConfig, botDir, extractUrls, parseEnv, userRoot } from './core.mjs'
import { extract } from './extract.mjs'
import { SLASH_COMMANDS, createGateway, draftButtons } from './gateway.mjs'
import { readLink } from './intake.mjs'
import { BlockedError } from './net-safe.mjs'
import { discardDraft, installDraft, listNotes, saveDraft, saveNote, searchNotes, skillsDir } from './notes.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** `repo` is the folder whose .env is read second; tests point it at an empty folder so a real .env is never used. */
export function readEnvFiles(env = process.env, repo = REPO) {
  const read = (f) => {
    try {
      return parseEnv(fs.readFileSync(f, 'utf8'))
    } catch {
      return {}
    }
  }
  // The user folder's .env, then the repo's, then real environment variables (which win).
  return { ...read(path.join(botDir(env), '.env')), ...read(path.join(repo, '.env')) }
}

/**
 * The environment the bot runs with: the real one, plus the optional BOT_* settings from the .env files
 * (a real environment variable wins). This env is handed to every `claude` child process, so every DISCORD_*
 * variable is left out, wherever it came from: the token and owner id only ever go to the gateway (botConfig).
 */
export function botEnv(fileEnv = {}, env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!/^DISCORD_/i.test(k)) out[k] = v
  for (const [k, v] of Object.entries(fileEnv)) if (/^BOT_[A-Z0-9_]+$/.test(k) && out[k] === undefined) out[k] = v
  return out
}

/**
 * The bot's behaviour, separate from the transport so tests drive it directly.
 * @param {{ env?: object, root?: string, read?: Function, call?: Function }} o
 */
export function createBot({ env = process.env, root = userRoot(env), read = readLink, call = callClaude } = {}) {
  const model = env.BOT_MODEL || ''
  const history = createHistory(Number(env.BOT_HISTORY_TURNS) || 10)
  const skillsTarget = () => skillsDir(env)

  async function chat(text, send) {
    history.add('user', text)
    const r = await call({ prompt: `${history.render()}\n\nAssistant:`, system: loadPersona(path.join(root, 'bot')), model, env })
    if (!r.ok) return void (await send(`I could not reach Claude: ${r.error}`))
    history.add('assistant', r.text)
    await send(r.text)
  }

  async function intake(url, send) {
    let item
    try {
      item = await read(url, { env })
    } catch (e) {
      const why = e instanceof BlockedError ? `refused (${e.message})` : `could not be fetched (${e.name === 'TimeoutError' ? 'timed out' : e.message})`
      return void (await send(`${url}\n${why}`))
    }
    const x = await extract(item, { model, env, call })
    const saved = saveNote(root, item, x)
    const L = [`**${x.title || item.title || url}**`, url, '', x.summary]
    if (x.tools.length) L.push('', '**Tools**', ...x.tools.map((t) => `- ${t.name}${t.link ? ` <${t.link}>` : ''}: ${t.purpose}`))
    if (x.techniques.length) L.push('', '**Techniques**', ...x.techniques.map((t) => `- ${t}`))
    L.push('', `Confidence: ${x.confidence || 'n/a'}`)
    if (item.limits.length) L.push(`Limits: ${item.limits.join('; ')}`)
    L.push(`-# Saved as ${saved.name}`)
    await send(L.join('\n'))
    if (x.skill) {
      const d = saveDraft(root, x.skill, url)
      // The whole draft is shown, so the decision is made on what will really be installed.
      await send(`Skill draft \`${d.name}\` (stays a draft until you press Install; it came from untrusted content, so read it first):\n\`\`\`markdown\n${d.text.replace(/```/g, "'''")}\n\`\`\``, draftButtons(d.id, d.hash.slice(0, 10)))
    }
  }

  async function onMessage(text, send) {
    const { urls, dropped } = extractUrls(text)
    if (!urls.length) return chat(text, send)
    if (dropped) await send(`Only the first ${urls.length} links are read; ${dropped} more were skipped.`)
    for (const u of urls) {
      await send(`Reading ${u} ...`)
      await intake(u, send)
    }
  }

  async function onSlash(name, args) {
    if (name === 'notes') {
      const l = listNotes(root, 10)
      return l.length ? l.map((n) => `- ${n.title} (${n.name})`).join('\n') : 'No notes yet. Send me a link.'
    }
    if (name === 'search') {
      const l = searchNotes(root, args.q)
      return l.length ? l.map((n) => `- ${n.title} (${n.name})\n  ${n.snippet}`).join('\n') : `Nothing found for "${args.q}".`
    }
    return 'Unknown command.'
  }

  // Only the gateway calls this, and only for a button the owner pressed.
  async function onButton(action, id, hash) {
    if (action === 'discard') return discardDraft(root, id) ? `Discarded the draft ${id}.` : 'Nothing to discard.'
    const r = installDraft(root, id, hash, skillsTarget())
    return r.ok ? `Installed ${r.name} into ${r.dest}.` : `Not installed: ${r.why}`
  }

  return { onMessage, onSlash, onButton, history }
}

// ---------- run ----------
/**
 * Reads the config (.env files + real env) and starts the gateway -> { code, stop, root }. `code` 1 means it
 * did not start. Tests call this with BOT_DISCORD_FAKE; main() adds the signal handling.
 */
export function startBot(env = process.env, { log = (m) => console.log(`[bot] ${m}`), repo = REPO } = {}) {
  const fileEnv = readEnvFiles(env, repo)
  const cfg = botConfig(fileEnv, env) // the only place the token and owner id are read
  const runEnv = botEnv(fileEnv, env) // what the bot and its claude calls see: no DISCORD_* in it
  const fakeDir = runEnv.BOT_DISCORD_FAKE || ''
  if (!cfg.ok && !fakeDir) {
    console.error(SETUP_HELP)
    if (cfg.why !== 'none') console.error(`(problem: ${cfg.why === 'no-token' ? 'DISCORD_BOT_TOKEN is missing' : 'DISCORD_OWNER_ID is missing or not a numeric id'})`)
    return { code: 1, stop: () => {} }
  }
  const root = userRoot(runEnv)
  const bot = createBot({ env: runEnv, root })
  const gw = createGateway({ cfg: fakeDir ? { token: cfg.token || 'fake', ownerId: cfg.ownerId || '100000000000000009' } : cfg, root, log, fakeDir, ...bot })
  if (!gw.start()) return { code: 1, stop: () => {} }
  return { code: 0, stop: () => gw.stop(), root }
}

export function main(env = process.env) {
  const r = startBot(env)
  if (r.code) return r.code
  const stop = () => {
    r.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.log(`[bot] running; notes go to ${path.join(r.root, 'bot', 'notes')}. Ctrl+C to stop.`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main()
  if (code) process.exit(code)
}
export { SLASH_COMMANDS }
