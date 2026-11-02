# Orca Companion Kit

讓 AI agent（Claude Code、Codex……）幫你做一套自己的 [Orca](https://github.com/stablyai/orca) 外觀：主題配色、會陪你寫程式的桌面小寵物、自訂游標，必要時再加終端機配色和通知音效。做好的東西只會放在你的電腦裡（`~/.orca/themer/`），Orca 更新後照樣能用。

![Orca 套上範例主題「棉花夜空」：終端機打字時迸出火花、右上角是連擊數，左下角是範例寵物 Puff](docs/images/hero.png)

<sub>Orca 實際畫面：範例主題「棉花夜空 Cotton Sky」加上範例寵物 Puff。專案是另外建的示範資料夾。</sub>

**展示影片（2 分 23 秒）**：[showcase-public.mp4](https://github.com/OG-Matcha/orca-companion-kit/releases/download/showcase-2026-10/showcase-public.mp4)，Puff 和工具包的功能一段一段演一遍（跟著游標、摸頭、捉迷藏、甩出去、打字星火、聽得懂的話、唱歌、agent 反應、git 印章與紙飛機、蹭蹭、讀文件、提燈、抓包、換主題）。隔離的 Orca 實錄，無背景音樂。

## 實際畫面

以下都是照「快速開始」裝好之後，在 Windows 版 Orca 裡錄的。

| | |
| --- | --- |
| ![摸 Puff 會冒愛心；抓起來甩出去，它會飛一段再自己走回原位](docs/images/puff-pet-throw.gif) | ![終端機送出一行字，Puff 會回話；雙擊它就一路跟著游標走](docs/images/puff-follow-react.gif) |
| **摸摸、甩出去。** 游標在 Puff 身上來回摸會冒愛心；用力甩出去，它飛一段再自己走回家。 | **會回話、會跟著走。** 終端機送出的字裡有它認得的詞（這裡是 lunch），它會回一句。雙擊它就跟著游標走，按右鍵讓它停下。 |
| ![終端機打字時從游標迸出小火花，右上角累計連擊數](docs/images/typing-sparks.gif) | ![按 Ctrl+Alt+T 開選單，在 Rosé Pine、Tokyo Night、棉花夜空之間切換](docs/images/theme-picker.gif) |
| **打字特效。** 終端機打字時從游標迸出小火花，右上角算連擊數，停手一陣子就淡掉。 | **Ctrl+Alt+T 換主題。** 點一下就換，不用重開 Orca，終端機配色也當場跟著換。 |

**位置和大小都能換。** 把寵物拖到任何地方、慢慢放下，那裡就是它的新家；滾輪可以縮放（0.5–2.5 倍）。兩者都會記住，下次開 Orca 還在原位。想換預設位置，在寵物設定寫 `home`（見 [companion-api.md](docs/companion-api.md)）。

**每個小動作都能自己調。** 在寵物身上按右鍵（或 Ctrl+Alt+T →「寵物設定」）打開設定面板：每個行為一個開關，會隨機發生的另有「很少／少／平常／常常」，按「試試看」馬上演一次；還有安靜時段、鈴聲和唱歌音量、牠怎麼叫你、大小、送牠回家、忘掉回憶。自己做的寵物也會有這個面板，牠自己的行為用 `behaviors` 加進去（[companion-api.md](docs/companion-api.md#設定面板)）。

<img src="docs/images/settings-panel.png" width="420" alt="Puff 的設定面板：左邊分頁，右邊每個行為都有說明、試試看按鈕、開關和頻率">

**牠有心情，也會記得你對牠好不好。** 設定面板第一個分頁「心情」：牠現在的心情（一個詞，按住 Alt 才看得到數字）、對你的好感（愛心和階段，每 20 一階，到過的階段不會再掉）、你們有多親近（只會往上），還有牠正在想的事。agent 出錯會讓牠難過、不安，但不會少喜歡你，隔天就好；離開幾天也不太扣，最多扣 4。真正會讓好感往下掉的，只有 Orca 開著卻一整天都不理牠。心情跌到谷底時牠會躲到角落鬧彆扭（一天最多一次，可以關掉），來回摸三下就和好。每隻寵物都有，用的字和台詞可以換成牠自己的（[companion-api.md](docs/companion-api.md#心情)）。想讓牠像人一樣，不開心的事忘得快、開心的事記得久，在寵物設定寫 `emotion: { fadeBias: true }`；想讓牠開心來得快、難過慢慢沉下去，寫 `emotion: { transitionSpeed: true }`（往上 2 倍、煩躁 1 倍、難過 0.5 倍，每檔都能自己調，見 [companion-api.md](docs/companion-api.md#心情)）。兩個都沒寫就和原本一樣。

<img src="docs/images/emotion-tab.png" width="420" alt="Puff 的「心情」分頁：現在的心情、好感的愛心與階段、親密的進度條、不安和寂寞的標籤、牠在想的事和各自還剩多久">

另外附了三套經典主題，可以直接用，也可以拿來當範本改：

| Catppuccin Mocha | Rosé Pine | Tokyo Night |
| --- | --- | --- |
| ![Catppuccin Mocha 主題](docs/images/theme-catppuccin-mocha.png) | ![Rosé Pine 主題](docs/images/theme-rose-pine.png) | ![Tokyo Night 主題](docs/images/theme-tokyo-night.png) |

<sub>錄影抓不到系統游標，動圖裡的游標是事後依實際指標位置疊上去的，用的就是棉花夜空的自訂游標圖（`examples/cursors/cotton-pointer.svg`）。動作是用腳本送進 Orca 的指標和按鍵事件，Puff 的反應都是它自己的程式跑出來的。</sub>

## 它做了什麼

- **不動 Orca 的安裝檔。** 啟動器用 `--remote-debugging-pipe` 開 Orca。這條私有管線只有啟動器拿得到，不開任何網路埠。主題 CSS 和小巧思（touches）都經由它，在每個 Orca 視窗載入前注入。
- **存檔就生效。** 改了 `~/.orca/themer/` 裡的主題或 touch，視窗會立刻重新套用。
- **Orca 更新後照常運作。** 安裝程式只會把捷徑改回 Orca.exe，啟動器每次啟動、Orca 關閉後都會再把它們指回來。
- **你的東西不放在這個 repo 裡。** 主題、寵物、游標都在 `~/.orca/themer/`，`git pull` 不會蓋掉。

## 快速開始（Windows）

需要 Node.js 20 以上，以及裝在預設位置（`%LOCALAPPDATA%\Programs\orca`）的 Orca。

```powershell
git clone <this repo> orca-companion-kit
cd orca-companion-kit
npm install
.\install.ps1          # 桌面、開始選單、工作列的 Orca 捷徑改成經由啟動器開
npm run example        # 範例主題「棉花夜空」和範例寵物 Puff 放進 ~/.orca/themer
```

接著從捷徑開 Orca，按 **Ctrl+Alt+T**，選「棉花夜空 Cotton Sky」。

> 啟動器會先關掉正在跑、但沒經過啟動器的 Orca（Orca 同一時間只能開一個），再重新開。想先試試、不動到現在的 Orca，可以用獨立的設定資料夾跑：
> `node src/themer.mjs --user-data-dir=%TEMP%\orca-trial`（這種試跑不會關掉原本的 Orca，也不會改捷徑）。

還原：`.\uninstall.ps1` 會把捷徑換回原本的樣子；`~/.orca/themer` 裡的東西會留著。

## 快速開始（macOS）

需要 Node.js 20 以上，以及裝在 `/Applications` 或 `~/Applications` 的 Orca（其他位置：設定環境變數 `ORCA_APP`）。

```sh
git clone <this repo> orca-companion-kit
cd orca-companion-kit
npm install
./install.sh           # 建立 ~/Applications/Orca Companion.app，點它就經由啟動器開 Orca
npm run example        # 範例主題「棉花夜空」和範例寵物 Puff 放進 ~/.orca/themer
```

把 `Orca Companion.app` 拖到 Dock 取代原本的 Orca，之後都從它開。按 **⌃⌥T**（Control+Option+T），選「棉花夜空 Cotton Sky」。

> 跟 Windows 一樣，啟動器會先關掉沒經過它開的 Orca 再重開（像按 ⌘Q 那樣結束，終端機的背景服務不受影響）。Orca 已經由啟動器開著時，再點一次只會把 Orca 叫到前面，不會重開。想先試試：
> `node src/themer.mjs --user-data-dir=$TMPDIR/orca-trial`（不會關掉原本的 Orca）。

還原：`./uninstall.sh` 刪掉 `Orca Companion.app`；`~/.orca/themer` 裡的東西會留著。

## 讓 AI 幫你做

在這個資料夾開 Claude Code（或任何會讀 `AGENTS.md` 的 agent），說一聲：

> 幫我做一套 Orca 主題和一隻桌面寵物。

agent 會先問你幾件事：參考圖、配色、角色個性、招牌動作。接著產生主題 CSS、終端機配色、游標、寵物的 SVG 和設定，全部寫進 `~/.orca/themer/`，最後跑 `npm run check` 確認沒有踩到效能陷阱。整個流程寫在 [`docs/ai-guide.md`](docs/ai-guide.md)。

## 還能自己加什麼

範例只是起點。以下都能自己寫，或直接請 agent 幫你做：

- **寵物的個性。** 台詞（包括心情低落、寂寞、鬧彆扭、和好時說的話）、心情分頁用的字（`emotion.words`）、它認得的關鍵字（`words`）、聽到名字時的反應（`names`）、招牌動作和新的動作（`acts`）、要慶祝的紀念日（`milestones`）。內建的反應也能整個換掉。見 [companion-api.md](docs/companion-api.md)。
- **自己打開的小遊戲和反應。** 設定裡寫一個 `true` 就有：點一下玩捉迷藏（躲到分頁列、側欄、狀態列後面探頭）、`git commit` 蓋章、`git push` 扔紙飛機、離開太久回來撞見它在偷玩、游標停著不動就蹭蹭、開著 Markdown 就戴眼鏡一起讀、傍晚點一盞燈。見 companion-api.md 的「要自己打開的行為」。
- **哪個動作能蓋過哪個。** 寵物的動作分成 idle、walk、reaction、alert 四層，每層的優先順序、能不能被打斷、能不能打斷自己，寫在 [states.md](docs/states.md)；要加新動作前先看一眼。
- **聽到某個字就做某件事。** `words` 的 `react` 可以指到任何動作，包括放你自己的音檔：把音檔放進 `~/.orca/themer/assets/`，打「唱歌」它就唱。kit 不附任何音檔。
- **全新的小功能。** 寵物之外，任何在 Orca 視窗裡跑的效果都可以寫成一個 touch：聚焦光暈、閒置畫面、狀態列裝飾、通知音效……放進 `~/.orca/themer/touches/`，主題列上它的 id 就會啟動，也能在 Ctrl+Alt+T 選單裡單獨開關。見 [touches.md](docs/touches.md)。
- **可以疊加的樣式片段。** 小段 CSS（例如更圓的邊角）放進 `snippets/`，跟任何主題一起用。見 [themes.md](docs/themes.md#片段snippets)。
- **修 Orca 的小毛病。** 不改安裝檔，在執行期替換 Orca 的程式片段。見 [fixes.md](docs/fixes.md#寫新的修正)。

寫完跑 `npm run check`，它會抓出已知會讓 Orca 變慢的寫法（[performance.md](docs/performance.md)）。

系統開了「減少動態效果」時，寵物和所有 touch 都不會啟動；在 Orca 開著的時候切換這個設定，牠會當場收起來，關掉後再回來。

## 文件

| 文件 | 內容 |
| --- | --- |
| [docs/ai-guide.md](docs/ai-guide.md) | 給 agent 的工作流程：訪談、產出清單、提示詞範本、驗收 |
| [docs/themes.md](docs/themes.md) | 主題檔格式、Orca 的 CSS 變數、DOM 掛點、終端機配色、游標、音效 |
| [docs/theme-checklist.md](docs/theme-checklist.md) | 主題作者檢查清單：選擇器怎麼挑、樣式節點固定 id、換頁後再套、失敗時安靜退回 |
| [docs/companion-api.md](docs/companion-api.md) | `registerCompanion` 完整參考 |
| [docs/states.md](docs/states.md) | 寵物動作的四層狀態、優先順序與打斷規則 |
| [docs/hooks-to-states.md](docs/hooks-to-states.md) | Claude Code hook 事件 → 行為標籤 → 寵物狀態的對照，與接 hook 的安全注意事項 |
| [docs/touches.md](docs/touches.md) | `registerTouch` 與執行環境 API |
| [docs/performance.md](docs/performance.md) | **效能守則**，每一條都是實際量到的延遲 |
| [docs/install.md](docs/install.md) | 安裝、開機啟動、撐過 Orca 更新的原理、疑難排解 |
| [docs/injection-approaches.md](docs/injection-approaches.md) | 為什麼用 CDP 注入、不用 preload：改不改檔案、重新整理、Orca 更新、除錯埠的比較 |
| [docs/fixes.md](docs/fixes.md) | 選用的執行期修正（預設關閉） |
| [docs/debug-theme-overwritten.md](docs/debug-theme-overwritten.md) | 主題被蓋掉或消失時，用 DevTools 中斷點、`$0` 和 `getComputedStyle` 找原因 |
| [docs/worktree-cleanup.md](docs/worktree-cleanup.md) | 分支合併後的 worktree 收尾清單：確認合併、關分頁、移除 worktree、prune、刪本機分支 |

## 指令

```powershell
npm test               # 單元測試
npm run check          # 檢查 ~/.orca/themer 裡的主題和 touch（效能陷阱、語法）
npm run check -- --repo
npm run perf           # 開兩個隔離的 Orca 量 Puff 的效能預算（約 3 分鐘，見 docs/performance.md）
npm run example        # 複製範例到 ~/.orca/themer
npm run cursor -- my-cursor.svg 2 2   # SVG 轉成游標 CSS（1x/2x、熱點）
npm run chime -- ~/.orca/themer/sounds/my-theme.wav 1046.5 1318.5
```

## 版權與素材

程式碼採 MIT 授權。範例角色 Puff、範例主題和游標都是為這個專案原創的，可以自由改作。替自己做寵物時，請用你有權使用的素材：自己畫的、AI 依你的描述生成的，或授權允許的。

---

## English

**Orca Companion Kit** lets an AI agent build your own theme, desktop companion pet and custom cursor for the Orca IDE. Everything is injected over a private CDP pipe (`--remote-debugging-pipe`, no network port) and Orca's install is never modified, so your setup survives Orca updates. Your creations live in `~/.orca/themer/`, outside this repo.

```powershell
npm install; .\install.ps1; npm run example   # then open Orca from its shortcut, Ctrl+Alt+T
```

Open an agent in this folder and ask it to "make me an Orca theme and a desktop pet": `AGENTS.md` tells it how to interview you and what to generate. Drag the pet anywhere and drop it gently to give it a new home; the mouse wheel resizes it, and both are remembered. It has feelings that last: a mood (shown as a word; hold Alt for the number), affection in tiers of 20 that never drop below a tier once reached, closeness that only grows, plus anxiety and loneliness. Failures make it sad and anxious for the day, never less fond of you; days away cost at most 4; what really costs affection is Orca open all day with no attention. At rock bottom it sulks in a corner (once a day, can be switched off) until you pet it three times. The words and lines are per pet (`emotion.words`, `lines.low`, `lines.sulk`...). Right-click it (or Ctrl+Alt+T → 寵物設定) for its settings panel, whose first tab 心情 shows all this: every behaviour can be switched off or made rarer or more frequent, with a "try it" button, quiet hours, volume, your name and a reset; your own pet's behaviours join the panel through `behaviors` (row labels can be overridden, e.g. in English). Opt-in behaviours take one `true` each in the pet's config: hide-and-seek behind the window's edges (click it, then find it), a stamp on `git commit` and a paper plane on `git push`, being caught in the act when you come back after a while, a nuzzle when the pointer rests on it, reading along on Markdown tabs, an evening lantern, and singing your own audio file (dropped into `~/.orca/themer/assets/`, never bundled) on a word. Beyond the pet, you can write your own touches (any effect that runs in an Orca window), stackable CSS snippets and runtime fixes. API reference: `docs/companion-api.md`, `docs/touches.md`. Read `docs/performance.md` before writing any CSS or touch: each rule there comes from a measured slowdown in Orca. Runs on Windows (`install.ps1`, Ctrl+Alt+T) and macOS (`./install.sh` makes `~/Applications/Orca Companion.app`; ⌃⌥T). The perf and live-check tools are still Windows only.
