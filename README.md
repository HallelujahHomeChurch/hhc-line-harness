# HHC LINE Harness

獨立的新群組 LINE Bot，目前依計畫進行本機實作。已有持久化事件收錄、群組預覽／確認／單次 Reply 公告、附件保存與 staged publication、即時來源檢查、LINE 群員下載，以及撤回與到期清理。網站接續、Presenter 相容、搜尋及單 Agent 已完成本機實作；稽核、保留與還原已有本機驗證；**尚不可接管真實 webhook**。

API 與 worker 分開啟動。PostgreSQL 保存唯一工作真相；Azure Queue 僅攜帶 opaque job ID，用於喚醒 worker。原件 bytes 由 Asset 管理；source deadline 固定為 LINE 發布後 90 天。附件不掃描、不轉檔，不標成 clean；API 只支援 Reply，沒有 Push。

## 本機檢查

Node.js 26.13.1 LTS、pnpm 11.25.0。使用本任務獨立的 PostgreSQL 測試資料庫，名稱以 `_test` 結尾；測試使用各自 schema，禁止連接正式或舊 Bot DB。

```sh
pnpm install --frozen-lockfile
# 明確匯出 TEST_DATABASE_URL；整合檢查不得默默略過 DB：
REQUIRE_POSTGRES_TESTS=true pnpm test
pnpm typecheck
pnpm format:check
pnpm build
pnpm audit --prod
```

`pnpm migrate` 使用明確的 `DATABASE_URL`，交易式執行 migrations 並檢查既有 checksum。它不會開啟 runtime；API 也不會自動遷移或讀 `.env`。

## 程序與設定

`pnpm start` 預設僅啟動關閉收錄的 API：需要 `DATABASE_URL`、`LINE_CHANNEL_SECRET`，監聽 `127.0.0.1:3000`。可明確設定 `HOST=0.0.0.0` 供容器使用。`GET /healthz` 是 liveness；`GET /readyz` 是 DB／runtime readiness。合法空 webhook 回 200，未配置 runtime 的非空 webhook 回 503。

`HARNESS_ENABLED=true` 才組裝完整 runtime；還需要 [.env.example](.env.example) 列出的獨立服務設定與 Asset version-2 policy。資料庫仍預設 `closed`，必須通過外部部署與還原 gates 才能另行開啟。本次工作沒有設定正式 credential、開啟 DB 或切換 webhook。

`pnpm worker` 使用獨立 `LINE_DOWNLOAD_ACCESS_TOKEN`、Asset workload credential 與 queue managed identity，不需要 Account、Reply encryption 或 API Reply credential。每次執行最多處理 100 個喚醒、最長 10 分鐘；PG lease 決定實際工作。API 常駐負責來源 callback、互動、wake dispatcher 與到期掃描。Queue/scaler、最小副本與權限設定需另行部署驗收。

`pnpm check:asset` 只查指定 `ASSET_API_ORIGIN`／`ASSET_WORKLOAD_TOKEN` 的新 pair policy；`source_ready` 僅證明該契約相容，不表示整體 production readiness。所有外部 client 使用明確目的地；測試以替身取代 LINE、Asset 與 queue。

## 實作與交付邊界

- [順序實作計畫](docs/implementation-20261112.md)
- [持久入口與群組註冊](docs/durable-entry.md)
- [來源 worker 與存取契約](docs/source-worker.md)
- [首批歷史紀錄](docs/batch-01.md)
- [保留的五份原始計畫](docs/plans/)

原始計畫維持 byte-identical。獨立 private repository、[應用 PR #1](https://github.com/HallelujahHomeChurch/hhc-line-harness/pull/1) 與 PR CI 已建立；跨 repository 的修正與獨立顧問審查見 [審查紀錄](docs/review-rounds-20261113.md)。PR／CI 不代表 merge、release 或真實 LINE／Azure Queue／手機／付費模型驗收。合併與發布由後續協調 session 依依賴順序執行；舊 Bot 封存須等切換驗收、責任移交及 rollback 窗口結束。

搜尋、擷取、群組領取、LIFF 與對話重設契約見 [搜尋與對話](docs/search-conversations.md)。`LINE_LIFF_ID` 預設未設定；真實 LINE Console 與部署設定仍需外部驗收授權。手機頁本機驗證使用 `pnpm test:web`，測試會攔截所有外部連線。

Agent、預算、Admin 私聊及文字向量版本的設定與本機驗證邊界見 [Agent runtime](docs/agent-runtime.md)。所有模型功能預設關閉；付費模型與實際部署仍待外部驗收。

Audit delivery, status, retry/dead-letter handling and existing Monitor alert adoption: [operations](docs/operations.md). Saved group drafts are audited separately from final activation; export never counts as confirmed alert delivery.

保留、備份還原與相容交付契約見 [Recovery and release](docs/recovery-release.md)。

舊來源 manifest、單一寫入者交接及退役阻擋條件見 [Cutover and retirement](docs/cutover-retirement.md)。所有證據仍須由實際 owner 驗收，本機工具不執行 webhook 切換或外部刪除。
