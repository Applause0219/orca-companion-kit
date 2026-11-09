# AI 協作流程：幫使用者做一套 Orca 外觀

這份文件是寫給 agent 看的（人也可以照著做）。目標是交出一套能用、好看、不拖慢打字的成品，全部放在使用者的資料夾 `~/.orca/themer/`，不要寫進這個 repo。

## 0. 先確認環境

```powershell
node -v                          # >= 20
Test-Path "$env:LOCALAPPDATA\Programs\orca\Orca.exe"
Test-Path "$HOME\.orca\themer"   # exists after the first launch through the kit
```

還沒安裝的話，先帶使用者跑 `npm install`、`.\install.ps1`；想先看範例，可以跑 `npm run example`。**不要替使用者關掉 Orca 或 `orca-companion.exe`**：啟動器一結束 Orca 就會跟著關，正在跑的 agent 工作也會一起中斷。需要重開時，請使用者自己來。

## 1. 訪談（一次問完，給選項）

一次把問題問完，每題附 2–3 個具體選項，讓使用者可以直接挑。使用者回答「都可以」時，就提一個方案，請他確認。

1. **參考圖**：有沒有喜歡的畫面、角色、照片、配色？（請他貼圖或描述）看到圖時，從圖裡取 5–7 個顏色，跟他確認：底色、表面、文字、主色、強調色，以及成功／警告／錯誤三色。
2. **氛圍**：暗色或亮色？安靜或熱鬧？例如「深夜圖書館」「晴天草地」「霓虹街頭」。
3. **寵物**：要不要寵物？是什麼樣的角色？個性是溫柔、調皮、嘴硬還是愛睡？叫什麼名字？說話用什麼語言和口吻？
4. **招牌動作**：牠最有代表性的一個動作是什麼？例如翻滾、彈跳、轉圈、搖尾巴、躲起來。
5. **游標**：要換嗎？什麼形狀（箭頭加小圖案、羽毛、小手）？
6. **其他**：要不要終端機配色？通知音效（高或低、一聲或三聲）？打字火花要不要？

**素材的權利**：如果使用者想要某部作品裡的角色，請說明這套東西是給他自己用的。另外，你要畫的是「受啟發的原創角色」，不是複製官方圖。不要從網路抓圖放進 repo。

## 2. 產出清單

全部放在 `~/.orca/themer/`（以下用 `<id>` 代表主題 id，用小寫英文和連字號，例如 `night-library`）：

| 檔案 | 內容 | 參考 |
| --- | --- | --- |
| `themes/<id>.css` | 檔頭（`@name`、`@description`、`@touches`），`html.dark { … }` 變數，游標規則 | [themes.md](themes.md)、`examples/themes/cotton-sky.css` |
| `terminal/<id>.json` | 終端機 16 色加背景、前景、游標、選取 | [themes.md#終端機配色](themes.md) |
| `touches/<pet>.js` | `registerCompanion({...})`：SVG、parts、lines（含心情台詞 low、lonely、sulk、consoled……）、words、acts、emotion.words | [companion-api.md](companion-api.md)、`examples/touches/puff.js` |
| `sounds/<id>.wav`（選用） | `npm run chime -- …` 產生 | [themes.md#音效](themes.md) |

主題的 `@touches` 要列出用到的 touch：`power-mode, <pet id>, custom-cursor, editor-bg`（有音效再加 `theme-sound`）。

## 3. 怎麼做

### 配色

- 從 `examples/themes/cotton-sky.css` 複製一份，把每個變數換成新的配色，不要漏掉任何一個。完整變數清單在 Orca 原始碼 `src/renderer/src/assets/main.css` 的 `.dark` 區塊。
- 層次：`--sidebar`／`--worktree-sidebar` 比 `--background` 暗一點；`--card`、`--popover` 比它亮一點；`--accent` 再亮一點。
- 對比：文字對背景至少 4.5:1，`--muted-foreground` 也要看得清楚。實際算一次（WCAG 相對亮度），不要用猜的。
- `--primary` 是最搶眼的顏色，`--primary-foreground` 要能放在它上面閱讀。
- `--oc-spark-1..4` 取 3–4 個亮色，當打字火花的顏色。

### 寵物

- SVG `viewBox="0 0 120 120"`，分出有 class 的 `<g>`：眼睛、開心眼、睡眼、左耳、右耳、會飄動的部分。漸層 id 加上寵物名稱當前綴。
- 角色要在 64px 下認得出來。畫完先用 2.5 倍看一次（滾輪放大），確認細節沒有糊掉、亮暗背景上都看得到輪廓。
- 招牌動作寫成 `acts` 裡的一個動作，設定 `signature`。再依個性加 1–3 個動作，例如愛睡的角色就提高 `doze` 的權重（`weight`）。
- 台詞每種 2–5 句，短、口語，符合角色。同一個意思不要寫兩次。不要寫成客服腔或 AI 腔。
- `names` 填角色的名字（中英文都填）。`words` 加 1–2 個跟角色有關的關鍵字反應。
- 問使用者要不要開「要自己打開的行為」（捉迷藏、git 反應、被抓包、蹭蹭、一起讀、提燈，見 companion-api.md）；開了 `caught` 可以替角色寫一個自己的場景，開了 `readAlong` 可以在 SVG 裡畫一副眼鏡（`parts.glasses`）。想讓牠唱歌，請使用者自己放音檔到 `assets/<主題 id>/`，不要替他下載任何音檔。
- 會說話的寵物記得：頻率限制由引擎處理，不要自己另外計時。

### 游標

畫 24×24 的 SVG，箭頭尖端放在 (2,2)，用淺色填色加深色描邊。然後：

```powershell
npm run cursor -- cursor.svg 2 2
```

把輸出貼到主題 CSS 的最後面。

## 4. 驗收（說「完成」之前一定要做）

1. `npm run check`：必須是 0 error。warning 要逐條看過，能修就修。
2. `node --check ~/.orca/themer/touches/<pet>.js`
3. 請使用者在 Orca 按 Ctrl+Alt+T 選這個主題（存檔就會即時套用，不必重開），然後確認：
   - 側欄、分頁、選單、對話框、終端機的配色都對，文字都看得清楚
   - 寵物出現了：拖曳、滾輪縮放、雙擊跟著走、右鍵停下、在牠身上來回移動游標（摸摸）都有反應
   - 在終端機打中文（輸入法）時，寵物會跟著晃，打字不會變慢；要是覺得慢，按 Ctrl+Alt+T →「效能」量一次
   - 游標在亮色和暗色背景上都看得到，點擊位置準確
4. 有不對的地方就修，存檔就會熱重載。

## 提示詞範本

使用者可以直接貼給 agent：

> 幫我用 orca-companion-kit 做一套 Orca 外觀。先讀 AGENTS.md 和 docs/ai-guide.md，然後一次問我需要的問題。
> 參考圖：〔貼圖或描述〕
> 氛圍：〔例：深夜的圖書館，暖黃燈光〕
> 寵物：〔例：一隻戴圓眼鏡的貓頭鷹，叫「墨墨」，安靜、有點愛碎念，招牌動作是頭轉一圈〕
> 游標：〔例：羽毛筆〕
> 要終端機配色和通知音效。

只做寵物：

> 用 docs/companion-api.md 幫我做一隻寵物，放進現在這套主題。角色：〔…〕。個性：〔…〕。招牌動作：〔…〕。台詞用〔語言／口吻〕。

只調配色：

> 照這張圖的配色改 ~/.orca/themer/themes/<id>.css 的變數，維持對比 4.5:1 以上，改完跑 npm run check。
