# 第一批：契約 preflight 與獨立 API 基礎

日期：2026-11-12（Asia/Taipei）。任務由來源 chat `01a1bbd4-443a-7821-80a6-02e9f5454e78` 明確交接；本批只做本機實作／驗證，不部署、不開收錄、不改原 checkout。

新專案：`/Users/rayselfs/Projects/hhc/hhc-line-harness`，本機 Git、`codex/bootstrap-20261112`，沒有 remote。Asset worktree：`/Users/rayselfs/.codex/worktrees/line-harness-asset-contract/asset-api`，分支 `codex/line-harness-asset-contract-20261112`。工程追蹤：<https://github.com/HallelujahHomeChurch/asset-api/issues/279>。Asset 本機 commit：`0f87767569ac1dc116de01d77b8599a9fd17cb3c`（未 push）。

Planning 依 owning AGENTS 的固定 fallback revision `73ee1af2a1ff828d72421a73626f45ff4ce04a6f` 讀取。Project LIN-01／LIN-02 實際狀態均為「待驗收」；不覆寫既有 accepted scope。新工程 issue 已加入同 Project，不代表功能驗收。

## 範圍與決定

- 已實作：Asset `POST /priv/assets/upload-policy`，沿用 verified principal、精確 namespace/pair scope 與既有 registry，僅查 metadata。完整 ordinary-completion 契約 version 1 明示 scanRequired=true；不開免掃描 pair、不改 SQL／schema／reader／scanner。
- 已實作：新 Bot 可啟動 API、PG 連線 readiness、簽章與 payload 邊界、受限 Asset preflight client。非空事件一律 503，沒有 receipt/job 或任何接受成功的宣稱。
- 尚未實作：免掃描 profile/evidence/readiness、source deadline/gate、ACL CAS、staged/status/activate、Account actor/binding/admin revision、Audit producer、群組註冊、收錄、worker、搜尋、Agents SDK、預算與前端接合。
- Ruling: 本批先交付唯讀 preflight，而不把免掃描 pair 註冊為可上傳；來源 gate 與 SQL readers 尚未完成，先開 pair 會留下可存不可安全提供的半套契約。代價是本批不能完成 T21 或無模型附件垂直流程。
- Ruling: 新專案 genesis 直接在未使用同層目錄的 codex 分支建立，沒有 origin/main 可作基底；既有服務仍一律 latest-origin 隔離 worktree。代價是新 repo 尚無遠端 CI／PR，需後續核准建立遠端與公開範圍。
- Ruling: 不先生成空 worker／Agent／大量模組。PG schema 與 worker 隨下一個可測垂直功能落實；代價是 API 健康不代表能處理任何真實訊息。

## 刷新的 source baseline

以下各 repo 均在本批 fetch `origin/main`，不 pull／重設原工作區，不當成部署證明。

| Repo                                | SHA                                      |
| ----------------------------------- | ---------------------------------------- |
| asset-api                           | fd1e8086d61cd1b4c396fd07471c04474145ee88 |
| hhc-line-function-bot               | 8f9da9b3932a7b7139bdf1dc8fd5f939d2e309ed |
| account-api                         | 23ddae74a920692f2188792dd4dfb0911aaf4744 |
| account-fe                          | 02e06749b3cceb706fc744b122d95c67335600cf |
| admin-fe                            | cfe467d1c38ee76c295720c3faaea40fa4f0ba51 |
| api-gateway                         | 46a9a9a60c47aeb1218f5db4d6082326ff59e4bd |
| audit-log                           | f18906eca69cd05ac7d62dbef5d87e9b9d2c52f9 |
| operations-api                      | 167c5ea91008ea633d8133447939e79d5e4a3ffe |
| hhc-presenter（本地 hhc-client-v2） | 8f6c0a2edebe9bc33a9f38addda68c94e4cc9658 |

Operations 已比原計畫 baseline 前進，其他列出版本相同。原 Bot `docs/plans/` 未追蹤檔與 Presenter 使用者文件修改均保留。原 Bot 舊分支無對應 PR；Asset 既有 open PR 無本任務分支，未接管其他工作。

## Caller → route → owner → consumer（source 查核）

| Caller／consumer                        | 入口與 owner                                                            | 接手邊界                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 新 producer preflight（未配置正式身分） | Asset POST /priv/assets/upload-policy                                   | 本批新增；必須 workload token＋精確 scope，無 legacy fallback                  |
| 舊 Bot attachment/media workers         | Asset upload-sessions／complete／private GET／grants                    | 現有 line-attachment-v1／line-media-v1 仍掃描；不改舊 caller                   |
| CMS／Account／Presenter personal        | Asset registry 與既有 grants/download                                   | 此批 metadata 端點不修改其上傳／下載，既有全部測試仍須跑                       |
| 舊 Bot → Account                        | /priv/account/v1/line/bindings、status、finalize、authorize、subject    | routes.go 的單一 LineBotCallerAppID 未改；新 caller 並行 endpoint scope 仍待補 |
| account-fe                              | LineBindingPage 與既有登入／MFA／LINE challenge                         | 保留；本批沒有 opaque intent 接續                                              |
| admin-fe MediaSyncApi                   | /api/line/media-sync/collections 與 ACL／binding-code／items／retention | 仍由舊 Bot 接受；新來源不得沿用舊管理旁路，後續逐 method/path 接手             |
| Gateway                                 | routes/admin/80-integrations.toml、routes/www/01-line.toml              | 舊 webhook 是 profile 路徑；新本機入口尚未發布，後續改 source manifest 再生成  |
| Presenter                               | /api/assets/collections、changes、items/content、sync-receipts          | Asset reader 保留；來源期限／typed outcomes／控制同步未實作，不能切 producer   |
| 舊 Bot → Audit                          | 固定 hhc-line-function-bot source/action/owner＋token                   | 新 producer 尚未加入 catalog；管理域必須交易 outbox，不借舊身分                |
| Presenter → Operations                  | 現有 meeting-windows 查詢與 polling                                     | 保留；新 Bot 不建立 worker warmer 或聚會依賴                                   |

Evidence：Asset internal/assets/policy.go、internal/httpapi/{handler,workload_auth,asset_completion}.go；Account internal/routes/{routes,gateway_direct}.go；Admin src/lib/media-sync-api.ts；Gateway owning route manifests；Audit internal/{audit/catalog,config/config}.go；Presenter src/renderer/src/lib/sync-runtime.ts。這是所列本地 source 範圍，不是完整生產流量 consumer inventory。

## 驗證與下一批

- 新 Bot：9 個 Node tests、typecheck、format:check、build 通過。正式發布的 Fastify 5.12.7 取代最初從舊 Bot lock 選取的 5.9.0；後者 audit 發現 4 high／3 moderate，升級後 production dependency audit 為 0。
- 真實本機 HTTP＋獨立 PostgreSQL smoke：startup、readiness 200、DB 停止後 readiness 503、liveness 仍 200、缺簽章 400、合法空事件 200、非空事件 503、SIGTERM 乾淨關閉通過。Fastify 更新至 5.12.7 後再次執行編譯產物的 startup／簽章空 probe／DB-down／shutdown smoke，同樣通過。只使用 synthetic channel secret 與暫存 DB；無 production access。
- Asset：新 endpoint 的 9 個子案例已 red→green；go vet ./...、go build ./...、git diff --check 通過。OpenAPI lint 通過，72 個 warnings 與 origin/main baseline 相同。
- Asset 全套 race 測試：首輪未提供 DB，治理測試明確失敗、DB tests 跳過；第二輪暫存 DB 的名稱與時區不符 CI fixtures；確認錯誤後停止該輪並清除專屬暫存 DB，另改成含 test 的 DB 名稱及 UTC 後重新執行。最終 `go test -race -json ./... -count=1 -p=1` exit 0：1,864 個測試／子案例通過、7 個跳過、0 失敗。跳過的是 dbphase 四例（未另設 DB_PHASE_TEST_DSN）、dependencyhealth 一例（專用 DSN 未設）、governance export（未設 evidence 路徑）與 actual-low-disk（未配置小型 filesystem）；未隱藏失敗輪次。原始本機測試輸出與摘要留在 git-ignored `.artifacts/validation/`。
- 一位 fresh-context reviewer 只讀審查本批，未發現 correctness/security blocker；指出的 server.ts 格式問題已修正。Final: minor (deferred): preflight 尚無慢 headers／body-stream timeout fault-injection 測試；現有程式傳遞同一 2 秒 AbortSignal，但不能當作已測證據。

T01–T45 尚未完整執行，不將少量入口／契約單元案例視為 T01 或 T21 通過。沒有 GitHub CI／push／PR／merge、release、runtime activation、真實 LINE／雲端／付費模型或完整 consumer 流量驗收。

下一批依主計畫 §13.3 的第一、二項：將新 pair 與 source lifecycle 一起持久化，統一 SQL/HTTP reader 的 fail-closed 判定，補來源90天、撤回、ACL版本與 staged publication 的真實 PostgreSQL 競態測試；保持新 admission 不可啟用。再進入 Account 授權與群組註冊。production gate、真機、冷啟動、舊 main/helper 功能去向、Graph/catalog owner 和退役演練仍保留。
