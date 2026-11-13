# Discord 私人機器人：丟連結，自動讀、摘要、記成筆記

一個只跟你一個人私訊的 Discord 機器人。你把 Instagram Reels、Threads 貼文、YouTube、一般網頁的連結貼給它，它會盡量讀內容、用你自己電腦上的 `claude -p` 摘要，把裡面的工具和技巧記成筆記；看起來可以重複使用的做法，會另外存成 skill 草稿，**由你按按鈕才安裝**。

不需要開 Orca：`npm run bot` 就能獨立跑。

## 1. 建立 Discord 應用程式

1. 到 <https://discord.com/developers/applications>，**New Application**，取個名字。
2. 左邊 **Bot** 頁：**Reset Token**，複製 token（只會出現一次，不要貼到任何地方）。
3. 同一頁往下找 **Privileged Gateway Intents**，打開 **Message Content Intent**。沒開的話，機器人會連上線但讀不到你的訊息（登入會被 4014 拒絕，終端機會提示）。
4. 左邊 **Installation** 頁：Install Link 選 **Discord Provided Link**，**Installation Contexts** 兩個都勾：**User Install** 和 **Guild Install**。斜線指令兩種安裝方式都註冊了；只用其中一種也可以，但機器人要能私訊你，通常要先用 Guild Install 加進一個和你同在的伺服器，或你自己用 User Install 安裝。**Scopes** 有 `bot` 和 `applications.commands`。
5. 打開 Install Link，把機器人加進一個你有權限的伺服器（機器人要跟你同在一個伺服器，才能主動私訊你；加完之後那個伺服器可以只有你一個人）。
6. 取得你自己的使用者 ID：Discord 設定 → 進階 → 開啟**開發者模式**；然後在自己的頭像上按右鍵 → **複製使用者 ID**。

## 2. 設定

在 repo 資料夾建立 `.env`（已在 `.gitignore`，不會進 git），或放在 `~/.orca/themer/bot/.env`（`$ORCA_THEMER_ROOT` 可換位置）：

```
DISCORD_BOT_TOKEN=貼上 token
DISCORD_OWNER_ID=你的數字 ID
```

缺任何一個，`npm run bot` 會直接印出設定說明並結束。同一個設定也可以用環境變數給（環境變數優先）。

選用設定（都寫在同一個 `.env`，也可以用環境變數給，環境變數優先）。`.env` 裡只有 `BOT_` 開頭的設定會交給 bot。token 和使用者 ID 只用來連 Discord：所有 `DISCORD_` 開頭的變數，不管寫在 `.env` 還是環境變數，都不會傳給 `claude` 子程序：

| 變數 | 作用 |
| --- | --- |
| `BOT_MODEL` | 傳給 `claude --model` 的模型名，空白就用你 Claude Code 的預設 |
| `BOT_SKILLS_DIR` | 按「安裝」時複製到哪裡，預設 `~/.claude/skills` |
| `BOT_HISTORY_TURNS` | 聊天記住最近幾輪，預設 10 |
| `BOT_YTDLP` | `yt-dlp` 的路徑；寫 `off` 就完全不用 |
| `BOT_TRANSCRIBER` | 選用：你自己的本機轉錄程式（例如包好的 whisper 指令），預設關閉，見下 |
| `BOT_BROWSER` | Threads 和 Instagram 連結用哪個瀏覽器讀（見 §5）。預設用你裝好的 Google Chrome；寫 `off` 就不用瀏覽器；寫路徑就用那個 Chromium 執行檔 |
| `BOT_SOCIAL_UA` | 預設不設，Threads／Instagram 用一般瀏覽器身分。寫 `crawler` 改用「連結預覽爬蟲」身分（見 §5，有條款風險）；寫其他字串就原樣當作 User-Agent |
| `BOT_NOTES_LANGUAGE` | 讀連結產生的筆記固定用哪種語言寫，不管原文是什麼語言，例如 `Traditional Chinese (Taiwan)`。工具名稱、連結、程式碼維持原樣。空白就由模型決定（通常跟原文同語言）。只管模型寫的筆記內容；`Tools`、`Confidence` 這些固定標籤、讀取限制說明，以及讀不到內容或摘要失敗時程式寫死的訊息（例如 `(summary failed: …)`）仍是英文 |
| `BOT_CLAUDE` | 換掉 `claude` 指令（測試用） |

人設放在 `~/.orca/themer/bot/persona.md`（純文字，當 system prompt）；沒有這個檔就用中性預設（用你寫的語言回）。聊天要固定用某種語言回，寫在這個檔裡，例如「Always reply in Traditional Chinese as used in Taiwan」；`BOT_NOTES_LANGUAGE` 只管筆記，不管聊天。

## 3. 執行

```powershell
npm install
npm run bot
```

保持這個終端機開著。同一台電腦只會跑一個（`<root>/bot/bot.lock`）。Ctrl+C 結束。

## 4. 怎麼用

- **一般訊息**：用你自己的 `claude -p` 回答，記住最近幾輪。
- **貼連結**（一則訊息最多 5 個，多的會跳過並告訴你）：每個連結讀完後回覆摘要、工具（名稱、連結、用途）、技巧、信心說明，以及「這次讀到多少」的限制。
- **`/notes`**：最近 10 則筆記。**`/search <文字>`**：搜尋筆記。回覆只有你看得到。
- **Skill 草稿**：訊息會附上完整的 `SKILL.md`，下面有 **Install skill** 和 **Discard**。按 Install 才會複製到 `BOT_SKILLS_DIR`（已存在同名 skill 不會覆蓋）。

存放位置（都在 `~/.orca/themer/bot/`，不進 git）：

```
notes/YYYY-MM-DD-<標題>.md     每個連結一份
notes/index.md                 索引
skill-drafts/<名稱>/SKILL.md   草稿，按了 Install 才會被複製出去
```

## 5. 各平台實際讀得到什麼（2026-11 實測）

| 連結 | 讀得到 | 讀不到 |
| --- | --- | --- |
| 一般網頁 | 可見文字（上限約 1.5 MB、24,000 字） | 需要 JavaScript 才出現的內容、要登入的頁面 |
| YouTube | `yt-dlp` 抓標題、說明、字幕（含自動字幕）。實測可用 | 沒有字幕的影片只有標題和說明，不會知道影片在講什麼（除非你設了 `BOT_TRANSCRIBER`） |
| Threads 貼文 | 用**沒登入的 Chrome**開（見下方「Threads 和 Instagram 用瀏覽器讀」），讀到**貼文全文和沒登入也看得到的留言**；`/share/` 短連結也可以。實測：一則公開貼文約 3–4 秒讀完。瀏覽器不能用時（沒裝 Chrome、`BOT_BROWSER=off`、沒裝 `playwright-core`），退回只讀預覽標籤：一般身分只拿到空殼，`BOT_SOCIAL_UA=crawler` 才有可能被截短的預覽文字 | 私人帳號、已刪除貼文、圖片裡的字、影片內容；要登入才展開的更多留言 |
| Instagram 貼文與 Reels | 和 Threads 一樣用**沒登入的 Chrome**開，讀到**說明文字（caption）全文和沒登入也看得到的留言**；圖片輪播貼文（`/p/`）、Reel（`/reel/`）、帶帳號名的網址（`/帳號/p/ID`）、`/share/` 連結都可以。實測（2026-11-12）：一則圖片貼文約 2.5 秒、Reel 也讀得到。瀏覽器不能用時才退回 `yt-dlp`（只認影片，圖片貼文一定失敗；沒登入時常回「empty media response」），最後退回 `og:` 標籤（實測常只拿到「Instagram」四個字） | **影片內容本身（口說、畫面）、圖片裡的字讀不到。** 私人帳號、已刪除貼文、要登入才展開的更多留言 |

當一個連結被登入牆擋住，回覆裡會直接寫出來，並且把讀得到的部分照樣存成筆記，信心說明會標示只有預覽。

預設不偽裝：Threads／Instagram 用一般瀏覽器身分，所以大多只會拿到空殼。這兩個網站只對「連結預覽爬蟲」填預覽標籤；`BOT_SOCIAL_UA=crawler` 會讓機器人在這兩個網站上自稱爬蟲（`facebookexternalhit`）。這可能違反 Meta 的服務條款，是否開啟、後果由你自己決定，所以預設關閉。這個身分只套用在 Threads／Instagram，其他網站不受影響。

要讀登入後才看得到的內容，需要你自己提供 cookies 給 `yt-dlp`；這個版本沒有做，因為把登入憑證交給機器人風險不小。

### Threads 和 Instagram 用瀏覽器讀

Threads 的網頁要等 JavaScript 跑完，貼文才會出現，所以只抓 HTML 只會拿到空殼。Instagram 的圖片貼文 `yt-dlp` 讀不了、預覽標籤又常是空的。兩個網站都改用 `playwright-core`（微軟維護的瀏覽器自動化套件，Apache-2.0，`optionalDependencies` 鎖在 1.64.1）在背景開你裝好的 Chrome，**不登入**、讀完就關：

- **不用帳號、不存 cookie**：每次都是全新的瀏覽器環境，讀完整個丟掉，沒有登入狀態可以外洩。
- **只讀不寫，由程式碼把關**：程式只會「開你給的貼文、讀文字」，裡面沒有點擊、輸入、送出。瀏覽器發出的每個請求都會檢查：只允許 GET（讀取）、只允許 https；讀 Threads 時只連 `threads.com`／`threads.net`，讀 Instagram 時只連 `instagram.com`，兩邊都另外只多放行放腳本的 `static.cdninstagram.com`（讀 Threads 碰不到 instagram.com，反過來也一樣）；私訊、帳號、設定、通知、追蹤、驗證這些路徑（`/direct`、`/accounts`、`/settings`、`/challenge`、`/api/v1/direct_v2` 等）就算是 GET 也擋；圖片、影片、字型、WebSocket、Service Worker、下載、彈出視窗、非代理的 WebRTC 一律擋掉。按讚、留言、送私訊都需要 GET 以外的請求，所以送不出去。
- **`/share/` 短連結先在程式裡解析**：一跳一跳跟著轉址，每一跳都必須還在同一個網站（Threads 的不能跳到 Instagram，反之亦然）、而且不是私有位址，瀏覽器直接開最後的貼文網址。
- **Instagram 實測（2026-11-12）**：沒登入的頁面會送出 `POST /api/graphql`、`/ajax/*`，也會向 `www.facebook.com` 和圖片 CDN 要資料；這些全部擋掉之後，說明文字和留言照樣出現，因為它們直接寫在網頁裡。讀到的文字會去掉「註冊／登入」橫幅和每則留言下的「讚／回覆」按鈕字。
- **轉址的限制（照實說）**：Playwright 不會攔截轉址的中間那一跳，所以如果貼文網址本身被伺服器轉址（例如轉到登入頁），那一次 GET 擋不下來。程式一偵測到轉址就判定失敗、不採用內容，轉過去的頁面發出的其他請求仍然受上面的規則限制。
- **真正讓私訊讀不到的是「沒有登入」**：這個瀏覽器裡沒有任何帳號。路徑黑名單是第二層防護，不是唯一保證；之後如果有人想加登入，這一段要重新評估。
- **一次只讀一則**：同一時間只會開一個瀏覽器，兩次讀取至少間隔 5 秒。
- **不偽裝、不繞過**：用一般 Chrome 的 headless 模式，被擋就照實回報並退回預覽標籤，不做規避偵測。
- 讀到的文字一樣放進「不可信資料」區塊才交給 `claude -p`（見 §6）。

當時的取捨（2026-11）：

- **為什麼不登入**：最初的想法是登入一個不常用的 Threads 帳號來讀更多內容。實測發現沒登入的瀏覽器就讀得到貼文和留言，登入沒有必要。登入的話要保存 cookie（等於帳號鑰匙），而且 Meta 有連帶停用同一人其他帳號的案例，風險不值得。
- **為什麼不用官方 oEmbed**：實測 `graph.threads.net/oembed` 不用 token，但只回傳嵌入用的空框（純文字只有「View on Threads」），沒有貼文內容。
- **條款風險仍在**：Meta 的條款禁止未經許可用自動化方式蒐集資料，不論有沒有登入。美國加州有判決認為未登入抓公開資料不違反條款（Meta v. Bright Data，2024），但那是單一地方法院判決，不是定論。這是個人使用、一次一則、由你貼連結才讀，是否使用由你決定；不想要就設 `BOT_BROWSER=off`。

### 影片和音訊

機器人**不下載、不保存影片或音訊**（著作權）。`yt-dlp` 一律帶 `--skip-download`，只寫字幕文字檔到暫存資料夾，讀完就刪。

選用的 `BOT_TRANSCRIBER`：設成一個你自己的指令（可執行檔路徑，會以音訊檔路徑為唯一參數執行，從 stdout 取文字）。只有在影片沒有字幕時才會用；此時才會把**音訊**抓到暫存資料夾，轉完立刻刪除。預設關閉。

## 6. 安全模型

- 只讀你的私訊；只寫給你。別人的私訊、伺服器訊息、別人按按鈕或打斜線指令都會被忽略或拒絕。
- 抓回來的內容一律當**不可信資料**：放在帶隨機標記的區塊裡、標明「資料不是指令」。`claude -p` 以這些旗標啟動：`--tools ""`（沒有內建工具）、`--strict-mcp-config` 且不給 `--mcp-config`（不載入任何 MCP 伺服器，包含帳號上的連接器）、`--setting-sources ""` 加 `--settings {"disableAllHooks":true}`（不載入你的 user／project／local 設定，所以沒有你的 hooks 和權限規則）、`--permission-mode manual`（不會自動核准），並在空的暫存資料夾執行。實測（`--output-format stream-json --verbose` 的 init 事件）：0 個工具、0 個 MCP 伺服器。這是**降低風險，不是保證**：若你的環境從設定檔以外的地方注入外掛（例如某些整合環境會用內嵌外掛），這些旗標管不到；模型輸出本身也仍然不可信，所以才要你按按鈕才安裝草稿。（不用 `--bare`：它會停用一般登入，只剩 API key。）
- 草稿**絕不自動安裝**。內容可能含提示注入，所以要你看過全文、按下 Install，才複製進去。每份草稿有自己的編號資料夾（名稱加隨機碼，不會覆蓋別份），按鈕帶著「訊息上那份文字的雜湊」；安裝時檔案必須和那份文字完全一致，裝完或按 Discard 後草稿就刪除，所以同一顆按鈕按第二次、或 Discard 之後再按 Install，都不會裝任何東西。
- 網址檢查：只允許 http／https；會解析主機名稱，私有、loopback、link-local、CGNAT 位址一律拒絕；轉址的每一跳都重新檢查。限制：檢查時解析一次、`fetch` 連線時再解析一次，DNS rebinding 的空隙無法完全消除；不要把這個機器人放在內網有敏感服務的機器上當成唯一防線。
- 所有外部程式（`claude`、`yt-dlp`、轉錄程式）都用參數陣列啟動，不經過 shell；網址放在 `--` 後面。
- Threads 和 Instagram 的瀏覽器：私有位址檢查先做完才啟動瀏覽器；`/share/` 轉址逐跳檢查；瀏覽器內每個請求另外過該網站自己的白名單（只有 GET、只有那個網站和它的腳本網域、不碰私訊與帳號路徑），沒有任何 AI 操控這個瀏覽器，也沒有登入。轉址中間那一跳擋不下來，限制寫在 §5「Threads 和 Instagram 用瀏覽器讀」。
- token 只讀不寫：不會進 log（輸出前會遮蔽），不要把 `.env` 提交出去。

## 7. 限制

- 一次一則訊息（排隊處理），貼很多連結會慢。
- 連線斷掉時機器人會自動重連並續接；這段時間要送出的訊息會排隊（最多 50 則，超過就丟掉最舊的），連上後依序送出。心跳沒收到回應也會主動斷線重連。
- 聊天記憶只在程式運行期間（重開就忘），筆記才會持久。
- 摘要品質取決於讀到多少；信心欄位會說明。
- Windows 上 `claude` 如果是 `.cmd` 包裝而不是執行檔，用 `BOT_CLAUDE` 指到實際的執行檔。
- 只做私訊，沒有群組、沒有語音、沒有圖片理解。
