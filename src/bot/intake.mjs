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
// crawlers. This identifies as one for those hosts only; override with BOT_SOCIAL_UA, or set it to "off".
const PREVIEW_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uagent.php)'
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
export const decodeEntities = (s) =>
  String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)

/** { title, description, siteName, image } from og:/twitter:/<title>/meta description tags. */
export function parseMeta(html) {
  const meta = {}
  for (const m of String(html).matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0]
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase()
    const val = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag)
    if (key && val && !(key in meta)) meta[key] = decodeEntities(val[1] ?? val[2])
  }
  const title = meta['og:title'] || meta['twitter:title'] || decodeEntities(/<title[^>]*>([^<]*)/i.exec(html)?.[1] ?? '').trim()
  return { title: title.trim(), description: (meta['og:description'] || meta['twitter:description'] || meta.description || '').trim(), siteName: meta['og:site_name'] ?? '' }
}

/** Visible text of an HTML page (scripts, styles and tags removed). */
export function htmlToText(html) {
  return decodeEntities(
    String(html)
      .replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
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
    const args = ['--skip-download', '--no-warnings', '--no-playlist', '--write-subs', '--write-auto-subs', '--sub-langs', 'zh.*,en.*', '--sub-format', 'vtt', '--print-json', '-o', path.join(dir, 'c.%(ext)s'), '--', url]
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
      const a = await exec(ytdlp, ['--no-warnings', '--no-playlist', '-f', 'bestaudio', '-o', path.join(dir, 'a.%(ext)s'), '--', url], { timeout: 180000 })
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
  const ua = social ? (env.BOT_SOCIAL_UA === 'off' ? BROWSER_UA : env.BOT_SOCIAL_UA || PREVIEW_UA) : BROWSER_UA
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
    if (!meta.description) limits.push('no preview text came back (private, deleted, or blocked)')
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
