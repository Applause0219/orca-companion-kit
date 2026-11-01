# 主題不見了：用 DevTools 一步步找原因

這份是小抄。遇到「主題明明有套，某個地方卻變回 Orca 原本的樣子」或「整套主題突然消失」時，照這個順序在 Orca 視窗的 DevTools 裡查。

先記住 kit 是怎麼放主題的（見 `src/page-runtime.js` 的 `styleElement()`）：

- 主題 CSS 全部寫在 **一個** `<style id="orca-themer-style">` 裡，換主題時只改它的 `textContent`。
- 一個 MutationObserver 盯著 `<head>` 的子節點；Orca 之後再載入 chunk 樣式表時，就把這個 `<style>` 搬回 `<head>` 最後，好讓規則一樣具體時由它勝出。
- Ctrl+Alt+T 選單自己的樣式在另一個 `<style id="orca-themer-ui">`，跟主題無關。

所以主題消失，多半是這三種情況之一：節點被拿掉或內容被清空、有別的規則比較具體所以贏了、節點裡被塞了別的東西。

## 0. 先確認節點還在不在

在 Console 執行：

```js
const s = document.getElementById('orca-themer-style')
s && { connected: s.isConnected, last: document.head.lastElementChild === s, length: s.textContent.length, children: s.childNodes.length }
```

- 回 `null`：節點被拿掉了，往下看第 1 步。
- `length` 是 `0`：內容被清空了。關掉主題、或打字診斷暫停 CSS 時也會是空的，先確認不是這兩種情況。
- `last` 是 `false`：有東西排到它後面了。observer 通常馬上就會把它搬回去，一直是 `false` 就代表 observer 沒在跑。
- `children` 大於 `1`：被塞了子節點，看第 3 步。

## 1. 對 style 節點下 subtree modification 中斷

想知道「是誰動了它」時用這招。

1. Elements 面板找到 `<head>` 裡的 `<style id="orca-themer-style">`。
2. 在節點上按右鍵 → **Break on** → **subtree modifications**。想知道誰把整個節點拿掉，就改在 `<head>` 上勾 **node removal** 或 **subtree modifications**。
3. 重現問題（換主題、開關某個 touch、等 Orca 載入某個頁面）。
4. 停下來後看 Sources 面板右側的 **Call Stack**：
   - 最上層是 `page-runtime.js` 的 `apply` 或 `styleElement`：這是 kit 自己在換主題，正常。按繼續。
   - 最上層是某個 touch 或 Orca 的 chunk：這就是兇手，記下檔名和函式。

注意：

- 存檔熱重載、換主題都會改 `textContent`，一定會觸發中斷。先把會停下來的正常情況按掉，再重現問題。
- 中斷點記在當下這份文件上，視窗 reload 之後要重下。
- 停在中斷點時整個視窗都凍住，寵物和打字特效也會停；查完記得把中斷點拿掉（Sources → **DOM Breakpoints** 取消勾選）。

## 2. 用 `$0` 和 `getComputedStyle` 看是哪條規則贏了

節點還在、內容也在，某個地方卻沒變色，通常是有更具體的規則蓋過去。

1. 用 Elements 面板左上角的選取工具點那個沒變色的元素，它就變成 `$0`。
2. 在 Console 看實際算出來的值：

   ```js
   getComputedStyle($0).backgroundColor
   getComputedStyle($0).getPropertyValue('--background') // 主題設的 CSS 變數
   ```

   變數有值、屬性卻不對，代表那個元素沒有用這個變數，或有別的規則直接寫死了顏色。

3. 回 Elements 面板的 **Computed** 分頁，找到那個屬性，展開箭頭，會列出所有設了這個屬性的規則，第一條（沒被劃掉的）就是贏的那條，旁邊有它來自哪份樣式表。點過去就跳到 **Styles** 分頁對應的位置。
4. 贏的規則不是來自 `#orca-themer-style` 時，比一下選擇器的具體程度。規則一樣具體才看順序；比較具體的一方不管排在哪都會贏。修法是在主題裡把選擇器寫得更具體（例如加上 `html.dark`，或對準 [themes.md](themes.md) 列的 DOM 掛點），而不是到處加 `!important`。

改完先存檔、跑 `npm run check`，[performance.md](performance.md) 的效能守則一樣適用。

## 3. 檢查 style 節點有沒有被塞子節點

`<style>` 正常只有一個文字子節點。kit 每次套用都是直接設 `textContent`，**這會把節點裡所有子節點一次換掉**。所以：

- 有人（某個 touch、擴充、或在 DevTools 裡手動）往 `#orca-themer-style` 裡 `appendChild` 了文字或元素，下一次換主題、存檔熱重載時，塞進去的東西就會整個不見。看起來像「我加的樣式被清掉了」，其實是被覆寫了。
- 反過來，塞進去的東西如果有語法錯誤，可能讓同一份樣式表後面的規則被 CSS parser 一起丟掉，看起來像主題壞了一半。

在 Console 檢查：

```js
const s = document.getElementById('orca-themer-style')
;[...s.childNodes].map((n) => [n.nodeName, (n.textContent || '').slice(0, 60)])
```

只看到一個 `#text` 才是正常的。多出來的節點，用第 1 步的 subtree modification 中斷找出是誰塞的。

修法：要加自己的 CSS，放進主題檔或 `snippets/`（見 [themes.md](themes.md#片段snippets)），touch 要動態加樣式就建一個自己的 `<style>`，不要寫進 `#orca-themer-style`。

## 為什麼不用 XHR 中斷

主題 CSS 不是頁面用 XHR／fetch 抓來的，是啟動器經由私有的 CDP 管線呼叫 `__orcaThemer.*` 送進來的，所以 Sources 的 **XHR/fetch Breakpoints** 抓不到換主題的時機。要查「是不是某個網路請求回來後，Orca 重畫了某塊畫面把樣式蓋掉」時才用得上：在 XHR/fetch Breakpoints 加一個網址片段，停下來後再搭配第 1、2 步看是哪段程式改了 DOM。

## 不要做的事

- 不要為了接 DevTools 另外開 `--remote-debugging-port`，也不要關掉啟動器或 Orca 來換連線方式。
- 在 DevTools 裡改的值只存在當下的頁面，reload 就沒了；滿意的值要自己抄回 `~/.orca/themer/` 的主題檔。
