# Hook 事件怎麼對應到寵物狀態

[states.md](states.md) 寫的是寵物有哪些狀態、誰能打斷誰；這份寫的是「agent 那邊發生了什麼事，寵物該進哪個狀態」。

先說清楚現況：**kit 內建的寵物不用 hook。** 引擎（`src/touches/companion.js`）直接讀 Orca 分頁上的 `data-agent-activity-status`，值只有四種：`working`、`permission`、`done`、`failed`。這份表是給兩種人用的：

- 想知道 Orca 那四個值大概是從哪些 agent 事件來的；
- 想自己接 Claude Code 的 hook（例如做一個不在 Orca 裡的小工具、或想分得比四種更細），又不想讓提示亂成一團。

## 六個行為標籤

hook 事件很多，直接拿來對應動作會太吵。先收斂成六個標籤，再決定每個標籤要演什麼：

| 標籤 | 意思 | 要多顯眼 |
| --- | --- | --- |
| `thinking` | agent 在想、在寫 | 很淡：只是背景 |
| `reading` | 在讀檔、搜尋 | 很淡，和 `thinking` 同一層 |
| `testing` | 在跑測試或建置 | 很淡，和 `thinking` 同一層 |
| `success` | 一輪做完 | 演一次就好 |
| `error` | 失敗 | 演一次，比 `success` 明顯 |
| `waiting` | **在等你批准** | **最顯眼**，而且要一直在，直到你處理 |

`waiting` 和 `success` 一定要分開：「做完了」可以晚點再看，「等你批准」不理它 agent 就一直卡著。兩個長得一樣，你就會開始忽略兩個。

## 對照表

| Claude Code hook 事件 | 條件 | 標籤 | Orca 分頁狀態 | states.md 的狀態 |
| --- | --- | --- | --- | --- |
| `UserPromptSubmit` | 你送出一句話 | `thinking` | `working` | agent 工作中（疊加的呼吸光暈） |
| `PreToolUse` | 工具是 `Read`、`Grep`、`Glob` | `reading` | `working` | agent 工作中 |
| `PreToolUse` | 工具是 `Bash`，指令像 `npm test`、`pytest`、`cargo build` | `testing` | `working` | agent 工作中 |
| `PreToolUse` | 其他工具（`Edit`、`Write`……） | `thinking` | `working` | agent 工作中 |
| `PostToolUse` | 工具結果是失敗（例如測試的結束碼不是 0） | `error` | 不變（仍是 `working`） | 不建議演：agent 多半會自己修，等 `Stop` 再說 |
| `Notification` | `matcher` 是 `permission_prompt` | `waiting` | `permission` | **alert** 層：去敲門 `visiting` |
| `PermissionRequest` | 跳出允許對話框 | `waiting` | `permission` | **alert** 層：去敲門 `visiting` |
| `Notification` | `matcher` 是 `idle_prompt`（做完後閒著等你） | 不用新標籤 | 不變 | 不演；`success` 已經演過了 |
| `Stop` | 一輪正常結束 | `success` | `done` | **alert** 層：做完轉一圈（`twirl`） |
| `Stop` | 這一輪以錯誤收尾（你的版本分得出來時；分不出來就只用上一行） | `error` | `failed` | **alert** 層：失敗垂頭（`droop`） |
| `SubagentStop` | 子 agent 做完 | 不用新標籤 | 不變 | 不演：主 agent 還在做，演了會太吵 |
| `SessionEnd` | 結束這個 session | 清掉標籤 | 無 | 回到 `home` |

幾點說明：

- **`reading`、`testing` 只是 `thinking` 的細分。** 它們都在 states.md 的「agent 工作中」，只是你想讓寵物多一個小差別（例如讀檔時戴眼鏡、跑測試時冒「⚙」）時才分。它們屬於疊加效果，不碰 `busy`、不換 `mode`，不該打斷任何東西。
- **`waiting` 是唯一會換 `mode` 的。** 它走 alert 層去敲門（`visiting`），而且要一直敲到分頁不再等你為止；其他標籤都是演一次或只是背景。
- **`success`、`error` 演一次就收。** 遇到牠正在忙，`success` 跳過就好；`error` 照演。這和 states.md「現況和規則不一樣的地方」寫的行為一致。
- 同時有好幾個 session：任何一個在 `waiting`，就以 `waiting` 為準；否則有任何一個在 `thinking`／`reading`／`testing` 就算工作中。

## 接 hook 時要注意的四件事

### 1. `permission_prompt` 要最顯眼

這是唯一一個「你不動，agent 就不動」的事件。給它的提示要比其他所有的都明顯，而且要一直留著，不要像 `success` 一樣演完就收。其他事件寧可淡一點，免得你看到動靜就麻木。

### 2. hook 要非同步、要快

hook 會擋住 agent：它沒結束，agent 就在等。寵物的提示不需要 agent 等它。

- 支援的版本可以在 hook 設定加 `"async": true`，讓它在背景跑；
- 不管有沒有 `async`，hook 本身只做一件事：把標籤寫到一個檔案（或丟給一個已經開著的程式），立刻結束。不要在 hook 裡播動畫、等網路、開視窗；
- 設一個短的 `timeout`，壞掉時也不會拖住 agent。

### 3. 不要把 stdin 直接塞進指令

hook 從 stdin 拿到一份 JSON，裡面有工具的參數，例如 `Bash` 要跑的整行指令、檔名、你打的字。這些內容不是你寫的，可能含有 `;`、`$(...)`、引號。

- **不要**寫成 `sh -c "echo $(cat) >> log"`、`` `cat` `` 拼進命令列、或把欄位接進另一條 shell 指令；
- **要**用一個小程式把 stdin 當資料解析（`JSON.parse`），只取你要的欄位，只輸出固定的標籤字串；
- 寫進檔案的只有標籤和時間，不要把整份 stdin（可能有密鑰、私人路徑）存下來。

### 4. hook 用你的完整權限跑；擋 `.env` 時 `Read` 和 `Bash` 都要擋

hook 不是在沙盒裡跑的：它拿到的權限就是你這個使用者的權限，能讀你讀得到的每個檔案。原生 Windows 上也沒有沙盒可以替你把關，所以 hook 和 agent 本身的權限規則都要自己收緊。

常見的漏洞是只擋了一邊：在 `permissions.deny` 寫了 `Read(./.env)`，擋住的是 `Read` 這類讀檔工具，agent 還是可能用 `Bash` 跑 `cat .env` 讀到同一個檔案。要擋就兩邊一起寫：

```json
{
  "permissions": {
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)",
      "Bash(cat .env*)",
      "Bash(type .env*)"
    ]
  }
}
```

- `Bash` 的規則是比對指令字串，換個寫法（`less`、`head`、`Get-Content`……）就可能繞過去，所以這只是補一道，不是保證；真正的密鑰最好不要放在 agent 能碰到的資料夾；
- 你自己的 hook 也一樣：不要讀 `.env`，也不要把讀到的內容寫進記錄檔；
- 權限規則和 hook 的行為會隨版本改，接之前先看官方的 [Claude Code changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)。

#### 再補一道：用 `PreToolUse` hook 擋提到 `.env` 的指令

`deny` 規則只認得你列出來的寫法。想多擋一層，可以加一個 `PreToolUse` hook：工具要跑的指令或要讀的路徑裡只要出現 `.env`，就回傳 `deny`。這個 hook 只看 stdin 給它的工具參數，**自己不讀任何檔案、也不寫任何記錄**。

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|PowerShell|Read|Grep|Glob", "hooks": [{ "type": "command", "command": "node env-guard.mjs", "timeout": 5 }] }
    ]
  }
}
```

這個 hook **不能**加 `"async": true`：背景跑的 hook 來不及擋，工具早就執行了。它只比對字串、立刻結束，同步跑也不會拖慢 agent。

`env-guard.mjs`：

```js
import { readFileSync } from 'node:fs'

let event = {}
try { event = JSON.parse(readFileSync(0, 'utf8')) } catch {}

// Look only at the tool's arguments (command, path, pattern). Never open .env, never log anything.
const input = event.tool_input ?? {}
const text = [input.command, input.file_path, input.path, input.pattern, input.glob].filter(Boolean).join('\n')
const MENTIONS_ENV = /(^|[\s"'`\/\\=:(*])\.env\b/

if (MENTIONS_ENV.test(text)) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'This project does not let agents read .env files.',
    },
  }))
}
```

- 它擋的是「指令裡寫了 `.env`」，所以 `less .env`、`Get-Content .env`、`Read(./.env.local)` 都會被擋；但把檔名拆開拼（例如用變數組出來）還是可能繞過。它和 `deny` 一樣只是多一道，不是保證；
- 誤擋也有可能（例如指令裡剛好有 `.env` 這幾個字）。被擋時 agent 會看到上面那句原因，你可以自己決定要不要放行；
- hook 壞掉（讀不到 JSON）時什麼都不輸出，等於不表態，交回一般的權限規則處理。

## 通用範例

設定（放在專案或使用者的 Claude Code 設定裡）。這裡只示範三個事件，其他照對照表加：

```json
{
  "hooks": {
    "Notification": [
      { "matcher": "permission_prompt", "hooks": [{ "type": "command", "command": "node pet-hook.mjs", "async": true, "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "node pet-hook.mjs", "async": true, "timeout": 5 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node pet-hook.mjs", "async": true, "timeout": 5 }] }
    ]
  }
}
```

`pet-hook.mjs`：只讀 stdin、只寫一個標籤。指令本身固定，stdin 的內容從頭到尾只被當成資料。

```js
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let event = {}
try { event = JSON.parse(readFileSync(0, 'utf8')) } catch {}

const TESTS = /\b(npm (run )?test|pytest|cargo (test|build)|go test)\b/
const label = (() => {
  const name = event.hook_event_name
  const tool = event.tool_name
  if (name === 'Notification') return event.notification_type === 'permission_prompt' ? 'waiting' : null
  if (name === 'PermissionRequest') return 'waiting'
  if (name === 'Stop') return 'success'
  if (name === 'UserPromptSubmit') return 'thinking'
  if (name === 'PreToolUse') {
    if (['Read', 'Grep', 'Glob'].includes(tool)) return 'reading'
    if (tool === 'Bash' && TESTS.test(String(event.tool_input?.command ?? ''))) return 'testing'
    return 'thinking'
  }
  return null
})()

// Only a fixed label and a time leave this script; nothing from stdin is written or run.
if (label) writeFileSync(join(homedir(), '.pet-status.json'), JSON.stringify({ label, at: Date.now() }))
```

讀這個檔案的那一邊（你的寵物或小工具）照上面的對照表決定演什麼；`waiting` 要一直留著，直到下一個不是 `waiting` 的標籤進來。
