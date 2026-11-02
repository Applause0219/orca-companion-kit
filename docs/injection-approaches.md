# 為什麼用 CDP 注入，不用 preload

要把主題 CSS 和 touch 放進 Orca 這種 Electron app，常見有兩條路：

- **preload 注入。** 在 app 的主程序裡替視窗加一支 preload 腳本（`webPreferences.preload`、`session.setPreloads()`），或改寫 app 裡現有的 preload。`electron-css-injector` 這類工具走的就是這條路。
- **CDP 注入。** app 照常啟動，從外面經由 Chrome DevTools Protocol 連進每個視窗，用 `Page.addScriptToEvaluateOnNewDocument` 讓每份新文件一載入就先跑我們的程式，再用 `Runtime.evaluate` 補上已經在跑的頁面。

這個 kit 選 CDP。下面這張表是兩者的比較。

## 比較

| | preload 注入 | CDP 注入（這個 kit） |
| --- | --- | --- |
| **要不要改 app 檔案** | 要。preload 是由主程序設定的，得改 Orca 的 `app.asar`（或解開重包），或在 Orca 的主程序裡多跑一段程式。 | 不用。Orca 的檔案一個 byte 都沒改，啟動器只是用 `--remote-debugging-pipe` 開它。 |
| **換頁或重新整理後要不要重套** | 不用。preload 是視窗設定的一部分，每份新文件 Electron 都會自己再跑一次。 | 不用手動重套，但要靠啟動器：`Page.addScriptToEvaluateOnNewDocument` 會在每次重新整理、每個新視窗自動再跑；另外在新的執行環境建立時再送一次 `Runtime.evaluate` 補漏，頁面那邊收到第二份會略過。存檔時啟動器會換上新版腳本並當場套用。 |
| **更新 Orca 後會不會失效** | 會。更新會整個換掉 `app.asar`，改過的地方全部消失，每次更新都要重做；若 app 開了 asar 完整性檢查，改過的檔案甚至開不起來。 | 不會。更新換掉的是 Orca 自己的檔案，注入是從外面來的，下次經由啟動器開 Orca 就照常套上。唯一例外是更新完 Orca 自己重開的那一次沒經過啟動器，見 [install.md](install.md#為什麼-orca-更新後不會壞)。 |
| **除錯埠的風險** | 沒有，preload 不需要開除錯介面。 | 看怎麼開。`--remote-debugging-port` 會在本機開一個 TCP 埠，本機任何程式都能連上去在 Orca 裡跑程式，風險高，**這個 kit 不用它**。kit 用的是 `--remote-debugging-pipe`：一對只交給啟動器這個子程序的檔案描述元，不開任何網路埠，別的程式連不進來。 |

## 代價

CDP 這條路也有它的限制，選它是因為上面四項比較划算，不是沒有缺點：

- **要經由啟動器開 Orca。** 直接點 `Orca.exe` 開的視窗沒有管線，也就沒有主題。所以 Windows 版會把捷徑指回啟動器，Orca 更新把捷徑改回去之後也會再修好（[install.md](install.md)）。
- **注入時機要自己顧。** 啟動器用 `Target.setAutoAttach` 搭配 `waitForDebuggerOnStart`，讓每個新視窗先停住，等注入的指令都送出才放行，所以 Orca 的第一行程式跑之前主題就在了。重新整理和新視窗的行為由 `test/reinject.test.mjs` 把關。
- **只能有一個人拿著管線。** Orca 已經經由管線開著時，再點一次啟動器只會把 Orca 叫到前面。

## 延伸閱讀

- [install.md](install.md)：安裝、撐過 Orca 更新的原理
- [fixes.md](fixes.md)：同樣經由 CDP，在執行期替換 Orca 的程式片段
- [performance.md](performance.md)：注入進去的東西要守的效能規則
