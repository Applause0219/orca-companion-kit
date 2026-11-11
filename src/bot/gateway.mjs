// A private Discord DM bridge with no dependencies: Node's own WebSocket for the gateway, fetch for REST.
// Only DMs from the configured owner are read, and the bot only ever writes to that one user. One bot per
// machine (a lock file holds the pid). Slash commands and buttons from anyone but the owner are refused.
//
// Tests: BOT_DISCORD_FAKE=<dir> replaces Discord with files. <dir>/in/*.json are incoming events (a message in
// MESSAGE_CREATE shape, or an interaction with type 2 slash / type 3 button); what the bot sends lands in
// <dir>/out/*.json, interaction responses in <dir>/interactions, registered commands in <dir>/commands. No
// network at all.
import fs from 'node:fs'
import path from 'node:path'
import { DISCORD_MAX, maskSecrets, splitMessage, validSnowflake } from './core.mjs'

const API = 'https://discord.com/api/v10'
// DIRECT_MESSAGES (1<<12) and MESSAGE_CONTENT (1<<15; a privileged intent, switch it on in the developer portal)
const INTENTS = (1 << 12) | (1 << 15)
const MAX_PARTS = 20
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
/** Takes the machine-wide lock unless a live other process holds it. */
export function takeLock(file, pid = process.pid) {
  try {
    const held = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (held?.pid && held.pid !== pid && alive(held.pid)) return false
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid, at: Date.now() }))
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid
  } catch {
    return false
  }
}
export function dropLock(file, pid = process.pid) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file, { force: true })
  } catch {}
}

/** A DM from the owner: not a bot, not in a server, author is the owner. */
export function isOwnerDm(msg, ownerId) {
  return !!msg && !msg.guild_id && !msg.author?.bot && String(msg.author?.id ?? '') === String(ownerId) && typeof msg.content === 'string'
}
export const interactionUser = (d) => String(d?.user?.id ?? d?.member?.user?.id ?? '')

/** A row of Install / Discard buttons for a skill draft. */
export const draftButtons = (name) => [
  { type: 1, components: [
    { type: 2, style: 3, label: 'Install skill', custom_id: `bot:install:${name}` },
    { type: 2, style: 4, label: 'Discard', custom_id: `bot:discard:${name}` }
  ] }
]

/** The commands the bot registers. */
export const SLASH_COMMANDS = Object.freeze([
  { name: 'notes', description: 'List the latest saved notes', type: 1, contexts: [1], integration_types: [1] },
  { name: 'search', description: 'Search the saved notes', type: 1, contexts: [1], integration_types: [1], options: [{ type: 3, name: 'q', description: 'Text to look for', required: true, max_length: 200 }] }
])

/**
 * @param {{ cfg: {token:string, ownerId:string}, root: string, log?: Function, fakeDir?: string,
 *   onMessage: (text: string, send: (t: string, components?: any[]) => Promise<any>) => Promise<void>,
 *   onSlash: (name: string, args: Record<string,string>) => Promise<string>,
 *   onButton: (action: string, arg: string) => Promise<string> }} o
 */
export function createGateway({ cfg, root, log = () => {}, fakeDir = '', onMessage, onSlash, onButton }) {
  const lockFile = path.join(root, 'bot', 'bot.lock')
  const say = (...p) => log(maskSecrets(p.join(' '), [cfg.token]))
  let state = 'starting'
  let stopped = false
  let ws = null
  let beat = 0
  let seq = null
  let session = null
  let dmChannel = null
  let backoff = 2000
  let appId = ''
  let fakeTimer = 0
  let fakeN = 0
  let chain = Promise.resolve() // incoming messages one at a time

  async function rest(method, route, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch(`${API}${route}`, {
        method,
        headers: { Authorization: `Bot ${cfg.token}`, 'Content-Type': 'application/json', 'User-Agent': 'DiscordBot (orca-companion-kit, 1)' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000)
      })
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}))
        await sleep(Math.min(10000, (Number(j.retry_after) || 1) * 1000))
        continue
      }
      if (!r.ok) throw new Error(`discord ${method} ${route.replace(/\/(interactions|webhooks)\/[^/]+\/[^/?]+/, '/$1/<id>/<token>').replace(/\d{15,}/g, '<id>')} -> ${r.status}`)
      return r.status === 204 ? null : r.json()
    }
    throw new Error('discord: rate limited')
  }
  function fakeWrite(dir, data) {
    const out = path.join(fakeDir, dir)
    fs.mkdirSync(out, { recursive: true })
    const file = path.join(out, `${Date.now()}-${String(++fakeN).padStart(6, '0')}.json`)
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(data))
    fs.renameSync(`${file}.tmp`, file)
  }
  async function post(payload) {
    if (fakeDir) return fakeWrite('out', { to: cfg.ownerId, ...payload })
    if (!dmChannel) dmChannel = (await rest('POST', '/users/@me/channels', { recipient_id: cfg.ownerId })).id
    await rest('POST', `/channels/${dmChannel}/messages`, { ...payload, allowed_mentions: { parse: [] } })
  }

  let sending = Promise.resolve()
  /** A message to the owner (never anyone else); long text goes out as several messages, buttons on the last. */
  function send(text, components = null) {
    const parts = splitMessage(text, DISCORD_MAX)
    if (!parts.length || stopped || state !== 'connected') return Promise.resolve(false)
    const shown = parts.slice(0, MAX_PARTS)
    const run = sending.then(async () => {
      for (let i = 0; i < shown.length; i++) {
        try {
          await post({ content: shown[i], ...(components && i === shown.length - 1 ? { components } : {}) })
        } catch (e) {
          say('send failed', e.message)
          return false
        }
      }
      return true
    })
    sending = run.catch(() => {})
    return run
  }
  const typing = () => (fakeDir || state !== 'connected' || !dmChannel ? null : rest('POST', `/channels/${dmChannel}/typing`).catch(() => {}))

  function handle(msg) {
    if (!isOwnerDm(msg, cfg.ownerId)) return
    chain = chain.then(async () => {
      typing()
      const t = setInterval(typing, 8000)
      try {
        await onMessage(msg.content, send)
      } catch (e) {
        say('message failed', e.message)
        await send('Something went wrong while handling that message.')
      } finally {
        clearInterval(t)
      }
    })
  }

  async function respond(d, body) {
    if (fakeDir) return fakeWrite('interactions', { interaction: d.id, ...body })
    await rest('POST', `/interactions/${d.id}/${d.token}/callback`, body)
  }
  const seenInteractions = new Set()
  async function handleInteraction(d) {
    if (!d || seenInteractions.has(d.id)) return
    seenInteractions.add(d.id)
    if (seenInteractions.size > 200) seenInteractions.delete(seenInteractions.values().next().value)
    try {
      if (interactionUser(d) !== String(cfg.ownerId)) return void (await respond(d, { type: 4, data: { flags: 64, content: 'This bot is private.' } }))
      if (d.type === 2) {
        const args = Object.fromEntries((d.data?.options ?? []).map((o) => [o.name, String(o.value ?? '')]))
        // Reading notes is quick; Discord wants an answer within 3 seconds.
        const text = await onSlash(String(d.data?.name ?? ''), args)
        return void (await respond(d, { type: 4, data: { flags: 64, content: String(text).slice(0, 1900) } }))
      }
      if (d.type === 3) {
        const m = /^bot:(install|discard):([a-z0-9-]{1,48})$/.exec(String(d.data?.custom_id ?? ''))
        if (!m) return void (await respond(d, { type: 6 }))
        // The buttons go away at once so a second press does nothing; then the work, then the result.
        await respond(d, { type: 7, data: { components: [] } })
        const text = await onButton(m[1], m[2])
        await send(text)
      }
    } catch (e) {
      say('interaction failed', e.message)
    }
  }

  async function registerCommands() {
    if (!appId) return
    try {
      if (fakeDir) fakeWrite('commands', { appId, commands: SLASH_COMMANDS })
      else await rest('PUT', `/applications/${appId}/commands`, SLASH_COMMANDS)
    } catch (e) {
      say('slash commands not registered', e.message)
    }
  }

  function connect() {
    if (stopped) return
    const resume = session
    const open = async () => {
      const url = resume?.url ?? (await rest('GET', '/gateway/bot')).url
      const sock = (ws = new WebSocket(`${url}/?v=10&encoding=json`))
      const stall = setTimeout(() => state !== 'connected' && sock.readyState < 2 && sock.close(), 60000)
      sock.addEventListener('close', () => clearTimeout(stall))
      const hb = () => sock.readyState === 1 && sock.send(JSON.stringify({ op: 1, d: seq }))
      sock.onmessage = (ev) => {
        let p
        try {
          p = JSON.parse(ev.data)
        } catch {
          return
        }
        if (p.s != null) seq = p.s
        if (p.op === 10) {
          clearInterval(beat)
          setTimeout(hb, Math.random() * p.d.heartbeat_interval)
          beat = setInterval(hb, p.d.heartbeat_interval)
          if (resume) sock.send(JSON.stringify({ op: 6, d: { token: cfg.token, session_id: resume.id, seq } }))
          else sock.send(JSON.stringify({ op: 2, d: { token: cfg.token, intents: INTENTS, properties: { os: process.platform, browser: 'orca-companion-kit', device: 'orca-companion-kit' } } }))
        } else if (p.op === 1) hb()
        else if (p.op === 7) sock.close(4900, 'reconnect')
        else if (p.op === 9) {
          if (!p.d) session = null
          sock.close(4901, 'invalid session')
        } else if (p.op === 0) {
          if (p.t === 'READY') {
            session = { id: p.d.session_id, url: p.d.resume_gateway_url }
            appId = String(p.d.application?.id ?? '')
            state = 'connected'
            backoff = 2000
            say('connected')
            registerCommands()
          } else if (p.t === 'RESUMED') state = 'connected'
          else if (p.t === 'MESSAGE_CREATE') handle(p.d)
          else if (p.t === 'INTERACTION_CREATE') handleInteraction(p.d)
        }
      }
      sock.onclose = (ev) => {
        clearInterval(beat)
        ws = null
        if (stopped) return
        if (ev.code === 4004) return void ((state = 'bad-token'), say('token rejected (4004); bot off'))
        if (ev.code === 4014 || ev.code === 4013) return void ((state = 'intents'), say(`intents not allowed (${ev.code}); switch on Message Content Intent in the developer portal`))
        if ([4010, 4011, 4012].includes(ev.code)) return void ((state = 'error'), say(`closed ${ev.code}; bot off`))
        if (state === 'connected') state = 'starting'
        if (![4900, 4901, 1000].includes(ev.code)) session = null
        setTimeout(connect, backoff)
        backoff = Math.min(60000, backoff * 2)
      }
      sock.onerror = () => {}
    }
    open().catch((e) => {
      say('connect failed', e.message)
      if (/-> 401/.test(e.message)) return void (state = 'bad-token')
      setTimeout(connect, backoff)
      backoff = Math.min(60000, backoff * 2)
    })
  }

  function startFake() {
    const inbox = path.join(fakeDir, 'in')
    fs.mkdirSync(inbox, { recursive: true })
    state = 'connected'
    appId = '100000000000000001'
    say('fake gateway on')
    registerCommands()
    fakeTimer = setInterval(() => {
      for (const name of fs.readdirSync(inbox).filter((n) => n.endsWith('.json')).sort()) {
        const file = path.join(inbox, name)
        let ev
        try {
          ev = JSON.parse(fs.readFileSync(file, 'utf8'))
          fs.rmSync(file, { force: true })
        } catch {
          continue
        }
        if (ev?.token && (ev.type === 2 || ev.type === 3)) handleInteraction(ev)
        else handle(ev)
      }
    }, 100)
  }

  return {
    start() {
      if (stopped) return false
      if (!takeLock(lockFile)) {
        state = 'locked'
        say('another bot process is already running on this machine')
        return false
      }
      fakeDir ? startFake() : connect()
      return true
    },
    stop() {
      stopped = true
      clearInterval(beat)
      clearInterval(fakeTimer)
      try {
        ws?.close(1000)
      } catch {}
      dropLock(lockFile)
    },
    send,
    get state() {
      return state
    }
  }
}
export { validSnowflake }
