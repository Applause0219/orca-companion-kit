# 注入突然失效：查一下 Electron fuse

這份是小抄。Orca 更新之後，如果主題、寵物、Ctrl+Alt+T 選單一起消失，`themer.log` 裡也看不到注入成功的紀錄，先別急著認定是選擇器壞了。也有可能是新版 Orca 打包時改了 Electron 的 **fuse**，而 fuse 會決定 app 接受哪些除錯和啟動方式。查一次不用一分鐘，可以先排除這個可能。

只有某個地方沒變色、其他都正常的話，問題是在頁面裡，請看 [debug-theme-overwritten.md](debug-theme-overwritten.md)。

## fuse 是什麼

fuse 是寫死在 Electron 執行檔裡的開關，打包時就決定好，執行時改不了，也不能用命令列參數蓋過去。它和這個 kit 有關的有幾個：

| fuse | 開著（Enabled） | 關掉（Disabled） | 跟 kit 的關係 |
| --- | --- | --- | --- |
| `EnableNodeCliInspectArguments` | 接受 `--inspect`、`--inspect-brk` 這類 Node 除錯參數 | 忽略這些參數 | kit **沒有**用這些參數，它關掉不會讓注入失效；但它被關掉，代表這版 Orca 開始收緊除錯介面，值得記一筆 |
| `EnableNodeOptionsEnvironmentVariable` | 讀 `NODE_OPTIONS` 環境變數 | 忽略 | kit 沒用 |
| `RunAsNode` | 接受 `ELECTRON_RUN_AS_NODE` | 忽略 | kit 沒用 |
| `OnlyLoadAppFromAsar`、`EnableEmbeddedAsarIntegrityValidation` | 只載入（且驗證）`app.asar` | 不限制 | kit 不改 `app.asar`，所以不受影響；改 asar 的做法（例如 preload）才會被它擋下來，見 [injection-approaches.md](injection-approaches.md) |

kit 是用 `--remote-debugging-pipe` 開 Orca 的。這是 Chromium 的參數，目前沒有 fuse 管它，所以「fuse 全部正常」或「只有上面幾個被關掉」都不是注入失效的原因，要回頭查別的地方。

## 怎麼查

需要 Node.js。`npx` 會向 npm 下載 `@electron/fuses` 執行，只會讀檔，不會改 Orca。

Windows（預設安裝位置，`%LOCALAPPDATA%` 會自己換成你的使用者資料夾）：

```sh
npx @electron/fuses read --app "%LOCALAPPDATA%\Programs\orca\Orca.exe"
```

PowerShell 要寫成 `"$env:LOCALAPPDATA\Programs\orca\Orca.exe"`。裝在別的地方，就換成你的 `Orca.exe` 路徑（和 kit 的 `ORCA_DIR` 指向同一個資料夾）。

macOS：

```sh
npx @electron/fuses read --app /Applications/Orca.app
```

裝在自己的「應用程式」資料夾的話是 `~/Applications/Orca.app`。

輸出大致長這樣，每個 fuse 一行：

```text
Analyzing app: Orca.exe
Fuse Version: v1
  RunAsNode is Disabled
  EnableCookieEncryption is Enabled
  EnableNodeOptionsEnvironmentVariable is Disabled
  EnableNodeCliInspectArguments is Disabled
  ...
```

## 結果代表什麼

- **找不到 fuse（例如顯示沒有 fuse wire）**：這版 Orca 沒有用 fuse，或路徑指錯了。先確認 `--app` 指的是 Orca 的執行檔或 `.app`，不是捷徑或 `orca-companion.exe`。
- **`EnableNodeCliInspectArguments` 是 Enabled**：Node 除錯參數照常可用，這一層沒問題。
- **`EnableNodeCliInspectArguments` 是 Disabled**：Orca 不接受 `--inspect` 了。kit 不靠它，注入失效另有原因；但這是收緊除錯介面的訊號，把 Orca 版本和這份輸出一起記在 issue 裡。
- **和上一版比，fuse 都沒變**：fuse 不是原因。接著看 `themer.log`、確認是從捷徑開的，或照 [install.md](install.md#疑難排解) 往下查。
- **看不懂、或出現上表以外的 fuse 被改**：把整份輸出貼進 issue（輸出裡不含個人資料，但貼之前還是看一眼路徑有沒有帶到你的使用者名稱）。

更新前後各查一次、把輸出存起來，下次就能直接比對哪個開關變了。

## 查完：確認除錯埠是關的

排查時如果自己試過用 `--remote-debugging-port` 或 `--inspect` 開 Orca，查完一定要把那個 Orca 關掉，改回從 kit 的捷徑開。`--remote-debugging-port` 會在本機開一個 TCP 埠，本機任何程式都能連上去在 Orca 裡跑程式（見 [injection-approaches.md](injection-approaches.md)）。

確認方式：

- Windows（PowerShell）：`Get-NetTCPConnection -State Listen -OwningProcess (Get-Process Orca).Id`
- macOS：`lsof -nP -iTCP -sTCP:LISTEN | grep -i orca`

列出來的埠裡不應該有你剛才指定的除錯埠（常見是 `9222`），也不應該有 `9229` 這類 Node 除錯埠。kit 自己用的是 `--remote-debugging-pipe`，不開任何網路埠；Orca 本身若有其他功能在聽埠，那不是 kit 開的。
