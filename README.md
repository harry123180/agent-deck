# Agent Deck

Windows 桌面應用：用分頁（左側 tab 列）管理每個專案的 agent CLI session。
重開機後只要打開它，所有 tab 會回到原本的資料夾，並自動執行 **resume 指令**。

## 為什麼不用 tmux
tmux 的 session 活在 process 裡，**重開機一樣會消失**。真正需要還原的是「路徑 + agent + resume 方式」，
所以 Agent Deck 把工作區存成 JSON（`%APPDATA%\agent-deck\state.json`，原子寫入 + `.bak` 備份），
每次啟動重建 PTY（ConPTY）並輸入 resume 指令。

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
- **📊 Token用量**（側邊欄下方按鈕，點進去才載入）：用 [ccusage](https://github.com/ryoppippi/ccusage) 統計
  - 總覽：今天 / 近 7 天 / 近 30 天花費、每日花費長條圖（依資料夾堆疊）、模型佔比
  - 依專案：依「專案群組」或「資料夾」看花費、token、30 天走勢；同資料夾的多張卡片只算一次
  - 配額：目前 5 小時視窗的剩餘時間、花費、燒錢速度、預估結束時用量。注意這是 ccusage 的推算（跟你自己歷史最高的視窗比），不是官方方案上限；官方額度請在 Claude Code 內用 `/usage`
  - ccusage 每次都要掃描整個 `~/.claude` 歷史（大的話要 1～2 分鐘），所以結果會存成快取，開啟時先顯示上次的資料，超過 15 分鐘才在背景更新。需要連網取得價格表（離線時新模型的花費會顯示 $0）
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

## 多個 Claude 帳號：達到上限時一鍵切換
原理：Claude Code 用環境變數 `CLAUDE_CONFIG_DIR` 決定「設定資料夾」，登入狀態與對話紀錄都在裡面。Agent Deck 把每個帳號對應到一個資料夾（預設帳號 = 你現在的 `~/.claude`），每張卡片綁定一個帳號，啟動時把對應的 `CLAUDE_CONFIG_DIR` 帶進終端機。

**設定（只需一次）**：側邊欄 `👤 帳號` → `＋ 新增帳號`（預設資料夾 `~/.claude-b`）→ 按「登入」，會開一個終端機執行 `claude auth login`，在瀏覽器登入第二個帳號 → 按「驗證」確認顯示 email 與方案。登入網頁若自動帶入第一個帳號，請在網頁上切換；也可以先填「登入用 email」。

**切換**
- 畫面偵測到用量上限（`Usage limit reached`、`session/weekly/Opus limit reached`、`You've hit your … limit`、`out of usage credits`）時，該卡片會顯示「已達上限」，並在終端機上方跳出橫幅：`切換到「帳號 B」並接續對話`。
- 按下後：把這張卡片的**那一個對話檔**（`projects/<資料夾>/<id>.jsonl`、其子資料夾與 `file-history/<id>`）複製到帳號 B 的資料夾 → 終止舊終端機 → 用 B 的環境變數重開 → 執行 `claude --resume <同一個 id>`。同一個對話無縫接續。
- 右鍵卡片 →「切換到「帳號 X」並接續對話」可隨時手動切換（切回去時會把 B 上較新的內容帶回 A，以較新者為準）。
- 原帳號找不到這個資料夾的對話時，橫幅會說明原因並提供「改用帳號 B 開新對話」。
- 可選：帳號視窗勾選「偵測到用量上限時自動切換」（預設關閉）。若另一個帳號 10 分鐘內也剛達上限，不會來回切換；同一張卡片 2 分鐘內最多自動切換一次。
- 卡片與窗格標題上有帳號色塊（A / B）。新增卡片時可選帳號，並從該帳號的資料夾偵測最近對話。

**安全**：只複製對話相關檔案，**從不讀取或複製**登入憑證（`.credentials.json`、`.claude.json`）。單元測試與端對端測試都驗證了這點。

**Token用量**：右上有帳號切換，「配額」分頁會並排顯示每個帳號目前 5 小時視窗的用量，一眼看出該切去哪個。

Codex 同理可用 `CODEX_HOME` 隔離登入（目前 Agent Deck 的帳號切換只處理 Claude）。

## 注意
- Codex / OpenCode / Gemini / agy 的「最近一次」是以資料夾為單位。同一資料夾開多張這類卡片時，重開後會接到同一個對話；請改填各自的 session id。
- 新增卡片時，同專案的卡片會自動帶入該專案現有卡片的資料夾。

## 授權 License

本專案採用 **[PolyForm Noncommercial License 1.0.0](./LICENSE)**：

- ✅ **允許**：個人使用、學習、研究、教學、非營利組織使用、修改與再散布（需保留授權與版權聲明）。
- ❌ **禁止商用**：不得將本軟體或其衍生作品用於商業目的（例如販售、收費服務、公司內部營利工作流程等）。

若需要商業授權，請開 issue 聯絡作者。
