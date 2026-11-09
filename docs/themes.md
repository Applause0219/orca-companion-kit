# 主題 Themes

主題就是一個 CSS 檔，放在 `~/.orca/themer/themes/<id>.css`。檔名（不含 `.css`）就是主題 id。存檔後會立刻套用到每個 Orca 視窗。

## 檔頭

檔案開頭的註解區塊寫 meta：

```css
/**
 * @name 我的主題
 * @author 我
 * @description 一句話說明（會顯示在 Ctrl+Alt+T 選單）
 * @touches power-mode, my-pet, custom-cursor
 */
```

`@touches` 列出這個主題要用的 touch id，用逗號分隔。**只有列在這裡的 touch 會在這個主題下執行。** 第一次用這個主題時會全部打開；之後使用者在選單裡關掉哪一個，就一直維持關閉。

內建的 touch：

| id | 作用 |
| --- | --- |
| `power-mode` | 終端機打字時從游標迸出火花，並計算連擊數；顏色取 `--oc-spark-1..4` |
| `custom-cursor` | 在 `<html>` 加上 `data-orca-touch-custom-cursor`，主題 CSS 依這個屬性換游標 |
| `theme-sound` | 把 Orca 的通知音效換成 `sounds/<主題 id>.wav`，關掉就換回原本的 |

你自己的 touch 和寵物放在 `~/.orca/themer/touches/*.js`，見 [touches.md](touches.md) 和 [companion-api.md](companion-api.md)。

## Orca 的 CSS 變數

最穩的主題只改變數。Orca 的介面是 Tailwind + shadcn 風格的 token，變數名稱很少變，Orca 更新後幾乎不會壞。

完整清單在 Orca 原始碼的 **`src/renderer/src/assets/main.css`**，看 `.dark` 區塊（亮色模式是 `:root`）。主題請寫在 `html.dark { ... }` 裡；Orca 預設是暗色。常用的有：

| 變數 | 用在哪裡 |
| --- | --- |
| `--background` `--foreground` | 視窗底色、主要文字 |
| `--editor-surface` | 編輯器、終端機區塊的底色 |
| `--card` `--card-foreground` | 卡片、面板 |
| `--popover` `--popover-foreground` | 選單、浮出框、通知 |
| `--primary` `--primary-foreground` | 主要按鈕、選取中的項目 |
| `--secondary` `--muted` `--muted-foreground` | 次要底色、說明文字 |
| `--accent` `--accent-foreground` | 滑鼠移過、聚焦時的底色 |
| `--border` `--input` `--ring` | 框線、輸入框、聚焦外框 |
| `--sidebar*` | 左側欄（`--sidebar`、`-foreground`、`-primary`、`-accent`、`-border`、`-ring`） |
| `--worktree-sidebar*` | worktree 清單側欄 |
| `--ai-action-accent` `--agent-working` | AI 動作的強調色、agent 工作中的指示 |
| `--destructive` `--status-success` `--status-warning` | 錯誤、成功、警告 |
| `--callout-note` `--callout-important` | Markdown 提示框 |
| `--radius` | 圓角基準 |

另外記得寫 `color-scheme: dark;`，捲軸和原生控制項才會跟著變暗。

想確認某個變數用在哪裡：開 Orca 的開發者工具（若你的 Orca 版本有開放，通常是 Ctrl+Shift+I 或「View」選單），選一個元素，看 Styles 面板裡用到的 `var(--…)`。

## 這個 kit 自己的變數

| 變數 | 用在哪裡 |
| --- | --- |
| `--oc-spark-1` … `--oc-spark-4` | power-mode 的火花顏色（沒設時依序退回 `--primary`、`--ring`、`--foreground`、`--ai-action-accent`） |
| `--asset-<檔名>` | 見下方「圖片素材」 |

## DOM 掛點

需要針對特定元素時，用這些比較穩定的掛點（它們是 Orca 內部的實作細節，更新後仍可能改變；寫的時候盡量讓規則失效也不會壞掉畫面）：

| 選擇器 | 是什麼 |
| --- | --- |
| `html.dark` | 暗色模式 |
| `html[data-orca-theme="<id>"]` | 目前套用的主題 id（由執行環境設定） |
| `html[data-orca-touch-<id>]` | 某個屬性型 touch 開著（`registerAttrTouch`） |
| `.xterm`、`.xterm-helper-textarea` | 終端機、xterm 用來接收輸入的隱藏 textarea（它的位置就是游標位置） |
| `[data-testid="sortable-tab"]` | 分頁；屬性 `data-tab-id`、`data-tab-title`、`data-agent-activity-status`（`working`、`permission`、`done`、`failed`） |
| `.bg-worktree-sidebar[data-os-file-drop-owner]` | worktree 側欄（寵物預設待在它右下角） |
| `[data-sonner-toast]` | 通知。**它的 `::before`、`::after` sonner 自己在用**，裝飾請用 `background` 疊圖層 |
| `[data-sidebar-resize-handle]` | 左側欄右緣可拖曳改寬度的那條邊 |
| `[data-panel-resize-handle-id]`、`[role='separator']` | 面板之間可拖曳的分隔線（只在分割窗格時才有） |
| `.monaco-editor`、`.monaco-diff-editor` | 檔案編輯器（Monaco）。它不吃 Orca 的變數，背景是自己的 `--vscode-editor-background`；在這兩個選擇器上用 `!important` 改這些 `--vscode-*` 變數（四套內建主題結尾都有範例） |

Orca 改版後第一次啟動，啟動器會自動查一次常駐的掛點（worktree 側欄、側欄拖曳邊，以及開著終端機時的分頁和終端機輸入框）。找不到的會在 Orca 跳一則提醒，細節寫進 `themer.log`；同一版只查一次，查過的版本記在 `~/.orca/themer/orca-version.json`。

## 終端機配色

外框主題管不到終端機，終端機配色另外放在 `~/.orca/themer/terminal/<主題 id>.json`（格式是 Orca 的 TerminalColorOverrides）：

```json
{
  "background": "#161a2e", "foreground": "#ece8f6", "cursor": "#ffd8a8", "cursorAccent": "#161a2e",
  "selectionBackground": "#3a3f66", "selectionForeground": "#ffffff",
  "black": "#232842", "red": "#ff8fa3", "green": "#a8e6c1", "yellow": "#ffe0a3",
  "blue": "#9fc4ff", "magenta": "#d9c2ff", "cyan": "#9fe3e6", "white": "#d8d4e8",
  "brightBlack": "#6f6b8f", "brightRed": "#ffb3c1", "brightGreen": "#c6f0d6", "brightYellow": "#fff0c8",
  "brightBlue": "#c3dbff", "brightMagenta": "#ead9ff", "brightCyan": "#c4f1f2", "brightWhite": "#fff9f0"
}
```

選這個主題時，啟動器會用 Orca 自己的設定 API 匯入這份配色並設為終端機主題（等於幫你按「設定 → 終端機 → 匯入」）。換回別的主題時，原本的終端機主題會還原。終端機當場換色，視窗不用重新載入。萬一新版 Orca 改掉了這條路，啟動器會改成重新載入主視窗一次，先跳一行字告訴你；終端機會重新接上，工作不會中斷。

Orca v1.4.246 以上也有官方的 ANSI 配色外掛，和這份配色改的是同一個設定；兩者怎麼分工見 [official-theme-plugins.md](official-theme-plugins.md)。

配色要確認對比：一般文字和背景至少要 4.5:1；`brightBlack` 常拿來顯示註解和提示，也要看得清楚。

## 游標

游標用 SVG 畫，24×24，熱點（點擊落在的那一點）通常是箭頭尖端。轉成 CSS：

```powershell
npm run cursor -- my-cursor.svg 2 2 > cursor.css   # 2 2 = 熱點座標（以 24px 圖計）
```

產生的規則掛在 `html[data-orca-touch-custom-cursor]` 底下，貼進主題，並在 `@touches` 加上 `custom-cursor`。這樣使用者可以在選單裡關掉游標，不必改主題檔。

- 用 `-webkit-image-set(... 1x, ... 2x)`：高解析度螢幕會用 48px 那張，游標才不會糊。
- 面板分隔線、調整大小的邊緣會保留系統游標，因為它們告訴你拖曳會發生什麼事。
- 輪廓要有深淺兩色，在亮的和暗的背景上都要看得到。

範例：`examples/cursors/cotton-pointer.svg`。

## 音效

```powershell
npm run chime -- ~/.orca/themer/sounds/<主題 id>.wav 1046.5 1318.5 1568
```

這會用正弦波合成一段鈴聲（你擁有它的全部權利）。在 `@touches` 加上 `theme-sound`，選這個主題時它就會變成 Orca 的通知音效。也可以放你自己錄的 `.wav`。

## 圖片與音檔素材

`~/.orca/themer/assets/<主題 id>/` 裡的圖片會自動變成 CSS 變數：`portrait.png` 對應 `var(--asset-portrait)`。音檔（`.ogg`、`.mp3`、`.m4a`、`.wav`）也一樣：`lullaby.ogg` 對應 `--asset-lullaby`，寵物可以用 `api.asset('lullaby')` 拿到網址來放（見 [companion-api.md](companion-api.md#用自己的音檔唱歌)）。這些檔案只會留在你的電腦上，請用你有權使用的素材。

```css
html.dark .bg-worktree-sidebar[data-os-file-drop-owner] {
  background: var(--asset-portrait) right bottom / 160px no-repeat, var(--worktree-sidebar);
}
```

## 片段（snippets）

`~/.orca/themer/snippets/*.css` 是可以跟任何主題疊在一起的小檔案，在選單的「片段」裡逐一開關，例如 `examples/snippets/soft-corners.css`。

## 寫完之後

```powershell
npm run check
```

它會檢查[效能守則](performance.md)、檔頭、`@touches` 裡的 id 有沒有對應的 touch 檔，以及終端機配色的格式。

想直接用 CDP 把整套 CSS 丟進頁面做實驗（`CSS.createStyleSheet` → `setStyleSheetText`），見 [stylesheet-swap.md](stylesheet-swap.md)。
