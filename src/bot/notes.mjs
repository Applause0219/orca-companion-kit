// Notes, index, skill drafts. Everything lives in <root>/bot (outside git). A draft is only copied into a
// skills folder by installDraft, which the bot calls only after the owner presses the Install button.
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { skillName, slug } from './core.mjs'

const dirs = (root) => ({ notes: path.join(root, 'bot', 'notes'), drafts: path.join(root, 'bot', 'skill-drafts'), index: path.join(root, 'bot', 'notes', 'index.md') })
const day = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()

/** The markdown of one note. */
export function noteMarkdown(item, x, now = new Date()) {
  const L = [`# ${x.title || item.title || item.url}`, '', `- Source: ${item.url}`, `- Kind: ${item.kind} (read through ${item.source})`, `- Saved: ${now.toISOString()}`, `- Confidence: ${x.confidence || 'n/a'}`]
  if (item.limits?.length) L.push(`- Limits: ${item.limits.join('; ')}`)
  L.push('', '## Summary', '', x.summary || '(none)')
  if (x.tools?.length) L.push('', '## Tools and libraries', '', ...x.tools.map((t) => `- **${t.name}**${t.link ? ` (${t.link})` : ''}: ${t.purpose}`))
  if (x.techniques?.length) L.push('', '## Techniques and prompts', '', ...x.techniques.map((t) => `- ${t}`))
  if (x.skill) L.push('', '## Skill draft', '', `Draft \`${x.skill.name}\` was proposed; it stays a draft until you install it.`)
  return L.join('\n') + '\n'
}

/** Writes the note and the index line -> { file, name }. Same day and slug gets -2, -3. */
export function saveNote(root, item, x, now = new Date()) {
  const d = dirs(root)
  fs.mkdirSync(d.notes, { recursive: true })
  const base = `${day(now)}-${slug(x.title || item.title || new URL(item.url).hostname)}`
  let name = `${base}.md`
  for (let i = 2; fs.existsSync(path.join(d.notes, name)); i++) name = `${base}-${i}.md`
  fs.writeFileSync(path.join(d.notes, name), noteMarkdown(item, x, now))
  const tools = (x.tools ?? []).map((t) => t.name).join(', ')
  fs.appendFileSync(d.index, `${fs.existsSync(d.index) && fs.statSync(d.index).size ? '' : '# Notes index\n\n'}- ${day(now)} [${oneLine(x.title || item.title || item.url).slice(0, 100)}](${name}) ${tools ? `| tools: ${oneLine(tools).slice(0, 150)} ` : ''}| ${item.url}\n`)
  return { file: path.join(d.notes, name), name }
}

/** Newest notes first: [{ name, title, line }]. */
export function listNotes(root, limit = 10) {
  const d = dirs(root)
  if (!fs.existsSync(d.notes)) return []
  return fs
    .readdirSync(d.notes)
    .filter((n) => /^\d{4}-\d\d-\d\d-.+\.md$/.test(n))
    .sort()
    .reverse()
    .slice(0, limit)
    .map((name) => ({ name, title: /^# (.*)$/m.exec(fs.readFileSync(path.join(d.notes, name), 'utf8'))?.[1] ?? name }))
}

/** Case-insensitive search over note text -> [{ name, title, snippet }] (at most `limit`). */
export function searchNotes(root, q, limit = 8) {
  const d = dirs(root)
  const needle = String(q ?? '').toLowerCase().trim()
  if (!needle || !fs.existsSync(d.notes)) return []
  const out = []
  for (const name of fs.readdirSync(d.notes).filter((n) => /^\d{4}-.+\.md$/.test(n)).sort().reverse()) {
    const text = fs.readFileSync(path.join(d.notes, name), 'utf8')
    const i = text.toLowerCase().indexOf(needle)
    if (i < 0) continue
    out.push({ name, title: /^# (.*)$/m.exec(text)?.[1] ?? name, snippet: oneLine(text.slice(Math.max(0, i - 50), i + 110)) })
    if (out.length >= limit) break
  }
  return out
}

/** SKILL.md text for a draft (we write the frontmatter; the body is the model's text about untrusted content). */
export const skillMarkdown = (s, sourceUrl) =>
  `---\nname: ${s.name}\ndescription: ${oneLine(s.description) || s.name}\n---\n\n<!-- Drafted by the Discord bot from ${sourceUrl}. Review before use. -->\n\n${s.body}\n`

// ---------- skill drafts ----------
// Each draft gets its own folder <root>/bot/skill-drafts/<name>-<nonce>/ with SKILL.md and draft.json (the
// skill name and the SHA-256 of SKILL.md). The folder name (the draft id) and the first 10 hex characters of
// the hash go into the button's custom_id, so Install can only ever install the exact text the message
// showed: a newer draft with the same name, or an edited file, does not match. Installing or discarding
// removes the draft, so a button pressed twice (or after Discard) finds nothing.
export const DRAFT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const HASH10 = /^[0-9a-f]{10}$/
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex')
const draftDir = (root, id) => (DRAFT_ID.test(String(id)) && String(id).length <= 60 ? path.join(dirs(root).drafts, id) : null)

/** Writes a new draft (never touches any skills folder, never overwrites one) -> { id, name, file, text, hash }. */
export function saveDraft(root, s, sourceUrl) {
  const name = skillName(s.name)
  if (!name) throw new Error('invalid skill name')
  const text = skillMarkdown({ ...s, name }, sourceUrl)
  fs.mkdirSync(dirs(root).drafts, { recursive: true })
  for (let tries = 0; tries < 20; tries++) {
    const id = `${name}-${crypto.randomBytes(4).toString('hex')}`
    const dir = path.join(dirs(root).drafts, id)
    try {
      fs.mkdirSync(dir) // not recursive: fails when the id exists, so a draft is never overwritten
    } catch (e) {
      if (e.code === 'EEXIST') continue
      throw e
    }
    const hash = sha(text)
    fs.writeFileSync(path.join(dir, 'SKILL.md'), text)
    fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify({ name, hash, source: sourceUrl }))
    return { id, name, file: path.join(dir, 'SKILL.md'), text, hash }
  }
  throw new Error('could not allocate a draft id')
}

/** The configured skills folder: BOT_SKILLS_DIR, else ~/.claude/skills. */
export const skillsDir = (env = process.env) => env.BOT_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills')

/**
 * Copies one draft into the skills folder. Call only after an explicit owner action. `hash10` is what the
 * button carried (the hash of the text that was shown); the draft on disk must still match it. Refuses to
 * overwrite an existing skill, and removes the draft once installed. -> { ok, dest?, why? }
 */
export function installDraft(root, id, hash10, target) {
  const dir = draftDir(root, id)
  if (!dir || !HASH10.test(String(hash10))) return { ok: false, why: 'bad draft reference' }
  let meta
  let text
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'draft.json'), 'utf8'))
    text = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8')
  } catch {
    return { ok: false, why: 'the draft no longer exists (already installed or discarded)' }
  }
  const h = sha(text)
  if (h !== meta.hash || !h.startsWith(hash10)) return { ok: false, why: 'the draft does not match what was shown; not installed' }
  const name = skillName(meta.name)
  if (!name || name !== meta.name) return { ok: false, why: 'bad skill name' }
  const dest = path.join(target, name)
  if (fs.existsSync(dest)) return { ok: false, why: `a skill named ${name} already exists there; not overwritten` }
  fs.mkdirSync(dest, { recursive: true })
  fs.writeFileSync(path.join(dest, 'SKILL.md'), text)
  fs.rmSync(dir, { recursive: true, force: true })
  return { ok: true, dest, name }
}

/** Removes a draft folder. */
export function discardDraft(root, id) {
  const dir = draftDir(root, id)
  if (!dir || !fs.existsSync(dir)) return false
  fs.rmSync(dir, { recursive: true, force: true })
  return true
}
