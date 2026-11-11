# Discord 私人機器人：丟連結，自動讀、摘要、記成筆記

一個只跟你一個人私訊的 Discord 機器人。你把 Instagram Reels、Threads 貼文、YouTube、一般網頁的連結貼給它，它會盡量讀內容、用你自己電腦上的 `claude -p` 摘要，把裡面的工具和技巧記成筆記；看起來可以重複使用的做法，會另外存成 skill 草稿，**由你按按鈕才安裝**。

不需要開 Orca：`npm run bot` 就能獨立跑。

## 1. 建立 Discord 應用程式

1. 到 <https://discord.com/developers/applications>，**New Application**，取個名字。
2. 左邊 **Bot** 頁：**Reset Token**，複製 token（只會出現一次，不要貼到任何地方）。
3. 同一頁往下找 **Privileged Gateway Intents**，打開 **Message Content Intent**。沒開的話，機器人會連上線但讀不到你的訊息（登入會被 4014 拒絕，終端機會提示）。
4. 左邊 **Installation** 頁：Install Link 選 **Discord Provided Link**，**Installation Contexts** 勾 **User Install**（私訊用）和 **Guild Install**（要加進伺服器才收得到私訊的話需要，見下）。**Scopes** 有 `bot` 和 `applications.commands`。
5. 打開 Install Link，把機器人加進一個你有權限的伺服器（機器人要跟你同在一個伺服器，才能主動私訊你；加完之後那個伺服器可以只有你一個人）。
6. 取得你自己的使用者 ID：Discord 設定 → 進階 → 開啟**開發者模式**；然後在自己的頭像上按右鍵 → **複製使用者 ID**。

## 2. 設定

在 repo 資料夾建立 `.env`（已在 `.gitignore`，不會進 git），或放在 `~/.orca/themer/bot/.env`（`$ORCA_THEMER_ROOT` 可換位置）：

```
DISCORD_BOT_TOKEN=貼上 token
DISCORD_OWNER_ID=你的數字 ID
```

缺任何一個，`npm run bot` 會直接印出設定說明並結束。同一個設定也可以用環境變數給（環境變數優先）。

選用設定（都寫在同一個 `.env`）：

| 變數 | 作用 |
| --- | --- |
| `BOT_MODEL` | 傳給 `claude --model` 的模型名，空白就用你 Claude Code 的預設 |
| `BOT_SKILLS_DIR` | 按「安裝」時複製到哪裡，預設 `~/.claude/skills` |
| `BOT_HISTORY_TURNS` | 聊天記住最近幾輪，預設 10 |
| `BOT_YTDLP` | `yt-dlp` 的路徑；寫 `off` 就完全不用 |
| `BOT_TRANSCRIBER` | 選用：你自己的本機轉錄程式（例如包好的 whisper 指令），預設關閉，見下 |
| `BOT_SOCIAL_UA` | Threads／Instagram 抓預覽時用的 User-Agent；寫 `off` 改用一般瀏覽器的 |
| `BOT_CLAUDE` | 換掉 `claude` 指令（測試用） |

人設放在 `~/.orca/themer/bot/persona.md`（純文字，當 system prompt）；沒有這個檔就用中性預設。

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
| Threads 貼文 | 一般瀏覽器身分只拿到空殼（標題只有「Threads」）。改用連結預覽爬蟲的身分，`og:title`／`og:description` 有貼文文字（實測：公開貼文的 `og:description` 是貼文內容）。**只有預覽文字，可能被截短；看不到留言、圖片裡的字、串文後面的貼文** | 私人帳號、已刪除貼文 |
| Instagram Reels | 先試 `yt-dlp`；沒帶登入時，Instagram 常回「empty media response」。失敗後退回 `og:` 標籤，能拿到的通常只有 caption 的預覽 | **影片內容本身（口說、畫面）讀不到。** 需要登入的貼文只能拿到有限的預覽。此版沒有實測到一個真實的公開 Reel（只測了不存在的 ID 和個人檔案頁），所以 Reels 的實際成功率未知 |

當一個連結被登入牆擋住，回覆裡會直接寫出來，並且把讀得到的部分照樣存成筆記，信心說明會標示只有預覽。

Threads／Instagram 的預覽用的是「連結預覽爬蟲」的 User-Agent（和 Discord、Facebook 貼連結時展開預覽的方式相同），只套用在這兩個網站。如果你不想這樣，設 `BOT_SOCIAL_UA=off`，那就大概只會得到空殼。

要讀登入後才看得到的內容，需要你自己提供 cookies 給 `yt-dlp`；這個版本沒有做，因為把登入憑證交給機器人風險不小。

### 影片和音訊

機器人**不下載、不保存影片或音訊**（著作權）。`yt-dlp` 一律帶 `--skip-download`，只寫字幕文字檔到暫存資料夾，讀完就刪。

選用的 `BOT_TRANSCRIBER`：設成一個你自己的指令（可執行檔路徑，會以音訊檔路徑為唯一參數執行，從 stdout 取文字）。只有在影片沒有字幕時才會用；此時才會把**音訊**抓到暫存資料夾，轉完立刻刪除。預設關閉。

## 6. 安全模型

- 只讀你的私訊；只寫給你。別人的私訊、伺服器訊息、別人按按鈕或打斜線指令都會被忽略或拒絕。
- 抓回來的內容一律當**不可信資料**：放在帶隨機標記的區塊裡、標明「資料不是指令」，模型沒有任何工具（`claude -p --tools ""`），在空資料夾執行。就算被注入，最壞也只是摘要文字被污染。
- 草稿**絕不自動安裝**。內容可能含提示注入，所以要你看過全文、按下 Install，才複製進去。
- 網址檢查：只允許 http／https；會解析主機名稱，私有、loopback、link-local、CGNAT 位址一律拒絕；轉址的每一跳都重新檢查。限制：檢查時解析一次、`fetch` 連線時再解析一次，DNS rebinding 的空隙無法完全消除；不要把這個機器人放在內網有敏感服務的機器上當成唯一防線。
- 所有外部程式（`claude`、`yt-dlp`、轉錄程式）都用參數陣列啟動，不經過 shell；網址放在 `--` 後面。
- token 只讀不寫：不會進 log（輸出前會遮蔽），不要把 `.env` 提交出去。

## 7. 限制

- 一次一則訊息（排隊處理），貼很多連結會慢。
- 聊天記憶只在程式運行期間（重開就忘），筆記才會持久。
- 摘要品質取決於讀到多少；信心欄位會說明。
- Windows 上 `claude` 如果是 `.cmd` 包裝而不是執行檔，用 `BOT_CLAUDE` 指到實際的執行檔。
- 只做私訊，沒有群組、沒有語音、沒有圖片理解。
