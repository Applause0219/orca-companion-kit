// Puff: the example companion. A small cloud-sheep that naps on your sidebar and drizzles when worried.
// An original character made for this kit (CC0-style: copy it, change it, make it yours).
//
// This file is all a companion needs: an SVG with named groups, the selectors for those groups, a few
// lines, a few words it listens for, and its own acts. Everything else (drag, throw, follow, gaze, moods,
// speech limits, bond memory, agent tabs...) comes from src/touches/companion.js.
//
// To use it: `npm run example` copies this file to ~/.orca/themer/touches/, and the example theme lists
// `puff` in its @touches. To make your own, copy this file under a new name and change the id.
;(() => {
  const T = window.__orcaThemer
  if (!T?.registerCompanion) return

  // viewBox 120x120; drawn at 64px. Ids are prefixed (puff-) so they cannot clash with Orca or other pets.
  // Named groups (the class names) are what `parts` below points at.
  const SVG = `<svg viewBox="0 0 120 120" overflow="visible" style="filter:drop-shadow(0 2px 4px rgb(0 0 0 / .25))">
    <defs>
      <radialGradient id="puff-wool" cx="40%" cy="30%" r="75%">
        <stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#f4f1fb"/><stop offset="1" stop-color="#d9d3ee"/>
      </radialGradient>
      <linearGradient id="puff-face" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5b5470"/><stop offset="1" stop-color="#3f3a52"/>
      </linearGradient>
    </defs>
    <g class="puff-legs" fill="#4a4460">
      <rect x="44" y="86" width="7" height="14" rx="3.5"/><rect x="56" y="88" width="7" height="13" rx="3.5"/>
      <rect x="66" y="88" width="7" height="13" rx="3.5"/><rect x="77" y="86" width="7" height="14" rx="3.5"/>
    </g>
    <g class="puff-body" fill="url(#puff-wool)" stroke="#ffffff" stroke-opacity=".9" stroke-width="1.2">
      <circle cx="38" cy="64" r="19"/><circle cx="82" cy="64" r="19"/><circle cx="48" cy="80" r="17"/>
      <circle cx="74" cy="80" r="17"/><circle cx="60" cy="54" r="26"/><circle cx="60" cy="80" r="16"/>
    </g>
    <g class="puff-tuft" fill="url(#puff-wool)" stroke="#ffffff" stroke-width="1">
      <circle cx="52" cy="31" r="8"/><circle cx="63" cy="27" r="9"/><circle cx="71" cy="33" r="6.5"/>
    </g>
    <g class="puff-ear-l" data-origin="right center"><ellipse cx="38" cy="58" rx="9" ry="4.6" transform="rotate(-24 38 58)" fill="#5b5470"/><ellipse cx="39" cy="58" rx="5" ry="2.2" transform="rotate(-24 39 58)" fill="#f2b8c8"/></g>
    <g class="puff-ear-r" data-origin="left center"><ellipse cx="82" cy="58" rx="9" ry="4.6" transform="rotate(24 82 58)" fill="#5b5470"/><ellipse cx="81" cy="58" rx="5" ry="2.2" transform="rotate(24 81 58)" fill="#f2b8c8"/></g>
    <ellipse cx="60" cy="64" rx="17" ry="16" fill="url(#puff-face)"/>
    <g class="puff-eyes" fill="#ffffff">
      <circle cx="53.5" cy="62" r="2.8"/><circle cx="66.5" cy="62" r="2.8"/>
      <circle cx="54.4" cy="61" r=".9" fill="#5b5470"/><circle cx="67.4" cy="61" r=".9" fill="#5b5470"/>
    </g>
    <g class="puff-eyes-happy" fill="none" stroke="#ffffff" stroke-width="1.8" stroke-linecap="round">
      <path d="M50.5 63q3-3.6 6 0"/><path d="M63.5 63q3-3.6 6 0"/>
    </g>
    <g class="puff-eyes-sleep" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round">
      <path d="M50.5 62q3 2.6 6 0"/><path d="M63.5 62q3 2.6 6 0"/>
    </g>
    <g class="puff-glasses" fill="rgb(214 232 255 / .25)" stroke="#ffd978" stroke-width="2" stroke-linecap="round">
      <circle cx="53.5" cy="62" r="5.6"/><circle cx="66.5" cy="62" r="5.6"/>
      <path d="M59.1 61.5q.9-1.4 1.8 0M47.9 61L44 59.5M72.1 61l3.9-1.5" fill="none"/>
    </g>
    <g fill="#f2a7bd" opacity=".55"><ellipse cx="49" cy="70" rx="3.2" ry="1.8"/><ellipse cx="71" cy="70" rx="3.2" ry="1.8"/></g>
    <path d="M57.5 70.5q2.5 2 5 0" fill="none" stroke="#ffffff" stroke-opacity=".85" stroke-width="1.2" stroke-linecap="round"/>
  </svg>`

  // A small rain cloud over its head, for when it is worried. Plain DOM + WAAPI, cleaned up on finish.
  function drizzle(api) {
    const { host, center, size } = api
    const c = center()
    for (let i = 0; i < 6; i++) {
      const drop = document.createElement('div')
      drop.style.cssText = `position:absolute;left:${c.x - 14 * size + Math.random() * 28 * size}px;top:${c.y - 40 * size}px;width:3px;height:7px;border-radius:2px;background:#9fc4ff;pointer-events:none`
      host.appendChild(drop)
      drop.animate([{ transform: 'translateY(0)', opacity: 0.9 }, { transform: `translateY(${26 * size}px)`, opacity: 0 }], { duration: 700, delay: i * 120, easing: 'ease-in' }).onfinish = () => drop.remove()
    }
  }

  T.registerCompanion({
    id: 'puff',
    label: '棉花羊 Puff',
    title: 'Puff',
    // Typing one of these in a line you send makes it perk up (case-insensitive, plain text).
    names: ['puff', '棉花羊'],
    svg: SVG,
    size: 64,
    parts: {
      eyes: '.puff-eyes',
      happyEyes: '.puff-eyes-happy',
      sleepEyes: '.puff-eyes-sleep',
      ears: '.puff-ear-l, .puff-ear-r', // each ear pivots at its own data-origin
      flutter: '.puff-tuft', // the idle "breathing" part
      glasses: '.puff-glasses' // hidden until it reads along on a Markdown tab (readAlong below)
    },
    // The opt-in extras (each is off unless listed). Click it once and it hides somewhere behind an edge;
    // `git commit` / `git push` sent in the terminal get a stamp or a paper plane; come back after a long
    // while and you may catch it juggling or nibbling; rest the pointer on it and it nuzzles; a Markdown
    // tab gets the glasses; the lantern comes on in the evening.
    hideAndSeek: true,
    git: true,
    caught: { scenes: ['juggle', 'nibble'] },
    nuzzle: true,
    readAlong: true,
    lantern: true,
    // Typing "唱歌" or "sing" in the terminal makes it sing. Put your own file (one you have the rights
    // to) at ~/.orca/themer/assets/<theme id>/lullaby.ogg (or .mp3/.m4a/.wav) and it plays along;
    // without a file it hums silently with notes. Nothing is bundled here.
    sing: { asset: 'lullaby', start: 0, length: 20, volume: 0.35 },
    colors: { sparkle: '#fff6e8', heart: '#f6b3c8', note: '#e8e4ff', trail: '#fff6e8' },
    // Its own sign over its head: a small gear while an agent works (the `busyToo` act below).
    emotes: { working: ['⚙', '#e8e4ff'] },
    // Its signature move: a squashy double bounce.
    signature: 'boing',
    acts: {
      boing: {
        weight: (c) => 3 + c.mood.happy * 2,
        run: (api) => {
          const { act, t, at, animateParts } = api
          act(at([t(0, 0), t(0, 3, 0, 1.12, 0.86), t(0, -14, 0, 0.92, 1.1), t(0, 2, 0, 1.08, 0.9), t(0, -6, 0, 0.96, 1.04), t(0, 0)], [0, 0.15, 0.4, 0.6, 0.8, 1]), 1100)
          animateParts('flutter', [{ transform: 'translateY(0)' }, { transform: 'translateY(-3px)' }, { transform: 'translateY(0)' }], { duration: 1100, composite: 'add' })
        }
      },
      // Fluffs up its wool, holds it, and lets the air out.
      puffUp: {
        weight: (c) => 2 + c.mood.curious,
        run: ({ act, t, at }) => act(at([t(0, 0), t(0, -2, 0, 1.16, 1.12), t(0, -2, 0, 1.16, 1.12), t(0, 0)], [0, 0.3, 0.7, 1]), 1600)
      },
      // While an agent works, it now and then looks up with a small gear over its head, so "working" is not
      // told by the glow's brightness alone (docs/states.md「不只靠顏色」). Never picked when nothing works.
      busyToo: {
        weight: (c) => (c.working ? 6 : 0),
        run: ({ act, t, at, emote }) => {
          emote('working')
          act(at([t(0, 0), t(0, -4, 0, 1.03, 0.97), t(0, 0)], [0, 0.5, 1]), 700)
        }
      },
      // A worried little rain cloud.
      drizzle: {
        weight: (c) => c.mood.worried * 5,
        run: (api) => {
          api.act([api.t(0, 0), api.t(0, 3, -4), api.t(0, 3, 4), api.t(0, 0)], 1400)
          drizzle(api)
        }
      },
      // A caught-in-the-act scene: nibbling a tuft of grass. A scene's run() returns a cleanup that hides
      // the prop when it jumps; weight 0 keeps it out of the idle picks.
      nibble: {
        weight: 0,
        run: ({ root, act, t, at, animateParts }) => {
          const tuft = document.createElement('div')
          tuft.textContent = '❀'
          tuft.style.cssText = 'position:absolute;left:38px;top:44px;font:600 16px/1 system-ui;color:#9fd79a;text-shadow:0 0 6px #7cc777;pointer-events:none'
          root.appendChild(tuft)
          const chew = act(at([t(0, 0), t(1, 2, 3, 1.02, 0.98), t(-1, 1, -2), t(1, 2, 3, 1.02, 0.98), t(0, 0)], [0, 0.25, 0.5, 0.75, 1]), 1200)
          animateParts('ears', [{ transform: 'rotate(0deg)' }, { transform: 'rotate(-6deg)' }, { transform: 'rotate(0deg)' }], { duration: 600, iterations: 2, composite: 'add' })
          const done = () => (clearTimeout(stopAt), chew.cancel(), tuft.remove())
          const stopAt = setTimeout(done, 6000) // when nothing catches it, the tuft goes on its own
          return done
        }
      },
      // The built-in `chaseStar` fits a sheep less; take it out.
      chaseStar: null
    },
    // Its own rows in the settings panel (right-click it, or Ctrl+Alt+T → 寵物設定). An act with the same
    // name as a row follows that row's switch and frequency when it is picked idle; `preview` is what
    // 「試試看」 plays.
    behaviors: [{ id: 'puffUp', label: '蓬起毛', desc: '閒著的時候，偶爾把毛蓬起來再洩氣。', freq: true, preview: (api) => api.acts.puffUp() }],
    // Replaces the built-in "worried" reaction (a word like "bug" or "error" in what you sent).
    reactions: {
      worried: (api) => {
        api.emote('worried')
        api.feel('worried', 0.2)
        api.acts.drizzle()
      }
    },
    words: [
      // Checked before the built-in ones. `react` is an act or reaction name, or a function(api).
      { re: /草|grass|lunch|午餐|吃飯/i, react: (api) => (api.emote('happy'), api.acts.boing(), api.say('有草嗎？我也要。')) }
    ],
    lines: {
      idle: ['今天的雲，軟軟的。', '我在這裡曬太陽。', '慢慢來，不急。', '你打字好像在下小雨。', '要不要伸個懶腰？'],
      night: ['星星出來了。', '夜裡的風比較涼，記得加件衣服。'],
      done: ['做完了！去看看吧。', '好耶，完成了。'],
      failed: ['沒關係，再試一次。', '我陪你一起看看。'],
      welcome: ['你回來了！', '歡迎回來，我有乖乖等。'],
      name: ['咩？叫我嗎？', '我在！'],
      late: ['這麼晚了，早點休息好不好？', '比平常晚了呢，別太累。'],
      found: ['被你找到了！', '咩，藏得不夠好。'],
      notFound: ['哼哼，沒找到我吧。', '我躲得很好吧？'],
      caught: ['我、我什麼都沒做。', '咦？你這麼快就回來了……', '剛剛那個……是祕密。'],
      lantern: ['天黑了，我點一盞燈陪你。'],
      greeting: {
        morning: ['早安，今天也一起加油。'],
        noon: ['午安，記得吃飯。'],
        afternoon: ['下午好，喝口水吧。'],
        evening: ['晚上好。'],
        night: ['這麼晚還在呀……']
      },
      milestone: ['這是我們一起的第 {n} 天！'],
      // Its feelings (the 心情 tab): low spirits, lonely, the first low of the day, a sulk and being won
      // back, too many failures in a row, and a tier closer ({tier}) or further apart.
      low: ['……今天的毛有點扁扁的。', '咩……沒什麼力氣。', '雲好像變灰了。'],
      lonely: ['好安靜喔……', '你在忙嗎？我在這裡。', '偶爾也摸摸我嘛。', '我數到第兩百朵雲了。'],
      lowFirst: ['……今天有點累。', '咩……我沒事，只是有一點點悶。'],
      sulk: ['……哼。', '……不想說話。', '……讓我自己待一下。'],
      consoled: ['……咩。好多了。', '被你摸摸，毛又蓬起來了。', '……嗯，不氣了。'],
      anxious: ['一直出錯……先喝口水好不好？', '休息五分鐘吧，錯誤不會跑掉的。', '深呼吸，我陪你一起看。'],
      tierUp: ['咩！我們好像變成「{tier}」了。', '跟你在一起，越來越自在了。', '我最喜歡的位置，就是你旁邊。'],
      tierDown: ['……最近，是不是有點遠了？', '你最近都沒什麼理我……']
    },
    // Words the 心情 tab uses for Puff (thresholds stay the engine's; see docs/companion-api.md「心情」).
    emotion: {
      words: {
        tiers: ['怕生', '認得你', '信任你', '黏著你', '最要好'],
        stages: [
          [75, '一整片草原'],
          [50, '一小片草地'],
          [25, '一叢草'],
          [10, '冒芽'],
          [0, '草籽']
        ],
        moodlets: { pet: '被摸毛了', played: '一起玩捉迷藏', sing: '咩了一首歌' },
        calm: 'Puff 很安心，毛蓬蓬的。',
        tired: 'Puff 有點累，但不擔心什麼。',
        missed: '你不在的時候，Puff 有點想你'
      }
    }
  })
})()
