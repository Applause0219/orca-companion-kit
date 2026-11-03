# 主題作者檢查清單

寫主題 CSS、snippet 或 touch 時一條一條對過。重點只有一個：Orca 改版、重新整理或換頁之後，主題要嘛照樣生效，要嘛安靜地退回 Orca 原本的樣子，**不能讓畫面壞掉**。

## 選擇器：照穩定程度挑

由上往下挑，前面的能用就不要往後找：

1. **role／aria**：`[role='separator']`、`[aria-label='…']`、`[aria-selected='true']`。這些是給輔助工具用的，Orca 改版時最少動。
2. **穩定屬性**：`data-testid`、`data-*`（例如 `[data-testid="sortable-tab"]`、`[data-agent-activity-status]`）、元素 id。kit 已經查過、比較可靠的掛點列在 [themes.md 的 DOM 掛點](themes.md#dom-掛點)。
3. **class**：只用看得懂、像是人取的名字（`.xterm`、`.monaco-editor`、`.bg-worktree-sidebar`），而且盡量跟上面的屬性一起用來縮小範圍。

避開：

- [ ] **雜湊 class**：像 `.css-1x2y3z`、`._a8f3c`、`.sc-bdVaJa` 這種建置時產生的名字，每次 Orca 重新打包都可能換。
- [ ] **`nth-child`／`nth-of-type`**：Orca 多一個按鈕、少一個分頁，就會套到別的元素上。
- [ ] **比對文字**：Orca 改了字、換了語言就失效；CSS 也沒有穩定的方式比對文字，硬做只能靠 touch 去讀 `textContent`，又慢又脆弱。
- [ ] 很長的後代鏈（`div > div > div > span`）：中間任何一層改了結構就斷。

## 樣式節點：固定 id，不重複

- [ ] 自己加的 `<style>` 一定要有**固定的 id**（例如 `my-touch-style`）。
- [ ] 加之前先用 `document.getElementById` 找同 id 的節點：有就先刪掉（或直接改它的 `textContent`），再加新的。不要每次都 `appendChild` 一個新的，重新套用幾次就會疊出好幾份。
- [ ] touch 的 `stop()` 要把它加的 `<style>` 和元素都拿掉（見 [touches.md](touches.md)）。
- [ ] 主題 CSS 本身不用自己放：kit 把它寫在單一的 `<style id="orca-themer-style">`，換主題只改內容，並一直把它留在 `<head>` 最後（見 [debug-theme-overwritten.md](debug-theme-overwritten.md)）。

## 重新載入、換頁之後要再套一次

- [ ] 不要假設頁面只載入一次。Orca 重新整理（Ctrl+R）或換頁後 DOM 是全新的，先前加的節點和監聽器都沒了。
- [ ] 主題 CSS 和 touch 由 kit 在每次載入前重新注入，不用自己處理；touch 自己在 `start()` 裡建立的東西，`start()` 要能被重複呼叫（存檔熱重載、換主題都會先 `stop()` 再 `start()`）。
- [ ] 要盯的元素可能晚一點才出現（Orca 會延後載入畫面的某些部分）：等它出現再動手，不要在 `start()` 一開始找不到就放棄或丟錯。用 MutationObserver 前先看 [performance.md](performance.md)，範圍盡量小。

## 失敗時安靜退回原本的樣子

- [ ] 找不到掛點就什麼都不做：選擇器對不到時 CSS 本來就不會生效，touch 裡也一樣，`querySelector` 回 `null` 就 `return`。
- [ ] touch 裡可能出錯的地方包 `try { … } catch {}`，不要讓錯誤擋住 Orca 自己的程式。
- [ ] 不要把 Orca 原本的元素藏起來再自己畫一個新的去取代；注入失敗時，使用者會什麼都看不到。改顏色、加裝飾就好。
- [ ] 改版後先開一次 Orca 看看：啟動器會自動查常駐的掛點，找不到時會跳提醒（見 [themes.md](themes.md#dom-掛點)）。

## 寫完之後

- [ ] 跑 `npm run check`，抓出已知會讓 Orca 變慢的寫法。上面「避開」的 `nth-child`、雜湊 class、比對文字也會出 `fragile-selector` 警告（只提醒、不擋），看到就改用 role／aria 或穩定屬性。
- [ ] 主題某塊沒套上或被蓋掉時，照 [debug-theme-overwritten.md](debug-theme-overwritten.md) 用 DevTools 查。
