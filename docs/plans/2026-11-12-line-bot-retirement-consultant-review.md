# 新 LINE Bot 建置與舊流程退役：三輪顧問審查

日期：2026-11-12。範圍是規劃與文件修訂，未授權執行封存、刪除、實作或部署。使用者本輪稱 Lightbot，本文依上下文指既有 LINE Bot 與新的 LINE Bot harness，不另建立一項產品。

## 審查方式與證據

一位 Codex 顧問席，三輪依序審查；每輪最多五分鐘，只讀指定計劃與必要程式，不讀機密、不測試、不再派人。主代理每輪核對並整合，再交下一輪。這是同一顧問的迭代，不宣稱三位獨立顧問一致同意。

核心來源固定版本沿用 [接合分析](2026-11-12-line-agent-harness-asset-integration-analysis.md)；本輪額外讀到 Audit 固定 producer 與 Operations caller 相依。Audit 的本地 origin/main 為 f18906eca69cd05ac7d62dbef5d87e9b9d2c52f9，Operations 為 b8380d32d8859a441c885393515c5e4191ba9227；這兩者本輪未 fetch，不當成正式部署狀態。所有結果以 [第二版主計劃](2026-11-09-line-agent-harness-plan-v2.md) 的整合規範為準。

## 第一輪：舊服務封存與舊流程移除

狀態：已完成。結論：方向合理，原稿缺具名退役清單；新群組與 Presenter 成功不足以封存整個舊服務。

| 發現與反例                                                                    | 證據                                                                                                                            | 整合處置                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 只驗新群組服務就封存，會關掉 main 週報／本人資料更新與其他 helper 功能        | Bot config/profiles.json；README.md:144,180–187                                                                                 | §13.4 profile／功能停止或接手門檻；不擅自移植舊功能              |
| 移除雙碼時整段刪管理前綴，網站 collection／ACL 等仍依賴                       | Bot src/media-sync/http-routes.ts:57–530；admin-fe src/lib/media-sync-api.ts:249–278；Gateway routes/admin/80-integrations.toml | endpoint 級接手表；先改consumer，最後移除舊backend               |
| 只排空 Presenter publication，漏 manual Graph/catalog 與 save_resource worker | Bot src/media-sync/worker.ts:549,858–886；README.md:368–378；store.ts:151–154                                                   | 按pipeline及外部發布分支結清，unknown 不重跑                     |
| 新producer改source遭Audit拒收，撤舊token使outbox永久失敗                      | audit-log internal/config/config.go:38、internal/audit/catalog.go:213–219；Bot src/media-sync/store.ts:848–937                  | 新Audit契約先驗收；舊event ID/payload/provenance保留，結清後撤權 |
| webhook切換後舊綁定challenge與重送無owner，舊binary也不認新來源               | Bot src/transport/line/webhook-routes.ts:440–596；Account internal/services/line_binding_service.go:306–344                     | 舊intent取消重開、持久事件／writer交接、僅回復相容版本           |

尚未驗證：正式部署、實際consumer、queue/outbox數量、舊功能實際使用情形及資料需求。以上不可當成已具備停機條件。

## 第二輪：新流程與跨服務 API

狀態：已完成。顧問確認第一輪退役缺口已涵蓋，staged publication／metadata recovery 無須再加入通用交易框架；另提出四個需明確化的契約，均已整合。

| 發現                                  | 證據／反例                                                                 | 修正                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Admin授權revision不能選配             | §4.1與T33衝突；Account internal/services/rbac_service.go:351–378           | 所有active/admin異動同交易遞增，批准綁定必要revision                                     |
| source-access未帶當前ACL版本          | §4.2要求即時拒絕，§7.3卻無比較輸入；Asset internal/assets/types.go:496–514 | Asset持久ACL revision/CAS，帶服務端實際版本到callback，比對批准；staged/activate同樣綁定 |
| 舊資料可讀但無人處理unsend            | Bot src/media-sync/unsend.ts:19–31；worker.ts:644–662,1214–1237            | 最小lifecycle manifest與新入口接手；Graph等無owner時阻擋封存，不擴寫新Bot功能            |
| 新Audit僅有producer契約，缺交易outbox | §6.1與§13.4；Bot README:400、store.ts:848–937                              | 新業務與固定event ID outbox同交易；外部結果核對後才記success                             |

未檢查production／未跑測試，修正只代表文件契約閉合。

## 第三輪：修訂稿整體對抗驗證

狀態：已完成。顧問重讀修訂後登入／換帳號、群組註冊公告、收錄／發布、Presenter、暫停撤回與退役／回復整條路徑，文件層未發現新增實質阻擋，不代表runtime通過。

建議維持單一Bot模組化單體、API＋按需worker、PG、最小queue/outbox及共用Account/Asset/Audit/Presenter。staged/activate、CAS與fencing有明確失敗恢復用途，不再建通用工作流／分散式交易框架。新功能範圍與舊責任處置已分開；main/Graph等不擅自停用或移植。回復不會重開不相容舊writer。

一處文字歧義已修正：legacy資料的清理執行者必須是新服務或已指定且不退役的owner，不能依賴即將封存的舊Bot worker。

## 結論與尚缺證據

實際完成一席Codex、三輪，無缺席；主代理已將兩輪共九項主要發現及第三輪措辭修正整合第二版。未出現需另加服務或搬回全部舊功能的實質分歧。

正式切換前仍須驗證：

1. 每個舊profile／功能／資料停止或接手的owner與決策、回復截止。
2. Account全部管理資格mutation版本、Asset來源／ACL／staged契約、Audit producer與consumer部署版本。
3. 真實LINE provider/channel、群員資格、舊綁定取消重開、Reply unknown、重送與媒體取得窗口。
4. 來源撤回／到期、legacy manifest、兩類publication unknown、outbox結清、冷啟動、1～2群端到端與回復演練。

主計劃新增T40–T45作退役驗收；T01–T45均為計劃案例，不是本輪測試結果。只檢查文件格式、一致性及第一版雜湊，未實作、測試應用、盤點production、停機或封存。
