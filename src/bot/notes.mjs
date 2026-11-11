// Notes, index, skill drafts. Everything lives in <root>/bot (outside git). A draft is only copied into a
// skills folder by installDraft, which the bot calls only after the owner presses the Install button.
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

/** Writes <root>/bot/skill-drafts/<name>/SKILL.md (never touches any skills folder) -> { name, file, text }. */
export function saveDraft(root, s, sourceUrl) {
  const name = skillName(s.name)
  if (!name) throw new Error('invalid skill name')
  const dir = path.join(dirs(root).drafts, name)
  fs.mkdirSync(dir, { recursive: true })
  const text = skillMarkdown({ ...s, name }, sourceUrl)
  fs.writeFileSync(path.join(dir, 'SKILL.md'), text)
  return { name, file: path.join(dir, 'SKILL.md'), text }
}

/** The configured skills folder: BOT_SKILLS_DIR, else ~/.claude/skills. */
export const skillsDir = (env = process.env) => env.BOT_SKILLS_DIR || path.join(os.homedir(), '.claude', 'skills')

/**
 * Copies one draft into the skills folder. Call only after an explicit owner action. Refuses to overwrite an
 * existing skill. -> { ok, dest?, why? }
 */
export function installDraft(root, name, target) {
  const n = skillName(name)
  if (!n || n !== name) return { ok: false, why: 'bad name' }
  const src = path.join(dirs(root).drafts, n, 'SKILL.md')
  if (!fs.existsSync(src)) return { ok: false, why: 'the draft no longer exists' }
  const dest = path.join(target, n)
  if (fs.existsSync(dest)) return { ok: false, why: `a skill named ${n} already exists there; not overwritten` }
  fs.mkdirSync(dest, { recursive: true })
  fs.copyFileSync(src, path.join(dest, 'SKILL.md'))
  return { ok: true, dest }
}

/** Removes a draft folder. */
export function discardDraft(root, name) {
  const n = skillName(name)
  if (!n || n !== name) return false
  fs.rmSync(path.join(dirs(root).drafts, n), { recursive: true, force: true })
  return true
}
