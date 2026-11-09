# Windows 通知 hook 範例

Claude Code 在等你時，用 Windows 系統通知（右下角跳出來的那種）提醒你。分成兩種：

- **`permission_prompt`：在等你批准。** 你不動，agent 就不動，所以這個通知要明顯、要留在通知中心；
- **`idle_prompt`：做完了、閒著等你下一句。** 晚點看也沒關係，通知可以安靜一點。

最後附一個 `Stop` hook 的寫法：想在 agent 收尾前叫它多做一件事時，一定要先看 `stop_hook_active`，不然會停不下來。

這份是 [hooks-to-states.md](hooks-to-states.md) 的 Windows 補充；那份的「接 hook 時要注意的四件事」在這裡一樣適用。kit 本身不會幫你裝這些 hook，要用就照下面自己放進 Claude Code 的設定。

## 設定

放在專案的 `.claude/settings.json`（或使用者的 `~/.claude/settings.json`）。兩個 `matcher` 各自對一種通知，呼叫同一支腳本，只差 `-Kind`：

```json
{
  "hooks": {
    "Notification": [
      {
        "matcher": "permission_prompt",
        "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"$CLAUDE_PROJECT_DIR/.claude/hooks/notify.ps1\" -Kind permission", "async": true, "timeout": 10 }]
      },
      {
        "matcher": "idle_prompt",
        "hooks": [{ "type": "command", "command": "powershell -NoProfile -ExecutionPolicy Bypass -File \"$CLAUDE_PROJECT_DIR/.claude/hooks/notify.ps1\" -Kind idle", "async": true, "timeout": 10 }]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/hooks/stop-check.mjs\"", "timeout": 10 }] }
    ]
  }
}
```

- 兩個通知 hook 都加 `"async": true`：跳通知不需要 agent 等它；
- `Stop` 那個**不能**加 `async`：它要回答「讓不讓 agent 停」，背景跑就來不及回答了；
- 用 `powershell`（Windows 內建的 Windows PowerShell 5.1），不要用 `pwsh`：下面用到的 WinRT 通知類別在 PowerShell 7 裡載不進來；
- 腳本路徑一律用 `$CLAUDE_PROJECT_DIR` 開頭：hook 是在 Claude Code 當下所在的資料夾執行，agent `cd` 到別處之後，相對路徑就找不到腳本。外面那層雙引號是為了路徑裡有空格的情況。放在使用者設定時，`$CLAUDE_PROJECT_DIR` 會跟著每個專案變，所以改成腳本實際放的完整路徑。

## `notify.ps1`：跳 Windows 通知

```powershell
param([ValidateSet('permission', 'idle')][string]$Kind = 'idle')

# The text is fixed per kind. Nothing from stdin is read, so nothing the agent wrote ends up in a command.
$text = @{
  permission = @('Claude Code needs your approval', 'It will not continue until you answer.')
  idle       = @('Claude Code is done', 'Come back when you have a moment.')
}[$Kind]

[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]

$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent(
  [Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$lines = $xml.GetElementsByTagName('text')
[void]$lines.Item(0).AppendChild($xml.CreateTextNode($text[0]))
[void]$lines.Item(1).AppendChild($xml.CreateTextNode($text[1]))

$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
if ($Kind -eq 'idle') { $toast.ExpirationTime = [DateTimeOffset]::Now.AddMinutes(10) }

# Windows needs an app id to show a toast; borrow Windows PowerShell's own.
$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
```

- **腳本裡只用 ASCII 字元。** Windows PowerShell 5.1 讀沒有 BOM 的 `.ps1` 時用的是系統的 ANSI 編碼，而 VS Code 等編輯器預設存成無 BOM 的 UTF-8，裡面寫中文，通知就會變亂碼。想把通知文字改成中文，存檔時要選「UTF-8 with BOM」；
- **通知文字是固定的，不從 stdin 拿。** `Notification` 的 stdin 裡有一個 `message` 欄位，看起來很適合直接顯示，但它的內容不是你寫的；這支腳本完全不讀 stdin，就不會有東西被拼進指令；
- `permission` 的通知會一直留在通知中心，直到你清掉；`idle` 的十分鐘後自己消失，不會越積越多；
- 想要聲音或不同圖示，改 toast 的 XML 範本就好；想更安靜，把 `idle` 那個 hook 整段拿掉。

## `stop-check.mjs`：先看 `stop_hook_active`

`Stop` hook 可以回傳 `{"decision": "block", "reason": "…"}` 叫 agent 先別停、照 `reason` 再做一件事。agent 做完又會再觸發 `Stop`。這時 stdin 裡的 `stop_hook_active` 會是 `true`，意思是「這一輪已經被 Stop hook 擋過了」。**不看它，hook 每次都擋，agent 就永遠停不下來。**

```js
import { readFileSync } from 'node:fs'

let event
try { event = JSON.parse(readFileSync(0, 'utf8')) } catch { process.exit(0) }

// Already sent back once by this hook: let it stop, or it loops forever.
if (event?.stop_hook_active !== false) process.exit(0)

// First stop of this turn: ask for one last check, then let the next stop through.
process.stdout.write(JSON.stringify({
  decision: 'block',
  reason: '收尾前跑一次測試，把結果用一句話告訴我。',
}))
```

- 第一次停：擋下來，請 agent 跑測試；第二次停：`stop_hook_active` 是 `true`，直接放行；
- 只有 `stop_hook_active` 明確是 `false` 才擋。讀不到 JSON、或欄位不見了，一律放行：hook 壞掉時寧可少做一次檢查，也不要讓 agent 停不下來；
- 這只是示範寫法。不需要叫 agent 多做事的話，就不要加 `Stop` hook；只想在做完時跳通知，`idle_prompt` 已經夠了。
