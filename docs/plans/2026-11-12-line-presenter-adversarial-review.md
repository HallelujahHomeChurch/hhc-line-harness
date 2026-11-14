# 新 LINE Bot × Asset × Presenter：行為相容對抗分析

日期：2026-11-12。使用者要求更新三個 repository 的最新 main，保留 Presenter 原本取得 LINE 群組媒體的行為，允許新 Bot 架構優化。只分析及更新計劃；未實作／測試／部署。

## 1. 結論

前一版接合方案方向可用，但還不能稱為 Presenter 行為相容：單件失效可能被現有 client 解讀為整群撤權；只過濾列表不會讓增量同步正確得知暫停／恢復；重建 collection/item 會破壞本地識別；把取消預熱擴大到 Presenter 會取消現有聚會快速輪詢。

建議維持 Presenter→Asset 的資料集消費協定與本地同步結構，新 Bot 只更換生產端與管理流程。沿用 Asset，不重新建媒體傳輸或同步服務。補齊 source-policy 版本／變更事件、typed access outcome、穩定 ID 與期限傳遞，再切換新 producer。API 不變不等於語意相容，需有 client 相容版本。

## 2. 固定證據與方法

本輪重新執行 `git fetch origin main`，三者與上一輪 SHA 相同；未 pull 或覆寫工作區。Presenter 存在使用者文件修改，均未觸碰。

| 系統      | fetched origin/main                        |
| --------- | ------------------------------------------ |
| Bot       | `8f9da9b3932a7b7139bdf1dc8fd5f939d2e309ed` |
| Asset     | `fd1e8086d61cd1b4c396fd07471c04474145ee88` |
| Presenter | `8f6c0a2edebe9bc33a9f38addda68c94e4cc9658` |

主代理檢查 Bot intake／worker／unsend、Asset collection／ticket／cursor 與計劃；一個只讀子任務獨立從 Presenter 程式與測試找反例。以下測試路徑是既有契約證據，不表示本輪已執行。正式部署、真機、負載與新 API 的實作均未驗證。

## 3. 必須保持與刻意改變的行為

| 行為                                                           | 本輪要求                                                                           |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 群組成員貼附件，不必 @Bot，後續可在已授權 Presenter 資料集看到 | 保持；不以模型、索引完成或個人網站註冊作為收錄前提                                 |
| Presenter 用網站帳號登入、依 user／role ACL 選擇及匯入資料集   | 保持；Presenter 使用者不必是 LINE 群員或 global Admin                              |
| 同步資料夾、手動更新、增量同步、線上與 always-offline          | 保持操作與未過期來源的離線能力，不增加每次本地播放都連 Bot 的要求                  |
| 圖片、音訊／影片、PDF、PPTX 與現有 Presenter 格式處理          | 保持既有支援；既有 Electron VLC preparation 不移除。Excel 可保存找回，不新增投影器 |
| 原件被撤回、資料集權限被撤銷                                   | 繼續停止適用存取及清理相應受管資料，不波及其他項目／群組／帳號                     |
| 群組註冊與管理                                                 | 已核准改為 global Admin、group-first、取消雙碼；不是原流程完全不變                 |
| 新 LINE 來源 90 天、暫停停讀、無掃毒                           | 已核准的規劃差異，不能宣稱是既有行為；舊資料政策不無聲追溯變更                     |
| 聚會最佳化                                                     | 新 Bot worker 不預熱；Presenter 既有聚會快速輪詢與 fallback 保留                   |
| 新來源需要即時來源檢查                                         | 新增的可用性依賴，須明示與驗收；不得讓故障造成永久 unlink 或拖累非新來源           |

## 4. 對抗發現與最小修正

### F1 高：單件失效可能清掉整個同步資料夾

證據：Presenter `src/renderer/src/lib/hhc-asset-api-browser.ts:53-59` 與 `src/main/ipc/hhc-assets.ts:101-106` 將 403／404 視為 access-revoked；`hhc-line-access.ts:85-107,133-139` 會 unlink root。`__tests__/hhc-line-access.test.ts:152-182` 明確測定 item-scoped 403／404 清整個 root。

反例：群組有 A、B，A 到期。Asset 回 404，現有 Presenter 可能連 B 與資料夾一起移除。Bot callback 故障若回 404 也有同樣問題。

修正：新來源採明確版本的 error envelope／outcome，區分 item-expired／item-revoked、collection-paused、collection-access-revoked、dependency-unavailable。只確定 collection 撤權才 unlink root；單件只停該件，可恢復 pause 保留 root；依賴故障回可重試錯誤，不能回成功空集合。未授權客戶仍不得靠錯誤辨認資料存在。桌面與 browser 同時更新解析與分類。

### F2 高：只隱藏項目會讓 cursor 掠過恢復事件

證據：Asset `internal/postgres/store.go:1624-1759` 的 reset high-water／delta revision；Presenter `hhc-line-provider.ts:260-286` 只傳 items／tombstones／cursor／reset，`sync-refresh.ts:74-127,512-549` 依完整 reset barrier 及明確刪除合併。

反例：項目發布 revision=10，暫停時被過濾，client cursor 到 20；恢復沒有新媒體也沒有新 revision，該項目不會再次出現。全量空結果也可能被當成刪除全部。

修正：沿用新 Bot 既有交易 outbox，投遞 source/publication policy 版本到 Asset 的有限生命週期操作，讓 Asset 產生可續接 changes 或明確 reset generation。這是同步投影，不是第二份可獨立授權的群組政策；讀取仍用即時來源 gate 防止事件延遲放行。pause 是可恢復 scope state，resume 重新提供有效項目，刪除／到期才產生永久 tombstone。revision 僅單調增加，舊事件不能覆蓋新政策；在多頁 reset 期間政策變動須取消該次快照並合法重啟，不提交半頁清理。

### F3 高：離線播放不能被改成每次連 Bot

證據：`hhc-line-connect.ts:125-131,174-180` 對 available-offline 直接走本機；`sync-refresh.ts:322-327` 的 expiresAt 為 null；`src/shared/hhc-assets.ts:17-32` 沒有來源截止；native lease 位於 `src/main/ipc/native-fs.ts:17,42-56`、`hhc-assets.ts:381-391`，目前未攜帶來源 deadline。

修正：僅新 LINE policy/version 傳遞 sourceExpiresAt 至 shared parser→sync entry→受管本地播放／native lease。未過期且尚未知撤權的 always-offline 維持可用，不改 OneDrive／本機檔案。已知截止到達停止使用；收到新撤銷後清理，離線未知撤銷無法即時收回。不能把這個新增 90 天限制描述為無行為變更。

### F4 高：遷移重建 ID 會斷開既有素材引用

證據：`sync-db.ts:235-237` connection 是 `hhc-line:${AccountUserId}`；`hhc-line-connect.ts:74-75,356-365` root 包含 collection ID；`hhc-line-provider.ts:57-68` client remote key 使用 Asset **item.id**，不是後端 producer 的 remoteItemId。`sync-refresh.ts:410-415` 據此保留 local item ID。Bot `src/media-sync/worker.ts` 發布時 remoteItemId=舊 workId，sourceRevision=checksum／ETag。

修正：保留 Account ID、collection ID、Asset item ID、Asset ID／ETag 與內容 revision；不要因新 Bot 使用新 workId 就重建項目。來源識別從舊 profile/message key 轉新 channel/group/message key 時提供一次性映射，持久保留撤回／待處理／unknown publication 資訊。cursor 繼續使用原 Asset 序列；不能延續時走版本化 reset barrier，不讓舊 cursor 被靜默當成全新集合。無法保留的映射要有明確遷移驗收，不宣稱零感切換。

### F5 中高：取消預熱可能誤刪 Presenter 聚會加速

證據：Presenter `sync-runtime.ts:21-25,324-360` 使用 idle 60 秒、active 15 秒、meeting 2 秒輪詢；Operations 查詢故障回正常節奏，相關 `__tests__/sync-runtime.test.ts` 有故障／卡住／進入時段案例。

修正：只移除新 Bot worker 的 warmer、warm queue 與 meeting dependency；保留 Presenter discovery／手動 refresh／輪詢與 fallback。不新增伺服器轉碼，不移除既有客戶端解碼／VLC preparation。量測 webhook→原件保存→資料集發布→Presenter 發現→可播放，不能只量模型 Reply 五秒。

### F6 高：來源 callback 新增 Bot 故障依賴

原 Presenter 遠端讀取主要依賴 Gateway／網站身分／Asset；提案再要求每次來源讀取查 Bot。這不是原可用性行為完全相同。

第一階段保留 fail-closed 來源 gate，因現有已核准政策要求無法確認來源時不能讀。callback 限新來源且批次有界、單次 deadline、無模型／Account Admin 檢查，Bot policy API 常駐輕量副本；來源拒絕與依賴故障分開。故障不能清本地 root、前推 cursor 或破壞已知仍有效的離線素材，亦不能卡住非 LINE／舊政策資料。

不以正向長快取冒充即時撤銷。另一種優化是把媒體存取狀態的提交權威移到 Asset，使讀取不回呼 Bot；但必須同時重設暫停、撤回與生效時點，否則非同步鏡像會留下放行窗口。此替代方案先不採用，不在本輪以效能之名默默削弱已確認政策。

### F7 高：舊資料、舊 client 與舊 writer 不能一鍵套新規則

舊 Presenter 尚不理解新期限與暫停 outcome；舊 Bot reader 明確只接受 scanned。舊資料集可能有 retention exemption、舊期限與資料集 ACL。新 profile 的 namespace 相容不代表所有 client 都已相容。

修正：先上 Asset 相容 producer，再上 Presenter reader／新 Bot，最後對已公告的新 policy 開 admission。新來源標記 policy/protocol version；未相容 client 提供更新要求而非回 404 導致移除資料夾。舊來源原規則維持，逐來源遷移需既有告知／確認，已刪不復活、期限不重算。先以既有 collection 接新事件，禁止重新匯入歷史媒體或同時雙 writer。待處理 scan／unknown publication 先交接或 drain；不能直接用「新路徑免掃毒」改寫既有紀錄。

## 5. 收斂後架構與修改邊界

```text
LINE → 新 Bot API（簽章、receipt、管理與 policy）
                  ↓ PG jobs + transactional outbox
               按需附件 worker
                  ↓ 固定不掃描 profile
               Asset 原件 → 原 collection / item / revision
                  ↑ 新來源讀取 gate + 有版本的生命週期投影
                  ↓ 既有 authenticated collection API
               Presenter 現有同步／下載／離線架構
```

- 新 Bot：獨立來源／發布 ledger、管理確認、可靠收錄與撤回；不複製 Presenter 同步引擎、不新增掃描或預熱。
- Asset：沿用 workload/profile；補不掃描契約、來源硬截止、精確 publication gate、policy changes／reset 語意、typed outcome。修改集中在來源與現有 collection 邊界，不造泛用工作流框架。
- Presenter：保留帳號、picker、同步資料夾、輪詢及現有格式準備；修改 shared API parser、錯誤分類、期限／pause state、sync refresh 與 native lease。需要相容版本，不承諾零 client 修改。
- Website：依上一份接合分析修 group-first 設定與 Admin 管理；不能讓 ACL 新增、延長期限、舊直接刪除入口繞過 source policy。

## 6. 行為相容驗收（T27–T32）

| ID               | 場景                                                                | 必須成立                                                             |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------- |
| T27 錯誤範圍     | A 到期、B 有效；item 失效／collection pause／callback 503／ACL 撤銷 | 分別只處理適用範圍；單件及暫時故障不能 unlink root                   |
| T28 增量生命週期 | 無新檔 pause→resume、多頁 reset 中停用、離線跨政策變更              | 不遺漏恢復、不前推未完成快照、不復活已過期來源                       |
| T29 本地使用     | 新來源離線跨 deadline、未過期離線、native lease／Range、OneDrive    | 新來源已知截止生效；原有效離線能力及其他來源不受影響                 |
| T30 原位切換     | 既有帳號、collection、item、cursor、bytes、引用與待處理工作         | 無重複 root、未變原件不重下載、引用可用、unknown 不重放              |
| T31 端到端時間   | 無預熱首批、突發媒體、聚會輪詢、Operations 故障                     | 原 discovery／poll fallback 保持；分段量測可用時間，不冒用 Reply SLA |
| T32 相容交付     | 舊 client／舊資料／新 profile／回復／原 Bot 其他 profile            | 舊資料政策不暗改；新語意有 reader gate；不誤封存其他仍被使用服務     |

測試涵蓋 image、audio、native video、需既有 VLC preparation 的 video、PDF、PPTX、unsupported／oversize；Excel 保存成功不表示 Presenter 可播放。舊 runbook 的 always-offline 限制仍有效。

## 7. 交付與未確定事項

先補契約與 counterexample fixtures → Asset 相容增量 → Presenter parser／錯誤／sync／期限 → 新 Bot 接既有 collection → 既有狀態遷移演練 → 1～2 群有告知試用 → 再切唯一 webhook producer。AI 問答可在原件垂直流程通過後獨立加入。

現階段可採用的是上述架構與相容約束；尚不能宣稱既有 Presenter 可直接無修改接上。延遲門檻以原路徑量測作 baseline，新路徑需列差值與可接受範圍，不能自行捏造速度數字。正式部署 SHA、實際離線／投影行為及 API fault injection 留待後續已授權驗證。

## 7. 第二輪：Account／註冊／管理至媒體同步的閉環審查

本輪主代理核對主計劃與既有 API，一個只讀子任務獨立提出文件反例並補查 Account。Account API、account-fe、admin-fe、Gateway 重新 fetch 後仍分別為 23ddae74a920692f2188792dd4dfb0911aaf4744、02e06749b3cceb706fc744b122d95c67335600cf、cfe467d1c38ee76c295720c3faaea40fa4f0ba51、46a9a9a60c47aeb1218f5db4d6082326ff59e4bd。以下是設計修正，不是 runtime 測試結果。

| 發現                        | 具體反例                                                    | 已整合的最小修正                                                                   |
| --------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| F8 批准身分不完整           | LINE 身分改綁另一位 Admin，bound/allowed 仍 true            | Account actor＋binding generation＋管理授權 revision 綁批准；換帳號／撤權作廢      |
| F9 網站與群組操作者斷裂     | 網站 Admin 不在群，由別人代按                               | 同 Account actor 回群確認；接手者新建自己的 preview；網站縮權仍可直接執行          |
| F10 新 caller 授權不完整    | 加 allowlist 仍被固定 token map／路徑擋，或整組開放多餘寫入 | credential map、private route、endpoint scope 一起交付；current-subject 另訂窄契約 |
| F11 公告與 ACL 競爭         | 預覽 revision 7，公告時已是 8                               | operation ID＋expected revision 條件提交；未知／衝突不啟用新分享                   |
| F12 資料集重用混群          | A 舊資料仍在，B 綁定改 ACL                                  | 持久唯一保留／generation；其他群有效或未知發布未解決前不可重綁                     |
| F13 暫停永久取消工作        | 已受理檔案未保存就暫停，恢復後永遠缺件                      | held 與 cancelled 分離，僅恢復有效既有批准工作                                     |
| F14 去重破壞期限            | 同檔第 0／80 天分享卻共用單一截止                           | 不跨訊息去重原件，保留同事件冪等及解析重用                                         |
| F15 發布恢復自鎖或漏 cursor | Asset 建 item 後 Bot 崩潰，讀 gate 拒絕核對                 | staged→記錄→activate；窄 metadata status 與內容讀取分離                            |
| F16 停讀也停控制同步        | 暫停後 client 收不到恢復／刪除                              | 最小控制 envelope 可達，內容仍拒絕；故障不推 cursor、不 unlink                     |
| F17 不必要的部署元件        | 為只讓 dispatcher 持 token 又建憑證代理                     | Reply／download adapter 分別配置必要 secret，無新代理服務                          |

Account 證據：internal/services/line_binding_service.go:306–338、432–441、477–501、597–619；internal/config/config.go:191–197；internal/routes/gateway_direct.go:70–111；internal/routes/routes.go:51–61。account-fe 證據：src/pages/LineBindingPage.tsx:141–160。現有簡式 authorize 只有 bound/allowed；main-only subject 不是 Presenter 當前角色查詢；網站 switch-account 只重啟 Account link intent，不能自動失效另一服務的 intent。

主計劃已在相應章節合併修正並新增 T33–T39，未只依賴本附錄。採一個管理 operation record、既有 outbox、窄 Asset staged/status 契約；不新增 Bot 角色表、跨群資料集系統、通用 saga 或憑證代理。尚不能宣稱正式環境無矛盾：版本 CAS、LINE 成員驗證、真機離線／重連與新契約仍待實作驗收。
