# Agent Deck

**一個視窗，管理你所有的 AI 寫程式助手。**

如果你同時開很多專案、每個專案都跑 Claude Code、Codex、OpenCode 之類的工具，你一定遇過這些事：

- 關機重開後，要一個一個進資料夾、一個一個 resume 對話。
- 同時跑幾十個 agent，有的已經做完在等你，有的卡住了，你卻沒發現。

Agent Deck 幫你解決這些問題。它是一個 Windows 桌面程式，把每個專案開成一張「卡片」，卡片列在左邊，右邊是終端機。關掉再打開，所有卡片會自動回到原本的資料夾，並接回上次的對話。

![總覽](docs/screenshots/overview.png)

## 它能做什麼

- **一張卡片 = 一個專案 = 一個 agent 對話**，重開機後自動接回。
- **燈號告訴你狀態**：藍色波浪是工作中，綠色靜止是做完了等你，黃色十字是需要你決定，紅色 X 是出錯了。背景的卡片如果需要你，外圈會亮起來。
- **群組**：把相關的卡片放進同一個專案群組，可以收合。收合時仍看得到裡面有沒有需要你的卡片。
- **分割畫面**：一個畫面同時看多個 agent。點專案標題的 `⊞`，就會把該專案的卡片並排排好。

![分割畫面](docs/screenshots/split.png)

- **收合側欄**：不需要卡片列時可以收起來，只留下每張卡片一個色點。

![收合側欄](docs/screenshots/collapsed.png)

## 怎麼開始

1. 安裝 [Node.js](https://nodejs.org/)，然後在這個資料夾執行：
   ```
   npm install
   npm start
   ```
   （或直接雙擊 `start.bat`）
2. 按 **＋** 新增卡片：選資料夾、選 agent（Claude Code、Codex、OpenCode…），按儲存。卡片會自動開啟並執行對應的指令。
3. 想回到之前的工作？按 **⤓ 匯入現有**，它會找出你正在跑的終端機和最近的 Claude 對話，勾選後一鍵加進來。

## 基本操作

| 想做什麼 | 怎麼做 |
|---|---|
| 新增卡片 | `＋` 或 Ctrl+T |
| 切換卡片 | 點左邊的卡片，或 Alt+1～9 |
| 改名字 | 雙擊卡片，或按 F2 |
| 換顏色 | 右鍵卡片 → 顏色 |
| 建立專案群組 | 側欄頂端 `▤＋` |
| 分割畫面 | 點專案標題的 `⊞`；Ctrl+點卡片可加入或移出分割 |
| 收合側欄 | ◀ 或 Ctrl+B |
| 放大或縮小字體 | Ctrl+滾輪，Ctrl+0 還原 |
| 關閉卡片 | Ctrl+W（不會刪除資料夾） |

## 支援的 agent

Claude Code、Codex、OpenCode、Gemini CLI、agy，以及任何能在終端機執行的工具（選「自訂」填入指令即可）。

## 🧭 中控 Agent：讓 agent 之間互相溝通（跨平台）

按側欄下方的 **🧭 中控**，會開一張 Claude Code 卡片當「中控」。它能看到每張卡片在做什麼，也能把訊息送給任何一張卡片裡的 agent，不論那張是 Claude Code、Codex 還是 OpenCode。卡片裡的 agent 也能回覆中控或傳給彼此。

中控可以用的工具（agentdeck MCP）：

| 工具 | 做什麼 |
|---|---|
| `list_agents` | 列出所有卡片：名稱、平台、專案、目前狀態 |
| `read_agent` | 讀某張卡片最新的畫面 |
| `send_to_agent` | 傳訊息給某張卡片（預設等它「待輸入」才送，不會打斷它正在做的事） |
| `wait_for_agent` | 等某張卡片做完，取回它的畫面 |
| `message_status` | 查訊息送達了沒 |

你可以直接跟中控說：「看一下大家的狀態」、「請 backend 跑完測試後回報給我」、「叫 docs 依照 backend 的 API 更新文件」。

**各平台怎麼接上**（Agent Deck 自動處理，不會改你自己的設定檔）：

| 平台 | 方式 |
|---|---|
| Claude Code | 啟動指令自動加上 `--mcp-config` |
| Codex | 啟動指令自動加上 `-c mcp_servers.agentdeck.*` |
| OpenCode | 卡片終端自動帶 `OPENCODE_CONFIG_CONTENT`，會和你原本的 MCP 設定合併 |
| agy | 只能全域設定，需要自己執行一次：`agy mcp add agentdeck "%APPDATA%\agent-deck\central\agentdeck-mcp.cmd"`（尚未實測） |

**安全設計**
- 訊息只在本機傳遞（127.0.0.1，每次啟動產生新的隨機 token）。
- 只有中控卡片預先允許使用這些工具；一般卡片要傳訊息前，會照該 agent 的權限設定先問你。
- 訊息只會送進「待輸入」的卡片，不會貼進正在問你問題（需決策）的畫面。
- 每則訊息都標明寄件人；同一串對話最多來回 4 次，避免 agent 之間無限互傳。
- 收到的訊息是「另一個 agent 寫的」，請像看待任何外部輸入一樣看待它。

**設計參考**：這套做法參考了 Claude Code 自己的跨 session 訊息機制（session 註冊表、每個 session 的訊息通道、`from` 與 `hop-chain` 標記、「等對方閒下來再通知」），但改成不綁定特定平台：用 MCP 當共同介面，用「在對方閒置時把訊息貼進它的終端」來送達，所以任何能在終端機跑、支援 MCP 的 agent 都能參與。

## 系統需求

目前只在 **Windows 10／11** 測試過，macOS 還沒有支援。

## 給開發者

```
src/main/        主程序（終端機、存檔、session 掃描）
src/renderer/    畫面
test/            單元測試：node test/<name>.test.js
scripts/         開發用腳本（產生圖示）
```

## 授權

[PolyForm Noncommercial 1.0.0](./LICENSE)：**可以免費用、學習、修改、分享，但禁止商業用途。** 需要商業授權請開 issue 聯絡作者。
