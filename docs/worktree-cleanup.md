# 分支合併之後：worktree 收尾清單

用 git worktree 讓好幾個 agent 平行做事很方便，但分支合併之後，常常留下沒清掉的 worktree 資料夾、Orca 裡還開著的分頁，和用不到的本機分支。這份是收尾的小抄，照順序做一遍就乾淨了。

原則：

- **每一步都是人自己下指令。** 這份只列指令和檢查方式，kit 不會自動幫你刪任何東西。
- **先檢查、再刪。** 每個刪除步驟前面都有一個檢查，檢查不過就停下來問。
- 下面的 `<branch>` 換成你的分支名（例如 `feat/some-feature`），`<path>` 換成那個 worktree 的資料夾，`<main>` 換成主分支（`main` 或 `master`）。

## 0. 先看看現在有哪些 worktree

在主 repo（不是要刪的那個 worktree 裡）執行：

```sh
git worktree list
```

每一行是一個 worktree：路徑、目前的 commit、分支名。找到要收的那一行，記下 `<path>` 和 `<branch>`。

## 1. 確認分支真的已經合併

```sh
git fetch
git branch --merged <main> | grep -F "<branch>"
```

- 有印出分支名：已經合併進 `<main>`，可以往下。
- 沒印出來：可能還沒合併，或是用 squash／rebase 合併的（commit 雜湊會不同，`--merged` 認不出來）。這時改看內容有沒有差：

  ```sh
  git diff <main>...<branch> --stat
  ```

  沒有輸出（或你確認差異都已經以別的形式進了 `<main>`）才往下；不確定就停下來問負責的人。

再確認 worktree 裡沒有還沒 commit 的東西：

```sh
git -C <path> status --short
```

有任何輸出，就代表有改了沒存進 commit 的檔案。先決定要 commit、搬走還是放棄，再繼續。

## 2. 在 Orca 關掉那個分頁

先在 Orca 裡關掉這個 worktree 的分頁（以及裡面還開著的終端機）。原因：

- 終端機的工作目錄還在那個資料夾裡，Windows 上會鎖住資料夾，下一步的 `git worktree remove` 會失敗。
- 還在跑的 agent 可能會繼續往裡面寫檔案。

確認那個分頁裡沒有還在跑的 agent 或程序後再關。

## 3. 移除 worktree

```sh
git worktree remove <path>
```

- 如果回報有修改或未追蹤的檔案而拒絕移除，回到第 1 步檢查，**不要直接加 `--force`**。只有在確定裡面的東西都不要了，才考慮 `--force`。
- 如果回報資料夾被占用（Windows 常見），通常是還有終端機、編輯器或檔案總管開在裡面，關掉再試。

完成後再看一次：

```sh
git worktree list
```

那一行應該不見了。

## 4. 清掉失效的 worktree 紀錄

如果有 worktree 的資料夾是直接被刪掉的（沒有經過 `git worktree remove`），git 還會留著它的紀錄。先看會清掉什麼：

```sh
git worktree prune --dry-run --verbose
```

確認列出來的都是已經不存在的資料夾，再執行：

```sh
git worktree prune
```

## 5. 刪掉本機分支（先問過人）

這一步會刪掉分支，**先問過分支的負責人再做**，就算前面檢查都通過也一樣。

```sh
git branch -d <branch>
```

- 用小寫 `-d`：git 會再檢查一次是否已合併，沒合併就拒絕。
- 如果是 squash／rebase 合併，`-d` 會拒絕；確認過內容都已經在 `<main>` 裡，而且負責人同意之後，才改用 `-D`。
- 遠端分支要不要刪是另一件事，照你們團隊的習慣處理，這份不涵蓋。

## 收尾後檢查

```sh
git worktree list
git branch --list "<branch>"
```

`git worktree list` 不再有那個路徑、`git branch --list` 沒有輸出，就收乾淨了。
