# iKDx-realtime

台灣股票即時股價抓取服務

## 功能

透過 GitHub Actions 自動在台灣時間每週一到週五 9:00 至 13:35 期間，每 6 分鐘抓取一次目標股票的即時股價。

## 目標股票清單

台股即時抓取的目標股票，與主專案 iKDx「有抓收盤資料」的清單一致，定義於
[`target_stock_ids.json`](target_stock_ids.json)。此檔由主專案 `src/configs/stock-ids.js`
的 `TARGET_STOCK_IDS` 同步而來，**不再於腳本內硬編白名單**。

美股清單同理，定義於 [`us_stock_list.json`](us_stock_list.json)，由主專案的
`US_STOCK_IDS` + `US_ETF_IDS` 同步而來。

抓取採「多批受控併發」：每個請求查詢 50 支、最多 3 個請求併發、啟動時加入隨機抖動錯開，
並只重試尚未取得成交價的批次，避免被 TWSE 阻擋。

## 同步白名單

主專案的白名單（`TARGET_STOCK_IDS` / `US_STOCK_IDS` / `US_ETF_IDS`）有增減時，於本機執行：

```bash
npm run sync-lists
```

腳本會讀取**同工作區相鄰的** `../iKDx/src/configs/stock-ids.js`（單一真實來源），
重新產生 `target_stock_ids.json` 與 `us_stock_list.json`，並列出新增/移除的差異。
完成後 commit & push，GitHub Actions 下次排程即套用。

> 若主專案不在相鄰資料夾，可用 `IKDX_MAIN_REPO=/path/to/iKDx npm run sync-lists` 指定路徑。

## 資料格式

資料儲存於 `public/data/{股票代號}/realtime.json`

```json
[["20251205", 1445, 1460, 1440, 1460, 20955]]
```

欄位說明：

- `[0]` 日期 (YYYYMMDD)
- `[1]` 開盤價
- `[2]` 最高價
- `[3]` 最低價
- `[4]` 收盤價/即時價
- `[5]` 成交量

## 本地測試

```bash
# 安裝依賴
npm install

# 執行抓取
npm run fetch
```

## GitHub Actions

工作流程會在以下時間自動執行：

- 台灣時間週一至週五
- 09:00 - 13:35
- 每 6 分鐘一次

也可以透過 GitHub Actions 頁面手動觸發。
