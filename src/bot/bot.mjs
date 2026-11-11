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

export function readEnvFiles(env = process.env) {
  const read = (f) => {
    try {
      return parseEnv(fs.readFileSync(f, 'utf8'))
    } catch {
      return {}
    }
  }
  // The user folder's .env, then the repo's, then real environment variables (which win).
  return { ...read(path.join(botDir(env), '.env')), ...read(path.join(REPO, '.env')) }
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
      await send(`Skill draft \`${d.name}\` (stays a draft until you press Install; it came from untrusted content, so read it first):\n\`\`\`markdown\n${d.text.replace(/```/g, "'''")}\n\`\`\``, draftButtons(d.name))
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
  async function onButton(action, name) {
    if (action === 'discard') return discardDraft(root, name) ? `Discarded the draft ${name}.` : 'Nothing to discard.'
    const r = installDraft(root, name, skillsTarget())
    return r.ok ? `Installed ${name} into ${r.dest}.` : `Not installed: ${r.why}`
  }

  return { onMessage, onSlash, onButton, history }
}

// ---------- run ----------
export function main(env = process.env) {
  const fakeDir = env.BOT_DISCORD_FAKE || ''
  const cfg = botConfig(readEnvFiles(env), env)
  if (!cfg.ok && !fakeDir) {
    console.error(SETUP_HELP)
    if (cfg.why !== 'none') console.error(`(problem: ${cfg.why === 'no-token' ? 'DISCORD_BOT_TOKEN is missing' : 'DISCORD_OWNER_ID is missing or not a numeric id'})`)
    return 1
  }
  const root = userRoot(env)
  const bot = createBot({ env, root })
  const gw = createGateway({ cfg: fakeDir ? { token: cfg.token || 'fake', ownerId: cfg.ownerId || env.DISCORD_OWNER_ID || '100000000000000009' } : cfg, root, log: (m) => console.log(`[bot] ${m}`), fakeDir, ...bot })
  if (!gw.start()) return 1
  const stop = () => {
    gw.stop()
    process.exit(0)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  console.log(`[bot] running; notes go to ${path.join(root, 'bot', 'notes')}. Ctrl+C to stop.`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const code = main()
  if (code) process.exit(code)
}
export { SLASH_COMMANDS }
