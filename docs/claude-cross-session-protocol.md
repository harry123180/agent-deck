# Claude Code 跨 session 訊息協定（逆向規格）

本文件描述 Claude Code（v2.1.29x，Windows）本機 session 之間傳訊的方式，以及 Agent Deck 如何以「誠實的 peer」身分參與。
內容由兩種來源整理而成，每一項都標明依據：

- **實測**：用真正的 Claude Code 客戶端與 session 觀察或驗證（包含 Claude Code 內建的 `ListAgents` / `SendMessage` 與 Agent Deck 之間的往來）。
- **程式觀察**：只在 CLI 打包的程式碼中看到，尚未用實際流量驗證。

這是第三方的逆向描述，不是官方文件；Claude Code 改版時可能改變。

## 1. 發現（session 註冊表）

| 項目 | 內容 | 依據 |
|---|---|---|
| 位置 | `~/.claude/sessions/<pid>.json`，每個可收訊的 session 一份 | 實測 |
| 主要欄位 | `pid`、`sessionId`、`cwd`、`name`、`status`（`idle` / `busy`）、`procStart`、`peerProtocol`（目前為 `1`）、`peerFeatures`、`kind`、`entrypoint`、`pidDomain`（`win32:msi`）、`messagingSocketPath` | 實測 |
| `procStart` | 程序的真實啟動時間（Windows FILETIME，100ns 單位，自 1601 年起）；與 `Get-Process` 的 `StartTime.ToFileTimeUtc()` 完全相同 | 實測 |
| `peerFeatures` | 宣告能力。含 `notify_idle` 才會被訂閱閒置通知；未宣告時，寄件端回報「對方版本不支援閒置通知」 | 實測 |
| 被 Claude 列出的條件 | 註冊檔存在、程序仍在執行；Agent Deck 的註冊會出現在 Claude 內建 `ListAgents` 中 | 實測 |

## 2. 收件匣與驗證

| 項目 | 內容 | 依據 |
|---|---|---|
| 收件匣 | Windows：`\\.\pipe\LOCAL\cc-msg-<32 位十六進位>`；其他平台為 unix socket（如 `/tmp/cc-socks…`） | Windows 實測；其他平台為程式觀察 |
| 金鑰檔 | `~/.claude/sessions/<pid>.<SHA-256(收件匣路徑轉小寫)>.key`，內容 `{ peerToken, procStartFt, pidDomain }` | 實測（21 個真實金鑰檔全部符合此規則） |
| 傳輸格式 | 每行一個 JSON（NDJSON） | 實測 |
| 驗證 | 連線後第一行必須是 `{"type":"auth","token":<收件人的 peerToken>}` | 實測 |
| 金鑰錯誤 | 收件端立即斷線（約 15 ms），之後的訊息都不會處理 | 實測 |
| 首行期限 | 連上後完全不送資料，約 **30 秒** 被斷線 | 實測（30014 ms） |
| 找不到金鑰時 | Claude 寄件端仍會送出訊息，但不帶驗證行 | 實測 |
| 格式錯誤的行 | 驗證後出現無法解析的行會被略過，連線保持，後續合法訊框照常處理 | 實測 |
| 身分判定 | 收件端以「連線程序的 PID」（從連線本身取得）對照註冊表判定寄件人；訊框裡的 `from` 只用於決定回覆位址 | 程式觀察；與實測行為一致（Agent Deck 送出的訊息被顯示為 `agent-deck`） |

## 3. 訊框

### 3.1 `user`：送進對方輸入佇列的訊息（實測）

```
{ "msgV": 1, "msg_id": "<uuid>", "type": "user", "priority": "next",
  "from": "uds:<寄件人收件匣路徑>",
  "message": { "role": "user",
    "content": "<cross-session-message from=\"uds:…\" from-name=\"<名稱>\" from-mode=\"<權限模式>\">\n<內文>\n</cross-session-message>" } }
```

- `from` 是寄件人自己的收件匣位址，收件人用它回覆與送回執。
- 封套屬性另有 `from-session`、`hop-chain`、`from-plugin`（程式觀察）。
- `from-mode` 是寄件人宣告的權限模式；Agent Deck 不宣告（見第 4 節）。

### 3.2 `control`：控制訊框

| `action` | 用途 | 主要欄位 | 依據 |
|---|---|---|---|
| `notify_when_idle` | 請對方下次閒置（或結束）時通知一次 | `from`、`from_mode`、`msgV`、`msg_id` | 實測（Claude 送出的實際訊框） |
| `peer_idle_notice` | 閒置通知，回應上述訂閱 | `orig_msg_id`（= 訂閱的 `msg_id`）、`from` | 實測：不宣告權限模式的訂閱也會收到，且只收到 1 次 |
| `peer_message_status` | 送達回執 | `status`、`reason`、`orig_msg_id`、`from` | 實測 `held`、`denied`、`expired`、`dropped`、`delivered`；`refused` 為程式觀察（`expired` 帶 `status_detail: refused` 的變體），未能觸發 |
| `rename` | 改變收件 session 的名稱 | `name` | 實測：收件 session 註冊表的 `name` 隨即改變（Agent Deck 的收件匣不接受別人替它改名） |
| `unyield_artifact_replies`、`artifact_replies_yielded` | Artifact 相關回覆的交接 | — | 程式觀察（Agent Deck 未使用） |

`dropped` 的原因（程式觀察）：送太快（rate-limited）、轉送迴圈（hop-loop / hop-runaway）、佇列滿（queue-full）、與上一則完全相同。實測：連送兩則相同訊息，第二則收到 `dropped`；對方忙碌時連送 40 則，有 2 則收到 `dropped`（`drop_reason: rate-limited`）；對閒置 session 連送 15 則未觸發限速。`queue-full` 未能觸發：對略過權限模式的 session 同時送 60 則，全部進入「保留」而非一般佇列；對忙碌中的一般模式 session 同時送 150 則，只有 2 則因限速被丟棄，其餘都排入佇列（佇列容量超過 148 則）。一張 `dropped` 回執可用 `dropped_msg_ids` 同時列出多則被丟棄的訊息（實測）。

## 4. 收件端的處理規則

| 情況 | 結果 | 依據 |
|---|---|---|
| 收件 session 為一般權限模式 | 直接放進輸入佇列並回應；**不會**送回執 | 實測 |
| 收件 session 為「略過權限確認」模式，寄件人未宣告相同等級的權限模式 | **保留**，送回 `held` 回執（原因：permission-mode parity），畫面出現審閱框，預設選項為 Deny | 實測 |
| 使用者在審閱框選 Deny | 寄件人收到 `denied` 回執 | 實測 |
| 使用者選 Deliver | 訊息送進 Claude，被正常回應 | 實測 |
| 被保留但沒人審閱 | **300 秒**後寄件人收到 `expired` | 實測 |
| 在審閱框按 Esc 關閉 | 視同拒絕，寄件人收到 `denied` | 實測 |
| 被保留後使用者選 Deliver | 寄件人收到 `delivered`（「先前被保留的訊息已核准並放行」） | 實測 |
| 收件端設定 `crossSessionInbound: hold` | 訊息被保留；實測 7 分鐘內未過期（與上一列不同） | 實測 |
| 使用者設定 `crossSessionInbound` | `accept` / `hold`；組織與專案層級的設定可強制 `hold` | 程式觀察 |

## 5. Agent Deck 的做法

- **註冊**（`src/main/ccpeer.js`）：名稱 `agent-deck`，用自己的 PID 與真實 `procStart`，`version`／`entrypoint` 標明為 Agent Deck，`peerFeatures` 為空；結束時移除；啟動時清除先前被強制關閉而遺留的 Agent Deck 註冊（只清 `entrypoint: "agent-deck"` 且程序已不在的紀錄）。
- **收件**：驗證 `peerToken`（3 秒首行期限）；`user` 訊框轉給當初寫信給該 session 的卡片，否則交給中控；回執寫回訊息狀態。
- **寄件**（`src/main/ccmsg.js`）：照 3.1 格式，帶 Agent Deck 的回覆位址與 `from-name="agent-deck"`；**不宣告權限模式**，所以略過權限模式的 session 會照規則保留並請使用者審閱。
- **不做的事**：不冒充其他 session、不偽造 PID 或權限模式、不用「貼上終端」繞過 Claude 的保留機制。

## 6. 實測紀錄摘要

| 測試 | 結果 |
|---|---|
| Claude 內建 `ListAgents` 列出 `agent-deck` | ✔ |
| Claude 內建 `SendMessage` → Agent Deck → 中控卡片（寄件人正確顯示） | ✔ |
| Agent Deck → 略過權限模式的 session，回執 `delivered → held` 寫回訊息狀態 | ✔ |
| Agent Deck → 一般模式 Claude 卡片，回答正確；雙向往來皆走原生收件匣 | ✔ |
| 金鑰錯誤、格式錯誤的行、首行期限、收件匣不存在 | ✔（見第 2 節） |
| 被保留後使用者拒絕 → `denied` 回執 | ✔ |
| 未宣告權限模式的閒置訂閱 → 一次 `peer_idle_notice` | ✔ |
| `rename` 控制訊框改變收件 session 名稱 | ✔ |
| 重複訊息 → `dropped` 回執 | ✔ |
| 被保留後無人審閱 → 300 秒後 `expired` 回執 | ✔ |
| 一般權限模式的 worker 使用工具前先詢問，核准後經原生收件匣回覆 | ✔ |

| 被保留後核准 → `delivered` 回執 | ✔ |
| 忙碌時連送 → `dropped`（`rate-limited`） | ✔ |

**未能觸發、仍只有程式觀察的項目**：`refused` 回執、`queue-full` 丟棄、限速的確切門檻，以及 artifact 相關的兩個控制動作（`unyield_artifact_replies`、`artifact_replies_yielded`，屬於 Claude 的 artifact 功能，與 agent 傳訊無關）。Agent Deck 對回執一律記錄原始的 `status`、`status_detail`、`drop_reason`，所以這些狀態即使出現也會照實寫進訊息狀態。
