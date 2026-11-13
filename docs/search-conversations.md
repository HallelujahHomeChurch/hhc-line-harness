# 搜尋、擷取與短期對話

此階段只完成本機實作及合成測試；不代表真實 LINE、手機、雲端或模型驗收。啟用仍需完整計劃的外部驗收關卡。

## 入口與權限

群組一般訊息只收錄；明確 @Bot 查詢才建立工作。回覆 Bot、裸數字及背景工作不自行通知。一次互動至多一次 Reply；查詢先回受理及領取按鈕，背景完成不 Push。可在原群組 @Bot「查看結果」列出本人的有效工作並選擇領取，避免因回覆失敗而重跑查詢；不替使用者猜選最新工作。

一般群員不需網站綁定。LIFF ID token 由後端驗證 LINE Login audience／issuer／期限，查詢前、結果交付前與內容下載皆驗目前群員、群組狀態、來源有效期限及 revision。Admin 私聊仍僅管理 metadata；不能透過網站權限讀群組內容。Gateway member routes 固定 www host、預設關閉、清除內部身分標頭、禁止重試。

設定 `LINE_LIFF_ID` 才提供 `/api/line/harness/app`。LINE Console 的 endpoint 必須指向此公開 HTTPS 路徑並啟用 `openid`；這是待授權的外部設定，不由本機測試建立。頁面只保存當頁狀態，以 Authorization 傳送 ID token，不把 token 放在連結。SDK 固定官方 2.31.1 CDN；登入／群員實機驗收仍待完成。網址中的 group/result 只是不透明參照，不具有權限。[LINE 開發文件](https://developers.line.biz/en/docs/liff/developing-liff-apps/)

## 原件與文字

原件只由 Asset 持久保存。索引 worker 先驗 Asset ETag、MIME、大小、SHA-256，再建立 0600 暫存檔，成功或失敗皆清除。文字索引失敗不使已保存原件變成不存在。

- PDF：只擷取內建文字，最多 100 頁；掃描 PDF 回報沒有可擷取文字。
- XLSX：只讀 shared/inline strings 與已儲存的 cell values，不執行公式、巨集或外部 relationship；缺少公式快取時標示不完整。
- 舊 XLS：原件可查及下載，文字擷取明確標示未支援。
- 圖片、音訊、影片及其他支援的原件：只索引 metadata／明確說明；不 OCR、轉錄或抓 URL。

固定使用 pdfjs-dist 6.5.438、fflate 0.8.3、fast-xml-parser 5.12.0。上限：25 MiB 原件、256 ZIP entries、32 worksheets、8 MiB 實際解壓 XML、64 層 XML、100,000 cells、250,000 文字字元。拒絕 DTD／自訂 entity、畸形 XML、加密或不可解析文件；失敗仍保留原件的可用狀態。

擷取子程序使用 Node 26.13.1 LTS permissions，僅讀指定暫存檔、解析程式及依賴；無憑證環境、網路、寫入、子程序、worker 或 native addon 權限，禁止字串產生程式碼。192 MiB V8 heap、8 秒 wall timeout、2 MiB combined output cap。這些是可信解析器處理不可信資料的限制，**不是能執行惡意程式的安全沙箱**；正式環境仍須採 Task 10 的容器 CPU／記憶體限制。[Node permission model](https://github.com/nodejs/node/blob/v26.13.1/doc/api/permissions.md)

## 搜尋結果與證據

NFKC 正規化、英文詞及中文字／雙字切詞，PG GIN terms candidates；原詞組與檔名提高排序。所有候選先限定群組、來源有效期限，最多 501 個候選、五筆回傳，超過上限明示不完整；不先全域搜尋再由模型過濾。可用可信 author ID、資料類型及明確 UTC 發布時間篩選，日期不冒充「適用月份」。目前群組查詢排除其自身的提問來源。

回傳名稱、作者（缺少時未知）、發布時間、到期時間、有限摘要、擷取狀態、缺漏及受保護內容入口。不存在、待索引及索引服務失敗分開表示。版本關係保留另一來源、證據來源、信心與 candidate/confirmed；不因同名或較晚時間自動合併、取代或刪除原件。引用只建立明確 quoted 關係，不猜測相鄰訊息是附件說明。模型候選建立屬 Task 9。

30 案合成評估只衡量這份小型中英文 corpus 的本機 top-5 retrieval，不代表真實群組語意搜尋品質。付費 embedding／Agent 驗收另列。

## 對話、結果與資料異動

checkpoint 以 requester＋群組＋generation 綁定加密，最多 32 KiB／50 個來源依賴。對話閒置 30 分鐘失效；工作存取及保存重新檢查 runtime/conversation generation、來源與租約。已完成結果保留 24 小時，讀取不延長；對話閒置不刪仍有效的結果，重新授權後可領取。主動重設交易式取消未送出的互動、按鈕、結果與 checkpoint，不刪共用原件。已保留的外部 Reply 嘗試不可保證撤銷且不重送。

引用目標附件後 @Bot「補充說明 …」或「刪除此資料」，由原作者或目前已綁定的網站 global Admin 預覽／確認。預覽綁定完整新文字、來源／說明 revision、群組／對話 generation、Admin 與 binding revision；5 分鐘、同人同群組一次確認。原文與原期限不被說明覆寫；刪除走共同 tombstone、來源失效、Asset／publication cleanup。新增來源異動的外部 Audit producer 接合由 Task 10 完成。

## 本機驗證

使用 `.node-version` 指定的 Node 執行 `REQUIRE_POSTGRES_TESTS=true pnpm test`，另跑 `pnpm typecheck`、`pnpm format:check`、`pnpm build`、`pnpm test:web`。首次瀏覽器測試安裝 `pnpm exec playwright install chromium --only-shell`。瀏覽器測試全數攔截外部連線及 SDK，只用合成身分；測試資料庫必須是 loopback 的 `*_test`，每個案例使用獨立 schema。
