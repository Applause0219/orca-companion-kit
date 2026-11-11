// Reads one link into plain text + metadata. Never downloads or keeps video/audio (the optional transcriber
// uses a temp folder that is deleted right away).
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertPublicUrl, safeFetchText } from './net-safe.mjs'
import { linkKind } from './core.mjs'

const MAX_TEXT = 24000 // characters handed to the model
// Threads and Instagram serve an empty app shell to browsers but fill the Open Graph tags for link-preview
// crawlers. Posing as a crawler may go against Meta's terms of use, so it is OFF by default: the ordinary
// browser identity is used. BOT_SOCIAL_UA=crawler opts in (your decision and responsibility); any other
// value is used as the User-Agent string as is.
const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uagent.php)'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)

const MAX_HTML = 1_000_000 // never parse more than this (the fetch limit is 1.5 MB; the rest of a page is not worth the time)
const MAX_TAG = 4000 // a tag longer than this is not a real tag
// Lower-cased copy with the same length (toLowerCase can change the length for a few characters: then ASCII only).
const lowerAscii = (s) => {
  const l = s.toLowerCase()
  return l.length === s.length ? l : s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
}

/** { title, description, siteName } from og:/twitter:/<title>/meta description tags. Linear: indexOf scans only. */
export function parseMeta(html) {
  const src = String(html).slice(0, MAX_HTML)
  const low = lowerAscii(src)
  const meta = {}
  let pos = 0
  let n = 0
  while (n < 400) {
    const i = low.indexOf('<meta', pos)
    if (i < 0) break
    const j = low.indexOf('>', i)
    if (j < 0) break
    pos = j + 1
    n++
    if (j - i > MAX_TAG) continue
    const tag = src.slice(i, j + 1)
    const key = /(?:property|name)\s*=\s*["']([^"']{1,80})["']/i.exec(tag)?.[1]?.toLowerCase()
    const val = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag)
    if (key && val && !(key in meta)) meta[key] = decodeEntities(val[1] ?? val[2])
  }
  let title = meta['og:title'] || meta['twitter:title'] || ''
  if (!title) {
    const t = low.indexOf('<title')
    const gt = t < 0 ? -1 : low.indexOf('>', t)
    const end = gt < 0 ? -1 : low.indexOf('<', gt)
    if (end > 0) title = decodeEntities(src.slice(gt + 1, Math.min(end, gt + 500)))
  }
  return { title: title.trim(), description: (meta['og:description'] || meta['twitter:description'] || meta.description || '').trim(), siteName: meta['og:site_name'] ?? '' }
}

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'template'])
const BREAK_TAGS = new Set(['br', 'p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'])

/** Visible text of an HTML page (scripts, styles and tags removed). One linear pass with indexOf. */
export function htmlToText(html) {
  const src = String(html).slice(0, MAX_HTML)
  const low = lowerAscii(src)
  let out = ''
  let pos = 0
  while (pos < src.length) {
    const lt = src.indexOf('<', pos)
    if (lt < 0) {
      out += src.slice(pos)
      break
    }
    out += src.slice(pos, lt)
    if (low.startsWith('<!--', lt)) {
      const e = low.indexOf('-->', lt + 4)
      if (e < 0) break
      pos = e + 3
      continue
    }
    const gt = src.indexOf('>', lt)
    if (gt < 0) break
    if (gt - lt > MAX_TAG) {
      pos = lt + 1
      out += ' '
      continue
    }
    let k = lt + 1
    const closing = low.charCodeAt(k) === 47
    if (closing) k++
    const nameStart = k
    while (k < gt && k - nameStart < 12) {
      const c = low.charCodeAt(k)
      if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k++
      else break
    }
    const name = low.slice(nameStart, k)
    pos = gt + 1
    if (!name || !(low.charCodeAt(nameStart) >= 97 && low.charCodeAt(nameStart) <= 122)) {
      out += ' '
      continue
    }
    if (!closing && SKIP_TAGS.has(name)) {
      const close = low.indexOf('</' + name, pos)
      if (close < 0) break
      const cg = src.indexOf('>', close)
      pos = cg < 0 ? src.length : cg + 1
      out += ' '
      continue
    }
    out += BREAK_TAGS.has(name) && (closing || name === 'br') ? '\n' : ' '
  }
  const joined = out
  return squeeze(joined.includes('&') ? decodeEntities(joined) : joined)
}

/** Collapses whitespace in one pass: runs of blanks become one space, runs containing a line break become one "\n". */
function squeeze(s) {
  const res = []
  let pend = '' // '' | ' ' | '\n'
  let started = false
  let from = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 160
    if (!ws) continue
    if (i > from) {
      if (pend && started) res.push(pend)
      res.push(s.slice(from, i))
      started = true
      pend = ''
    }
    from = i + 1
    if (c === 10) pend = '\n'
    else if (!pend) pend = ' '
  }
  if (from < s.length) {
    if (pend && started) res.push(pend)
    res.push(s.slice(from))
  }
  return res.join('')
}

/** WebVTT/SRT captions to plain lines, consecutive duplicates (auto-captions repeat) removed. */
export function captionsToText(vtt) {
  const lines = []
  for (const raw of String(vtt).split(/\r?\n/)) {
    const l = raw.replace(/<[^>]+>/g, '').trim()
    if (!l || /^(WEBVTT|Kind:|Language:|NOTE)/.test(l) || /-->/.test(l) || /^\d+$/.test(l)) continue
    if (lines[lines.length - 1] !== l) lines.push(l)
  }
  return decodeEntities(lines.join(' '))
}

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: opts.timeout ?? 60000, cwd: opts.cwd }, (error, stdout, stderr) => resolve({ error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }))
  })

/**
 * yt-dlp metadata and captions only (--skip-download; caption files go to a temp folder that is deleted).
 * -> { ok, title, description, captions, uploader, why }.  `ytdlp` is the executable ('' = off).
 */
export async function ytdlpInfo(url, { ytdlp = 'yt-dlp', transcriber = '', exec = run } = {}) {
  if (!ytdlp) return { ok: false, why: 'yt-dlp is off' }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-ytdlp-'))
  try {
    const args = ['--ignore-config', '--skip-download', '--no-warnings', '--no-playlist', '--write-subs', '--write-auto-subs', '--sub-langs', 'zh.*,en.*', '--sub-format', 'vtt', '--print-json', '-o', path.join(dir, 'c.%(ext)s'), '--', url]
    const r = await exec(ytdlp, args, { timeout: 90000 })
    if (r.error && !r.stdout.trim()) {
      const why = /ENOENT/.test(String(r.error.code ?? r.error.message)) ? 'yt-dlp is not installed' : /login|cookies|empty media|private|unavailable/i.test(r.stderr) ? 'login wall or unavailable without an account' : 'yt-dlp could not read it'
      return { ok: false, why }
    }
    let j = {}
    try {
      j = JSON.parse(r.stdout.trim().split('\n').pop())
    } catch {
      return { ok: false, why: 'yt-dlp output was not understood' }
    }
    const subFiles = fs.readdirSync(dir).filter((f) => f.endsWith('.vtt')).sort((a, b) => (/\.zh/.test(a) ? -1 : 0) - (/\.zh/.test(b) ? -1 : 0))
    let captions = subFiles.length ? captionsToText(fs.readFileSync(path.join(dir, subFiles[0]), 'utf8')) : ''
    let transcribed = false
    if (!captions && transcriber) {
      // Optional, off by default: audio only, into this temp folder, deleted in finally.
      const a = await exec(ytdlp, ['--ignore-config', '--no-warnings', '--no-playlist', '-f', 'bestaudio', '-o', path.join(dir, 'a.%(ext)s'), '--', url], { timeout: 180000 })
      const audio = fs.readdirSync(dir).find((f) => f.startsWith('a.'))
      if (!a.error && audio) {
        const t = await exec(transcriber, [path.join(dir, audio)], { timeout: 600000 })
        if (!t.error) {
          captions = t.stdout.trim()
          transcribed = true
        }
      }
    }
    return { ok: true, title: j.title ?? '', description: j.description ?? '', uploader: j.uploader ?? j.channel ?? '', captions, transcribed }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Reads one link. -> { url, kind, title, text, source, limits: [strings], ok }.
 * source: 'yt-dlp' | 'page' | 'og-meta'. limits: honest notes about what could not be read.
 */
export async function readLink(url, { env = process.env, fetchImpl = fetch, lookup, ytdlpExec } = {}) {
  const kind = linkKind(url)
  const limits = []
  await assertPublicUrl(url, lookup) // refuse early, before any external tool sees it
  const out = { url, kind, title: '', text: '', source: 'page', limits, ok: false }

  if (kind === 'youtube' || kind === 'instagram') {
    const ytdlp = env.BOT_YTDLP === 'off' ? '' : env.BOT_YTDLP || 'yt-dlp'
    const r = await ytdlpInfo(url, { ytdlp, transcriber: env.BOT_TRANSCRIBER ?? '', exec: ytdlpExec })
    if (r.ok) {
      const parts = [r.uploader && `Uploader: ${r.uploader}`, r.description && `Description:\n${r.description}`, r.captions && `${r.transcribed ? 'Transcript (local transcriber)' : 'Captions'}:\n${r.captions}`].filter(Boolean)
      Object.assign(out, { title: r.title, text: parts.join('\n\n'), source: 'yt-dlp', ok: !!(r.title || parts.length) })
      if (!r.captions) limits.push('no captions available: only the title and description were read, not the spoken content')
      if (out.ok) return finish(out)
    } else limits.push(`yt-dlp: ${r.why}`)
  }

  const social = kind === 'instagram' || kind === 'threads'
  const opt = String(env.BOT_SOCIAL_UA ?? '').trim()
  const ua = social && opt && opt !== 'off' ? (opt === 'crawler' ? PREVIEW_UA : opt) : BROWSER_UA
  const page = await safeFetchText(url, { headers: { 'User-Agent': ua, Accept: 'text/html,*/*;q=0.8' }, fetchImpl, lookup })
  if (page.skipped) {
    limits.push(page.skipped)
    return finish(out)
  }
  if (page.status >= 400) limits.push(`the site answered HTTP ${page.status}`)
  const meta = parseMeta(page.text)
  if (kind === 'web' || kind === 'youtube') {
    const body = htmlToText(page.text)
    Object.assign(out, { title: meta.title, text: body || meta.description, source: 'page', ok: !!(body || meta.description) })
    if (page.truncated) limits.push('the page was cut at the size limit')
    if (!body && !meta.description) limits.push('the page has no readable text (it may need JavaScript or a login)')
  } else {
    // Threads / Instagram: only the preview tags are reliable without an account.
    Object.assign(out, { title: meta.title, text: meta.description, source: 'og-meta', ok: !!meta.description })
    limits.push('login-walled platform: only the public preview text (og:title / og:description) was available, possibly shortened; no video content, no replies')
    if (!meta.description) limits.push('no preview text came back (private, deleted, blocked, or the site only gives a preview to link-preview crawlers: see BOT_SOCIAL_UA in docs/discord-bot.md)')
  }
  return finish(out)
}

function finish(o) {
  if (o.text.length > MAX_TEXT) {
    o.text = o.text.slice(0, MAX_TEXT)
    o.limits.push('text was cut to fit the model input')
  }
  return o
}
