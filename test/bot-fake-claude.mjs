// A stand-in for `claude -p` used by the bot tests (BOT_CLAUDE). Reads the prompt on stdin.
// Extraction prompts get JSON (with a skill draft when the content asks for one); chat prompts get an echo.
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', () => {
  if (process.env.BOT_FAKE_LOG) {
    import('node:fs').then((fs) => fs.appendFileSync(process.env.BOT_FAKE_LOG, JSON.stringify({ args: process.argv.slice(2), input, discordKeys: Object.keys(process.env).filter((k) => /^DISCORD_/i.test(k)), notesLanguage: process.env.BOT_NOTES_LANGUAGE ?? null }) + '\n'))
  }
  if (input.includes('BEGIN UNTRUSTED CONTENT')) {
    const draft = /MAKE-A-SKILL/.test(input)
    console.log(JSON.stringify({
      title: 'Fake title',
      summary: 'A fake summary.',
      tools: [{ name: 'yt-dlp', link: 'https://github.com/yt-dlp/yt-dlp', purpose: 'reads video metadata' }],
      techniques: ['Use captions instead of audio'],
      skill_draft: draft ? { name: 'Caption-Reader!', description: 'Read captions of a video', body: '1. Run the tool.\n2. Read the text.' + (/version (\d+)/.exec(input) ? ` v${/version (\d+)/.exec(input)[1]}` : '') } : null,
      confidence: 'medium: fake'
    }))
  } else console.log('echo: ' + input.split('\n').filter(Boolean).pop())
})
