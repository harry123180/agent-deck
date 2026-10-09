# Agent Deck

Windows 桌面應用：用分頁（左側 tab 列）管理每個專案的 agent CLI session。
重開機後只要打開它，所有 tab 會回到原本的資料夾，並自動執行 **resume 指令**。

## 為什麼不用 tmux
tmux 的 session 活在 process 裡，**重開機一樣會消失**。真正需要還原的是「路徑 + agent + resume 方式」，
所以 Agent Deck 把工作區存成 JSON（`%APPDATA%\agent-deck\state.json`，原子寫入 + `.bak` 備份），
每次啟動重建 PTY（ConPTY）並輸入 resume 指令。

## 專案結構

```
src/
  main/        Electron 主程序：PTY、狀態存檔、session 掃描（Node，無畫面）
    main.js        入口與 IPC
    preload.js     安全橋接（contextBridge），畫面只能透過它呼叫主程序
    store.js       工作區 JSON 讀寫（原子寫入 + .bak）與資料正規化
    agents.js      各 agent CLI 的啟動 / resume 指令
    sessions.js    各 agent 最近對話 id 的讀取
    importer.js    匯入現有 cmd / PowerShell 視窗（scan.ps1）
    paths.js       路徑工具
  renderer/    畫面（HTML / CSS / 純瀏覽器 JS，無打包工具）
    index.html renderer.js style.css layouts.js status.js
test/          單元測試（node test/<name>.test.js）
scripts/       開發用腳本（make_icon.py 產生圖示）
assets/        圖示
start.bat      Windows 啟動捷徑
```

## 使用
```
npm install
npm start          # 或雙擊 start.bat
```
- `＋` / Ctrl+T 新增專案：選資料夾 + agent 預設（Claude Code / Codex / OpenCode / Gemini / agy / 純 shell / 自訂）
- **⤓ 匯入現有**：掃描正在跑的 cmd / PowerShell 視窗（讀出工作目錄與裡面跑的 claude/codex/opencode/gemini/agy），加上 `~/.claude/projects` 的 Claude 歷史 session，勾選後一鍵建立 tab；Claude 會用 `claude --resume <session-id>` 精準接回。匯入後請關掉舊視窗，避免同一 session 被兩邊同時操作。
- 每個 tab 有兩個指令：**首次啟動**（`claude`）與 **resume**（`claude --continue`），可任意改，所以 dsh 等任何 CLI 都能用「自訂」
- 左側卡片的 3×3 像素格指示燈（讀取終端畫面最後幾行判斷，可能有誤判）：
  - 藍色波浪 + 計時 = **工作中**（`esc to interrupt`、spinner、或持續輸出）
  - 綠色呼吸 = **待輸入**（agent 做完了，等你下指令）
  - 琥珀色十字脈衝 = **需決策**（權限確認 / y/n / 選項）
  - 紅色 X 閃爍 = **出錯**（API Error、rate limit、command not found、shell 結束…）；你在該 tab 輸入後視為已確認
  - 背景 tab 從工作中變成待輸入/需決策/出錯時，卡片會外圈脈動，點進去才消失
- 卡片：雙擊或 F2 改名；右鍵 → 顏色（8 色 + 自訂）
- **專案群組**：側邊欄頂端 `▤＋` 新增可折疊的專案，卡片可拖曳進去（或右鍵「移到專案」）。收合時標題仍顯示最緊急的狀態（例如「2 需決策」）。
- **分割畫面**：專案標題的 `⊞` 一鍵並排顯示該專案全部卡片（最多 9 格）；也可 Ctrl/Shift+點卡片加入或移出分割。
  - 上方工具列依窗格數提供預設模板（2 格：左右 / 上下 / 左大右小…；3 格：左 1 右 2 / 上 1 下 2…；4 格：2×2 / 左大右 3 / 上大下 3；5 格：左大右 4…）
  - 拖曳分隔線調整比例（雙擊還原）、拖曳窗格標題互換位置、窗格右上 ✕ 移出分割，版面與比例會隨工作區儲存
- **字體縮放**：Ctrl+滾輪（或 Ctrl +/−）縮放目前窗格字體，Ctrl+0 還原；每張卡片各自記住。單一畫面預設 100% 滿版，Ctrl+B 可隱藏側邊欄取得更大空間。

- Ctrl+Tab 切換（分割時在窗格間切換）、Alt+1..9 跳轉、Ctrl+W 關閉、右鍵選單（重新命名 / 加入分割 / 移到專案 / 重啟 / 編輯 / 複製 / 關閉）
- 「開機自啟」勾選後登入 Windows 就自動開啟並還原全部 tab

## 設定（state.json → settings）
- `startup`: `"all"`（預設，全部錯開啟動）或 `"lazy"`（只啟動當前 tab，其餘點了才啟）
- `staggerMs`: 錯開啟動間隔（預設 400ms）
- `shell`: `"auto"`（pwsh → powershell → cmd）或指定路徑
- `fontSize`

## 新增卡片時自動帶入「該資料夾最近的對話 id」
選好資料夾後，會去讀這個路徑底下**真實存在**的對話，帶入 `resume <id>`（對話框會顯示偵測到哪一筆，並可按「偵測最近對話」重新讀取）：

| Agent | 對話來源 | 帶入的指令 |
|---|---|---|
| Claude Code | `~/.claude/projects/<路徑>/*.jsonl`（略過還沒有任何訊息的、與 sub-agent 紀錄） | `claude --resume <id>` |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` 第一行的 `cwd` / `id` | `codex resume <id>` |
| OpenCode | `opencode session list --format json` | `opencode --session <id>` |
| Gemini CLI | 無法用 id 指定 | `gemini --resume latest` |
| agy | 無法讀取 id | `agy --continue` |
| 其他（如 dsh） | — | 自訂 |

- 同一資料夾已被別張卡片接續的對話會自動跳過，改取下一筆；全部用完才開新對話（Claude 會配發新的 `--session-id`）。
- 你手動改過指令欄位就不會被自動覆蓋。


## 注意
- Codex / OpenCode / Gemini / agy 的「最近一次」是以資料夾為單位。同一資料夾開多張這類卡片時，重開後會接到同一個對話；請改填各自的 session id。
- 新增卡片時，同專案的卡片會自動帶入該專案現有卡片的資料夾。

## 授權 License

本專案採用 **[PolyForm Noncommercial License 1.0.0](./LICENSE)**：

- ✅ **允許**：個人使用、學習、研究、教學、非營利組織使用、修改與再散布（需保留授權與版權聲明）。
- ❌ **禁止商用**：不得將本軟體或其衍生作品用於商業目的（例如販售、收費服務、公司內部營利工作流程等）。

若需要商業授權，請開 issue 聯絡作者。
