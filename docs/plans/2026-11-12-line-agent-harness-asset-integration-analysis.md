# 新 LINE Bot：Asset 重構後接合與完整流程分析

日期：2026-11-12。僅分析及計劃，未實作、部署、切換 webhook、修改雲端或呼叫付費模型。本文是[第二版](2026-11-09-line-agent-harness-plan-v2.md)的工程證據與接合明細；第一版不變。

後續已做[三系統行為相容對抗分析](2026-11-12-line-presenter-adversarial-review.md)，其 F1–F7 細化本文：不可將單件失效當成整群撤權、不能只過濾增量資料、不改既有有效離線能力或 Presenter 聚會輪詢，須保留資料集／項目 ID。兩份文件共同適用；主計劃已整合。

## 1. 結論與建議實作方式

採單一 LINE Bot、TypeScript 模組化單體，同一 repository 分 API 與按需 worker 執行。PostgreSQL 是群組政策、事件、工作、來源與索引的唯一應用真相；Account 是身分／全域 Admin 權威；Asset 是原件、上傳驗證、資料集與內容傳輸權威；Presenter 是資料集消費端。不要重新寫 Asset、不要把完整舊 Bot 搬入、不要拆更多微服務。

本輪以使用者指定的「新 LINE 附件不掃毒、不預熱」作規劃基線；這是待開發契約，不是既有能力。保留大小、格式、checksum、不可變原件、隔離解析及存取驗證，不將未掃描標成 scanned 或 clean。舊網站／其他來源掃毒不變。

依序實作：先補 Asset 必要契約與相容 reader，再做 Bot 身分／群組註冊，完成無模型附件保存與受保護下載，再接 Presenter／管理，最後加 Harness 搜尋與供應商備援。每段有獨立驗收；Agent 不負責可靠收錄、授權或確認提交。

## 2. 證據版本與限制

2026-11-12 fetch 後只讀 `origin/main`，未把使用者 checkout 切到 main。下列是 source baseline，不是正式環境 release 證明。

| Repository                          | 固定 SHA                                   |
| ----------------------------------- | ------------------------------------------ |
| asset-api                           | `fd1e8086d61cd1b4c396fd07471c04474145ee88` |
| hhc-line-function-bot               | `8f9da9b3932a7b7139bdf1dc8fd5f939d2e309ed` |
| account-api                         | `23ddae74a920692f2188792dd4dfb0911aaf4744` |
| account-fe                          | `02e06749b3cceb706fc744b122d95c67335600cf` |
| admin-fe                            | `cfe467d1c38ee76c295720c3faaea40fa4f0ba51` |
| api-gateway                         | `46a9a9a60c47aeb1218f5db4d6082326ff59e4bd` |
| hhc-presenter（本地 hhc-client-v2） | `8f6c0a2edebe9bc33a9f38addda68c94e4cc9658` |

一個只讀子任務獨立查核 Account／網站／群組註冊與管理事實；主代理核對 Asset、Bot adapter、Presenter 並整合設計。不是新增顧問驗收輪次。完整 runtime、所有第三方消費端、效能、LINE 成員 API 與真機尚未驗證。

主要證據（路徑相對各 repository，搭配上列 SHA）：

- Asset：`docs/workload-auth.md`、`internal/assets/policy.go`、`internal/httpapi/asset_completion.go`、`internal/assets/service.go`、`internal/postgres/store.go`、`docs/openapi.yaml`。
- Bot：`src/clients/asset-api.ts`、`asset-workload.ts`、`src/transport/line/public-access-commands.ts`、`webhook-routes.ts`、`src/media-sync/service.ts`、`http-routes.ts`、`store.ts`。
- Account：`internal/services/rbac_service.go`、`line_binding_service.go`、`internal/handlers/internal_permission_handler.go`、`internal/routes/routes.go`、`internal/config/config.go`。
- Account FE：`src/pages/LineBindingPage.tsx`、`src/auth/auth-routes.ts`。
- Admin FE：`src/pages/MediaSyncPage.tsx`、`src/pages/media-sync/MediaLibrarySection.tsx`、`src/lib/access-control.ts`。
- Gateway：`conf.d/api/admin/80-integrations.conf`；修改時須改其 route source 再產生，不只改 generated config。
- Presenter：`src/shared/hhc-assets.ts`、`src/main/ipc/hhc-assets.ts`、`src/renderer/src/lib/hhc-asset-api-browser.ts`、`hhc-line-provider.ts`。

## 3. Asset 重構已解決與未解決事項

| 項目           | 已有能力                                                                                      | 新 Bot 的結論                                                                  |
| -------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 工作負載身分   | audience-bound RS256 verifier、精確 principal 對應 caller、可逐 caller 關閉 legacy            | 沿用；設定與正式身分尚須驗證，不以 caller header 冒充新服務                    |
| 上傳 profile   | 持久保存成對 securityProfile／processingProfile；精確 principal scope；未知／不完整 pair 拒絕 | 沿用結構，不建立任意 policy DSL                                                |
| LINE profile   | `line-attachment-v1`／`line-media-v1` 配 `no-processing-v1`，維持原 namespace 限制            | **仍要求掃毒**；no-processing 只是不做衍生處理                                 |
| readiness      | verified private GET／complete 提供 version 1，pending／ready／rejected                       | 新 adapter 讀明確版本，未知版本／狀態拒絕，不能用 legacy 欄位蓋掉新欄位        |
| safetyEvidence | scanned 或 trusted-derived                                                                    | 尚無不掃描的一般附件證據，不能借用週報 trusted-derived                         |
| owner-content  | verified CMS principal、週報 PDF／PNG、clean／ETag／owner fence                               | 排除 collection／retention media，不可直接當 LINE 下載接口                     |
| 資料集與票券   | 原件引用、增量 revision／tombstone、ACL、五分鐘票券、ETag／刪除檢查                           | 沿用；不是現成的 LINE 群組政策閘門                                             |
| 發布與下載判定 | store.go 多條 SQL 與 service 仍硬檢查 scan_status=clean                                       | 不能只新增 readiness JSON；同時補 SQL、發布、metadata、HEAD／Range、票券與清理 |
| 期限           | item.created_at + collection.retention_days；可 retentionExempt                               | 與 LINE 發布起 90 天不同；必須新增來源絕對截止，不靠排程 purge 才停讀          |

舊 Bot 的新 adapter 已支援 workload token／readiness，但刻意只接受 scanned，拒絕 trusted-derived，ready 亦需符合 legacy clean。它是需要改造的參考，不是可以原封不動複製的不掃毒 client。

## 4. 最小 Asset API／資料契約增量

以下欄位與操作名稱為提案，實作前以 OpenAPI 定稿，不表示現在已有 endpoint。

### A. 固定不掃描上傳 profile

沿用 upload-sessions／complete／GET，不另建上傳服務。新增一個明確版本的 LINE 不掃描 security profile，搭配 no-processing；仍採 restricted/private、核准 MIME 與大小。包含 PDF、Excel、圖片、音訊、影片，Presenter 不支援的格式只保存與找回。

現有 namespace 目前只能配固定舊 pair，且 LINE 新 namespace 也被限制；必須修改受驗證 principal 的允許 pair 契約。建議維持 `line.group.media-sync` 的資料集相容名稱，允許新 Bot 精確 principal 使用新增 pair，舊 caller 仍只能舊 pair。不把舊 profile 原地改成免掃描，不允許前端 `skipScan=true`。

明確持久保存「政策不要求掃描」的證據及版本，例如 not-scanned／policy-exempt（最終命名待 schema 定稿）；不能將一般上傳偽裝成 trusted-derived。readiness 的新語意採版本化相容交付，舊 reader 遇到未知值必須拒絕。Asset 後端統一政策允許提供的規則，包含 SQL 可用性篩選；不要在新 Bot 判 ready、資料集仍只允許 clean。

### B. 來源生命週期與硬截止

每件原件保存 opaque source reference、LINE publishedAt、不可延後的 sourceExpiresAt、source revision、管理模式；即使沒有 Presenter collection，也要受同一期限與撤回控制。source reference 在 Asset 不包含聊天原文／群組成員名單。

資料集項目只引用原件，不重置期限；可提供期限與生命週期 capability 給網站／Presenter。collection retention 可縮短但不可延長來源；新來源禁止 permanent／retentionExempt。所有舊管理 API 也要阻擋，不只藏按鈕。新來源在 shared service 中明確標記，由已驗證新管理路徑處理；legacy 媒體 permission 不能改其 policy 或分享授權。

期限在讀取時檢查；清除為可重試背景工作。撤銷與遲到發布比較 revision，已撤銷不能被較舊完成回覆重新公開。共享 blob 只在無有效引用時清除；管理資料集不得順便刪除他人用途。

### C. 來源授權接合：一個窄的即時檢查

建議由新 Bot 提供一個只供 Asset 驗證呼叫者使用的 bounded source-access 檢查（可批次，無原文），輸入已綁定的 source reference／Asset ID／revision 與由服務端決定的用途；Presenter 用途另外帶 Asset 已保存並核對的 collectionId/itemId 或 publication ID＋revision，並帶Asset服務端當前ACL revision，與Bot批准版本／binding generation比對；Asset在同次內容授權確認版本一致，查核這個精確發布是否仍獲授權。輸出目前來源是否有效、群組是否 active、該目的地發布是否有效及截止，不能只看 sharingEnabled。Bot 保有群組政策唯一真相；不在 Asset 再養一套獨立群組管理狀態。

Asset 針對新來源，在列表／變更清單、項目、票券簽發、兌換、HEAD／Range 和實際內容傳輸前套用同一檢查；不接受使用者任意指定 callback URL。先由 Asset 的現有 owner／ACL／已保存來源參照限縮候選，才向固定可信服務查核。不永久快取允許結果；政策查不到拒絕。避免 N+1，採有上限批次，不回傳被拒資料的檔名。換資料集後即使原件仍有效、新目的地已啟用，舊 publication 也必須拒絕，不能等待舊 item 背景清除。串流開始後已傳 bytes 無法收回，後續 Range 再查。

這個回呼只判來源，不授予 website 或 LINE 使用者權限。Bot 的群組下載先驗本人與當前群組資格；Presenter 仍由 Asset 驗網站身分與資料集 ACL。回呼直接讀 Bot PG，不再呼叫 Asset，避免循環依賴。來源拒絕與依賴故障有不同可重試語意。

現行票券兌換重驗 ACL 表，但 role IDs 是簽發快照，manager ticket 走不同權限模式；不能把它當成即時角色驗證。新來源下載需綁定已驗證請求者，role-based 存取透過供 Asset／Gateway 使用的窄 Account subject 授權查詢重新取得當前網站授權（新增接合契約，不假定已有），不能只憑可轉傳 bearer ticket 或舊 JWT 角色。優先沿用 Presenter 已有 authenticated content GET，為新來源停用未綁人的 bearer 入口；必要票券也須驗目前身分與來源。禁止拿 manager ticket 給普通群組成員。

### D. LINE 受保護原件讀取

普通群員不需要網站 Account。Bot 的查看入口驗 LINE 身分／目前成員／來源後，由窄的服務下載契約代理 Asset bytes；沿用現有受限 service grant/download 能力，grant 期限不得超過來源期限，且每次讀取套用 C。不要放寬現有 CMS owner-content 讓所有服務讀任何 owner，也不建立全域 public grant。伺服器中轉保留 ETag、Range、大小界線與 no-store，不把 Blob SAS 暴露給使用者。

### E. 服務身分與舊 owner 相容

新專案使用獨立 managed identity。初期可在受驗證映射中保留既有 LINE owner alias 以相容資料集，但真實 principal 與 audit provenance 不合併；新增 pair／來源模式只能被新 principal 操作。舊來源保留原授權，新來源拒絕 legacy 管理端繞過。若共用 alias 無法提供這個隔離，須先補來源級操作 gate，不能靠命名就宣稱隔離完成。Account 另有自己的 caller 契約，Asset verifier 通過不等於有 Account Admin 權限。

## 5. 群組註冊完整流程

1. **未啟用群組 @Bot 啟用**：簽章與可信 user/group 必須成立。有限 bootstrap 可建立短期設定 intent／回覆綁定入口，不收錄群聊、不啟動智能服務；還未確認 Admin 時不能進入可提交設定狀態。
2. **Admin 綁定**：沿用 Account 登入、MFA、LINE challenge/finalize；challenge 在一般管理 gate 前處理。驗 actual LINE user、channel、profile、nonce、expiry；完成綁定不授予 admin。網站返回接續原 intent，不再請人輸入群組 ID。
3. **私聊設定**：即時檢查 active Account 與 role admin。固定 90 天及不掃描政策，Presenter 預設關閉。可選一個未綁其他群組且無其有效／未知發布的資料集；須持久唯一保留與 binding generation，不能只先查後寫；設定／內容權限分開，私聊不列附件。已有網站資料集建立與 ACL UI 可重用。
4. **保存草稿**：intent 綁 channel、group、LINE actor、Account actor、設定 hash/revision、目標 collection、ACL revision、30 分鐘期限；不是可轉讓邀請碼。選取目的地不立即公開素材。
5. **回原群組預覽**：同一操作者、當前 Admin 與成員資格，重新核對 destination／ACL。列保存、不掃描、未來成員可查、分享對象與離線副本限制，產生 5 分鐘一次性按鈕。
6. **確認與公告**：以 operation ID 與 expected ACL revision 條件提交，版本仍一致才保留提交／Reply 嘗試；Reply 成功且確切批准版本提交後 active。公告後衝突仍不啟用。網路結果不明不自動重發或默認啟用，保持可恢復待確認，由新互動接續。外部資料集設定已部分完成時仍不可讀，不以刪掉共用資料集補償。
7. **開始收錄**：只接受啟用區間事件，不回補之前聊天或媒體。無另一次 `/registry`／`/media-sync` 綁碼。

任何階段角色移除、Bot 離群、目的資料集已刪、ACL 改變、過期，拒絕提交並明示重試／重新預覽。另一 Admin 若接手須建立自己範圍的預覽，不使用別人的按鈕。

現有 Account `/priv/account/v1/line/authorize` 可提供 admin 判斷，但管理稽核亦需可信 Account actor ID；若既有回應不提供，補窄的 verified-admin context（Account actor、binding generation、管理授權 revision），不從前端／LINE 名稱推測、不放寬原本 main-only subject 契約。維持無原文的身份資訊最小化。

## 6. 管理流程與網站防繞路

| 操作                     | 操作者／位置                           | 預覽與確認                           | 提交及跨服務效果                                                          |
| ------------------------ | -------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| 狀態／用量／失敗原因     | global Admin，私聊或既有管理頁         | 只讀不確認                           | 去敏 metadata，無聊天、原件或隱含素材讀權                                 |
| 暫停群組                 | global Admin，私聊／管理頁             | 同操作者原對話／頁面一次確認         | PG 先停收停讀；Asset source gate 即拒絕；背景同步收斂，故障不能回滾成可讀 |
| 恢復／重新加入           | global Admin 且目前群員，目標群組      | 群組預覽確認及 Reply 公告            | 只恢復有效來源，不回補、不延長                                            |
| 開啟／關閉分享、換目的地 | global Admin，私聊／網站準備，群組提交 | 展示目的地與受眾，原群組確認公告     | 新事件採新政策，舊目的地先撤銷；不自動搬歷史素材                          |
| 增加／變更可讀對象       | global Admin 管新來源，網站選對象      | 預覽完整差異，擴大受眾回群組確認公告 | 後端驗 ACL revision／當前 Admin；舊直接 addAcl 也不能跳過                 |
| 撤銷可讀對象             | global Admin，管理頁／私聊             | 預覽一次確認                         | 撤銷提交後新讀取拒絕；不等待票券自然到期                                  |
| 刪除自己的群組資料       | 發布者，原群組                         | 本人預覽確認；LINE unsend 不需確認   | 原件來源、索引、結果及 Presenter 遠端項目一起失效                         |
| Admin 刪除指定／整群     | global Admin，群組選取或不透明管理目標 | 展示範圍及影響，一次確認             | 整群停用不自動恢復；管理 metadata 不可變成私聊內容搜尋                    |
| Presenter 端移除同步連線 | 已授權 Presenter 使用者                | 沿用本地確認                         | 只移除本地連線／受管快取，不刪群組共用來源                                |
| 資料集原件管理刪除       | global Admin 新來源管理路徑            | 先分清僅停止分享或刪來源             | 禁止網站直接刪 Asset 造成 Bot 索引假存活；刪來源須回共同來源命令          |
| 保存期限／永久保留       | 新 LINE 來源固定                       | 不提供永久保留設定                   | 舊 1–365 天與 retentionExempt API 對新來源不可延後截止                    |

網站 global Admin、Presenter 資料集 reader、舊 presenter:line:manage 是不同概念。新 Bot 只認 global Admin；不要求 Presenter 的普通讀者也成為 Admin。網站內容預覽仍需其資料集讀取權，管理資格不自動等於素材讀取。

ACL 用戶清單新增時預覽「目前受眾」，若採 role ACL，需明示角色成員隨網站角色異動；內容存取重驗目前角色。沒有再建 Bot 角色／群組負責人制度。

## 7. 收錄、下載與 Presenter 流程

LINE event → PG receipt/resource/job（同交易）→ 按需 worker → LINE download → Asset upload/complete（新 pair、來源截止）→ readiness ready → PG 提交 Asset ID／ETag。後續分成原件可讀、PDF／Excel 文字索引、選擇啟用的資料集發布；任一分支失敗只重試該步。

重試沿用冪等鍵，下載完成／上傳完成／發布完成各自持久保存。Asset 端結果不明先核對同鍵與 immutable content identity，不盲目重建。來源撤回在任一步都先禁止存取；遲到成功只登記並清理。未掃描不排 scan queue，不等待簽章或掃描 worker；無新增影片轉碼／OCR。

新 Bot worker 不用 Operations 時段、warm queue、cron warmer；Presenter 既有聚會快速輪詢及 fallback 保留；工作就緒時由既有平台可用的 scaler 喚醒 worker。PG 工作表不自帶 ACA 喚醒能力。建議 API 保留一個輕量副本，內含租約保護的 outbox dispatcher，背景 worker 才縮至零；沿用一條最小 queue + transactional outbox 承載 opaque job ID，PG 仍是唯一工作真相。這不是聚會預熱，API 負責 webhook 與即時來源政策；dispatcher 故障由另一有效 API 副本／重啟續送，重送仍依 PG 去重。部署前驗證 queue/scaler 與 API 常駐成本，不再另開 warmer。不新增泛用排程服務、不讓 webhook 同步下載大檔。工作觸發、冷啟動、排隊最老時間、下載成功率須納入驗收。

Presenter 沿用 collection list／changes／content 路徑，伺服器只提供目前有效且有權的內容項目；控制同步例外僅回已驗 ACL client 的最小政策／opaque 失效 ID／cursor/reset，不含檔名或內容，避免暫停後無從得知恢復。Client 的安全增量是接收 sourceExpiresAt／暫停或撤銷狀態、控制本地受管快取、重連先驗權與同步再使用。暫停是可恢復狀態，不應被永久 tombstone 混同；刪除／到期才是不可復活 tombstone。reset／全量重同步不能恢復過期項目。沿用交易 outbox 將 source/publication revision 投影成 Asset policy changes 或 reset generation，避免只過濾列表卻前推 cursor；恢復無新檔亦可見，多頁快照遇政策變更需合法重啟。投影不代替即時來源 gate。

Presenter 現有 transport 不直接判 scanStatus，因此不重做同步引擎；但現行 403／404 會撤掉整個 root，須補 item／collection／pause／unavailable 的 typed outcome。單件到期只影響該件，依賴故障不能回空清單或 unlink root。新增欄位須同步更新 shared parser，不能只讓後端多回欄位但 client 丟棄。桌面 IPC、瀏覽器下載、native lease、離線同步各驗一次。不承諾已匯出副本即時回收；本地已知截止須即時停止使用，離線時未知新撤銷只能在收到政策後收斂。

## 8. 跨 repository 修改清單

| 系統              | 沿用                                                                             | 必改／待驗證                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset             | profile registry、workload verifier、上傳驗證、immutable bytes、資料集、增量同步 | 不掃描 pair／證據／reader 版本，發布與讀取 SQL，來源截止與 gate，grant／ticket 全路徑，legacy 管理防繞過                                                              |
| Account API       | 綁定與 admin role 查詢、MFA                                                      | 新 caller 並行 allowlist 與最小 endpoint scope、可信 Admin actor context、Asset／Gateway 所需當前 reader subject 授權；不能只改單一 LINE_BOT_CALLER_APP_ID 切斷舊 Bot |
| account-fe        | LineBindingPage 登入／切帳號／取消                                               | opaque intent 接續、明確下一步；不自動啟用群組                                                                                                                        |
| 新 Bot            | 舊簽章、去重、租約、綁定、版本確認的經驗／契約                                   | 新群組設定與政策域、來源 callback、受保護 LINE 讀取、無掃描 adapter、單 Agent                                                                                         |
| admin-fe          | 資料集建立、ACL 選取、狀態、刪除 UI                                              | global Admin-only 新來源管理、去雙碼、preview/confirm、禁永久保留、設定與素材權限分離                                                                                 |
| Gateway           | 公開簽章入口、網站驗證、private path 隔離                                        | 新 webhook／管理 backend routing、群員無 Account 入口、strip workload header、驗範圍而非轉發客戶自報身分                                                              |
| Presenter         | transport、revision/tombstone、現有下載與 cache 結構                             | source deadline／暫停／撤銷、已驗證下載、parser、native lease 及重連一致性                                                                                            |
| Operations／infra | 其他現有服務及維運管道                                                           | 新路徑無聚會相依；不刪共用 scan worker 或其他用途預熱；worker scale-to-zero 喚醒須實測                                                                                |

## 9. 交付順序、相容與驗收

1. **契約先行**：列目前消費端與 source-only 缺口，補 OpenAPI／profile／期限／授權／管理命令與錯誤碼；確定發佈後保留 90 天及不掃描告知，產出小範圍 producer 提案。
2. **Asset 相容層**：migration、舊 profile 相容、新狀態 readers、來源 mode gate；新 admission 預設關閉。測試舊 CMS、個人空間、週報、錄影仍符合原契約。
3. **身分與群組閉環**：新 caller／gateway、網站綁定接續、群組確認公告、global Admin 管理；先不啟用真實收錄。
4. **無模型垂直流程**：保存、90 天、下載、撤回、暫停、冷啟動；這段通過前不拿模型功能掩蓋入口問題。
5. **Presenter 與管理閉環**：來源 gate、ACL 變更、目的地、票券、cache、網站永久保留防繞過。
6. **Harness 與韌性**：全文／語意、PDF／Excel、模型備援／預算與長任務，沿用第二版政策。
7. **切換與試用**：先 synthetic fixtures，再有授權的 1–2 群；一次一個 LINE webhook owner。保留原 Account user ID、collection ID、Asset item ID、Asset ID／ETag 與 cursor 序列；Presenter remote key 是 Asset item.id，不是 producer workId。舊 source key 建映射，不重建原集合；若 cursor 無法延續須正式 reset 遷移。交接舊待處理工作／來源參照／刪除日誌；不雙寫、不重設期限。Asset 與消費端最低相容版本齊備後才開新 profile。

回復原則：關閉新 admission 不代表可回退到不理解新 pair／狀態的版本。新原件已存在後只回復至相容 artifact；不能把未掃描資料改成 clean，也不能回復已刪來源。舊共用 Asset／網站服務不隨舊 Bot 封存。

新增驗收（合併第二版 T01–T20）：

- T21：正確／錯誤 audience、principal／pair、legacy caller、readiness 未知或矛盾、新 evidence；新路徑零 scan dispatch，舊路徑仍掃描。
- T22：LINE publishedAt + 90 天在遲到上傳、重試、換目的地、retentionExempt、重新索引、restore 下不可延後；purge 未跑也不可讀。
- T23：同群目前成員無網站帳號可讀；Presenter 只讀資料集；群組暫停、角色撤銷、ACL 更動、manager ticket、換目的地後尚未清除的舊項目／已簽票券、HEAD／Range 及 callback 故障均符合各自政策。
- T24：未綁定 Admin、登入返回、兩群同時設定、另一 Admin、雙擊、過期、群組公告 unknown、目的地／ACL revision 改變；無第二碼、無誤啟用／誤分享。
- T25：零預熱冷啟動、第一批與突發多附件、worker crash、Asset completion unknown、晚到撤回；以實測記錄排隊與保存延遲，未準備好不能顯示成功。
- T26：網站舊 addAcl／retention／永久保留／直接刪除入口不能繞新管理；Presenter offline／重連／native lease／reset 不復活已知過期或已撤回來源。

## 10. 尚未完成的工程證據

已確認：上述 source 契約及缺口、建議責任分界、註冊／管理／媒體／同步流程、必要 API 增量。未確認：ASSET_WORKLOAD_AUTH 與 proof/profile gate 的正式開關、實際部署 SHA、所有 consumer inventory、LINE 帳號行為、1～2 群實測、冷啟動及成本、無掃描 profile 真正存在與安全隔離。沒有把 source readiness 當成 production readiness，也沒有建立或修改任何正式資源。

## 11. 本輪註冊至同步閉環補正

本節與主計劃第 4、5、6、7、13 節及 T33–T39 同步；修正前的審查結論不代表新版已通過實作驗收。

- Account API、account-fe、admin-fe、Gateway 已重新 fetch，SHA 與第二節相同。網站登入／MFA、LINE finalize、global Admin、群員與服務 caller 分別驗證；可信 Admin context 綁 actor、binding generation 與管理授權 revision，換帳號／撤權不得沿用批准。網站發起者若不能回群確認，另一 Admin 必須建立自己的預覽。
- Account 新 caller 需一起補固定 credential map、private listener 路徑與 endpoint scope；不整組開放 profile／function 寫入。Presenter current-subject 是新增的 Account-user 窄查詢，不擴用 main-only LINE subject。Account 故障拒絕需網站授權的讀取／管理，不拖累可獨立驗資格的 LINE 服務。
- ACL 變更以 operation ID＋預期 revision 條件提交；未確定公告與批准版本前不開新分享。資料集使用持久唯一群組保留，未清楚的舊發布阻擋跨群重綁，不設跨群共用協調。
- 暫停使用 held，不永久取消已受理工作；恢復續行原先批准且仍有效的保存／發布，未知結果先核對，不回補停用期間事件。
- 首版不跨訊息 binary dedup，僅同事件冪等與解析結果重用；同訊息群組／Presenter 共用原件，另行發布的期限獨立。
- 新來源發布補 staged item→producer 記錄 item ID→activate 契約。限 owner/operation 的 metadata status 不回 bytes，不以公開讀權作恢復前提；staged 不進 public cursor，activate 才發可見 revision。未來失效仍由即時來源 gate 阻擋。
- 暫停／恢復的最小控制同步與內容 gate 分離；依賴不可用不前推 cursor。API Reply adapter 和 worker 下載 adapter 各持必要憑證，不新增憑證代理服務。

驗收補充以主計劃 T33–T39 為單一清單，涵蓋切帳號、ACL 競爭、工作暫停、同檔不同期限、發布崩潰、控制同步及服務 scope；尚未執行。

## 12. 三輪退役顧問覆核後的交付邊界

完整退役矩陣、endpoint級接手、舊資料lifecycle manifest與切換順序已整合主計劃§13.4，審查過程見[三輪顧問紀錄](2026-11-12-line-bot-retirement-consultant-review.md)。管理授權revision為必需且與角色／狀態mutation同交易遞增；Asset ACL mutation採CAS並將實際版本帶入來源gate；新管理業務與中央audit outbox同交易。

新增Audit相依不可漏掉，舊outbox維持原event ID/payload/provenance，結清後才撤舊producer。舊Bot還有main週報／本人資料與manual Graph/catalog發布，不自動搬進新專案，也不能未指定停用或接手就封存。新生命周期處理者須能使已遷移舊訊息撤回／到期；其他資料若沒有owner即阻擋退役。新增T40–T45專門驗證功能去向、API移除、切換、舊資料、稽核及真正停機；尚未執行。
