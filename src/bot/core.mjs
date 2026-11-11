// Pure helpers for the Discord bot: env parsing, config, URL extraction, message splitting, secret masking.
import os from 'node:os'
import path from 'node:path'

export const DISCORD_MAX = 2000
export const MAX_LINKS = 5

/** The user's folder (same one the theme tools use). `$ORCA_THEMER_ROOT` overrides it. */
export const userRoot = (env = process.env) => env.ORCA_THEMER_ROOT || path.join(os.homedir(), '.orca', 'themer')
export const botDir = (env = process.env) => path.join(userRoot(env), 'bot')

/** KEY=value lines (# comments, optional quotes, `export ` prefix). */
export function parseEnv(text) {
  const out = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '')
    out[m[1]] = v
  }
  return out
}

export const validSnowflake = (s) => /^\d{15,25}$/.test(String(s ?? ''))

/** Config from env maps (later ones win) -> { token, ownerId, ok, why }. why: none | no-token | no-owner | ''. */
export function botConfig(...envs) {
  const all = Object.assign({}, ...envs)
  const token = String(all.DISCORD_BOT_TOKEN ?? '').trim()
  const ownerId = String(all.DISCORD_OWNER_ID ?? '').trim()
  const why = !token && !ownerId ? 'none' : !token ? 'no-token' : !validSnowflake(ownerId) ? 'no-owner' : ''
  return { token, ownerId, ok: !why, why }
}

export const SETUP_HELP = [
  'Discord bot is not configured.',
  'Create a .env file (in the repo folder, or in <user folder>/bot/.env) with:',
  '  DISCORD_BOT_TOKEN=<your bot token>',
  '  DISCORD_OWNER_ID=<your numeric Discord user id>',
  'Step by step: docs/discord-bot.md'
].join('\n')

/** Replaces known secrets and anything shaped like a bot token with a mask. */
export function maskSecrets(text, secrets = []) {
  let s = String(text ?? '')
  for (const v of secrets) if (typeof v === 'string' && v.length >= 6) s = s.split(v).join('[token]')
  return s.replace(/[A-Za-z\d_-]{23,28}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,40}/g, '[token]').replace(/(Bot|Bearer)\s+[A-Za-z\d._-]{20,}/g, '$1 [token]')
}

/** http(s) links in a text, in order, deduplicated, trailing punctuation trimmed. { urls, dropped }. */
export function extractUrls(text, max = MAX_LINKS) {
  const found = []
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let u = m[0].replace(/[)\]}>.,;:!?。，、；：！？」』）]+$/u, '')
    try {
      u = new URL(u).href
    } catch {
      continue
    }
    if (!found.includes(u)) found.push(u)
  }
  return { urls: found.slice(0, max), dropped: Math.max(0, found.length - max) }
}

/** Which kind of link: youtube | instagram | threads | web. */
export function linkKind(url) {
  let h = ''
  try {
    h = new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return 'web'
  }
  if (h === 'youtu.be' || h === 'youtube.com' || h.endsWith('.youtube.com')) return 'youtube'
  if (h === 'instagram.com' || h.endsWith('.instagram.com')) return 'instagram'
  if (h === 'threads.net' || h === 'threads.com' || h.endsWith('.threads.net') || h.endsWith('.threads.com')) return 'threads'
  return 'web'
}

// ---------- splitMessage ----------
const FENCE_CLOSE = '\n```'
const lowSurrogate = (s, i) => i > 0 && i < s.length && s.charCodeAt(i) >= 0xdc00 && s.charCodeAt(i) <= 0xdfff
const glued = (c) => /[A-Za-z0-9_\-./:@#%?=&~+]/.test(c ?? '')

function cutAt(s, room) {
  const last = (re) => {
    let best = 0
    for (const m of s.slice(0, room + 1).matchAll(re)) {
      const i = m.index + m[0].length
      if (i <= room && i >= Math.min(20, room / 4)) best = i
    }
    return best
  }
  for (const re of [/\n[ \t]*\n+/g, /\n/g, /[。！？；…]+[」』）)"'”’]*|[.!?;](?=\s)/g, /\s+/g]) {
    const i = last(re)
    if (i > 0) return i
  }
  for (let i = room; i > 0; i--) if (!lowSurrogate(s, i) && !(glued(s[i - 1]) && glued(s[i]))) return i
  return lowSurrogate(s, room) ? room - 1 : room
}
function fenceAfter(part, open) {
  let cur = open
  for (const m of part.matchAll(/```/g)) {
    if (cur) {
      cur = ''
      continue
    }
    cur = '```' + (/^[\w+#.-]{0,20}(?=[ \t]*(\n|$))/.exec(part.slice(m.index + 3))?.[0] ?? '')
  }
  return cur
}
/**
 * One long text as several Discord-sized messages, in order, nothing dropped. Cut at blank lines, line
 * breaks, sentence ends, spaces; never inside a URL or word unless one run exceeds a whole message. A
 * ``` block cut in the middle is closed and reopened (same language tag) in the next part.
 */
export function splitMessage(text, limit = DISCORD_MAX) {
  let rest = String(text ?? '').replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '')
  const out = []
  let open = ''
  while (rest) {
    const head = open ? `${open}\n` : ''
    if (head.length + rest.length <= limit) {
      out.push(head + rest)
      break
    }
    const room = Math.max(1, limit - head.length - FENCE_CLOSE.length)
    const cut = cutAt(rest, room)
    const state = fenceAfter(rest.slice(0, cut), open)
    let part = rest.slice(0, cut).trimEnd()
    rest = rest.slice(cut)
    if (state) part += FENCE_CLOSE
    rest = rest.replace(/^\s+/, '')
    out.push(head + part)
    open = state
  }
  return out
}

export const slug = (s, max = 48) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '') || 'note'

/** A skill folder name: lowercase letters, digits, hyphens only. */
export const skillName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')
