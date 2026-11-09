// Built-in touches with no code of their own: a theme lists them in @touches and keys CSS or launcher
// behavior on them.
;(() => {
  const T = window.__orcaThemer
  if (!T) return

  // custom-cursor: sets html[data-orca-touch-custom-cursor]; the theme's CSS draws the cursor under it,
  // so the picker can turn the cursor off without editing the theme. See docs/cursor.md.
  T.registerAttrTouch('custom-cursor', { label: '自訂游標', description: '換成主題附的游標' })

  // editor-bg: sets html[data-orca-touch-editor-bg]; the theme's Monaco rule (editor background, gutter,
  // line numbers) sits under it, so turning it off lets a syntax-highlight plugin's colors show. still: only
  // colors, so reduced motion leaves it on (the background did not depend on that setting before it was a touch).
  T.registerAttrTouch('editor-bg', { label: '編輯器底色', description: '檔案編輯器的底色跟著主題；關掉就交給語法高亮外掛', still: true })

  // theme-sound: while on, the launcher sets Orca's notification sound to sounds/<theme id>.wav and puts
  // the old one back when it is turned off.
  T.registerTouch('theme-sound', {
    label: '通知音效',
    description: '系統通知改用主題附的音效，關掉就換回原本的',
    start() {}
  })
})()
