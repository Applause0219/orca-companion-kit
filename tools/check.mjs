// `npm run check`: lints your user folder (~/.orca/themer, or $ORCA_THEMER_ROOT, or a folder you pass)
// for the known performance traps, syntax-checks your touches, and checks theme headers and terminal
// palettes. Exit code 1 when anything is an error.
//   npm run check                 # the user folder
//   npm run check -- --repo       # this repo's themes and examples
//   npm run check -- <folder>     # any folder laid out like the user folder
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { lintCss, lintTerminal, lintTouch } from '../src/lint.mjs'
import { loadLibrary } from '../src/themes.mjs'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const roots = args.includes('--repo')
  ? [REPO, path.join(REPO, 'examples')]
  : [args.find((a) => !a.startsWith('--')) || process.env.ORCA_THEMER_ROOT || path.join(os.homedir(), '.orca', 'themer')]

const list = (dir, ext) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith(ext)).sort().map((n) => path.join(dir, n)) : [])
let errors = 0
let warnings = 0
let files = 0
const report = (file, issues) => {
  files++
  for (const i of issues) {
    i.level === 'error' ? errors++ : warnings++
    console.log(`${i.level === 'error' ? 'ERROR' : 'warn '} ${path.relative(process.cwd(), file)}:${i.line}  [${i.rule}] ${i.message}`)
  }
}

for (const root of roots) {
  if (!fs.existsSync(root)) {
    console.log(`(no folder at ${root}; run Orca once through the launcher, or npm run example)`)
    continue
  }
  for (const kind of ['themes', 'snippets']) for (const file of list(path.join(root, kind), '.css')) report(file, lintCss(fs.readFileSync(file, 'utf8')))
  for (const file of list(path.join(root, 'touches'), '.js')) report(file, lintTouch(fs.readFileSync(file, 'utf8'), file))
  for (const file of list(path.join(root, 'terminal'), '.json')) report(file, lintTerminal(fs.readFileSync(file, 'utf8')))
  // Theme headers: a name, and touches that some file actually registers.
  const known = new Set(['power-mode', 'custom-cursor', 'editor-bg', 'theme-sound'])
  for (const dir of [path.join(REPO, 'src', 'touches'), path.join(root, 'touches')])
    for (const file of list(dir, '.js'))
      for (const m of fs.readFileSync(file, 'utf8').matchAll(/(?:registerTouch|registerAttrTouch)\(\s*['"`]([\w-]+)|registerCompanion\(\s*\{[\s\S]*?\bid:\s*['"`]([\w-]+)/g)) known.add(m[1] ?? m[2])
  for (const theme of loadLibrary(root).themes) {
    const issues = []
    if (theme.name === theme.id) issues.push({ level: 'warn', line: 1, rule: 'header', message: 'no @name in the header comment' })
    for (const t of theme.touches) if (!known.has(t)) issues.push({ level: 'warn', line: 1, rule: 'unknown-touch', message: `@touches lists "${t}", but no touch file registers it` })
    if (issues.length) report(theme.file, issues)
  }
}
console.log(`\nchecked ${files} file(s): ${errors} error(s), ${warnings} warning(s)`)
process.exit(errors ? 1 : 0)
