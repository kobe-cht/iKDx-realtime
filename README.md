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

## 大盤指數與 CNN 指數

與個股同一支 workflow、不同腳本，各自獨立（失敗不影響個股資料）：

| 腳本                                 | 所在 workflow                       | 輸出                                                               | 來源                        |
| ------------------------------------ | ----------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| `scripts/fetch-tw-index-realtime.js` | `fetch-realtime.yml`（台股盤中）    | `public/data/TAIEX/realtime.json`                                  | TWSE mis `tse_t00.tw`       |
| `scripts/fetch-us-index-realtime.js` | `fetch-us-realtime.yml`（美股盤中） | `public/data/SP500/realtime.json`、`public/data/SOX/realtime.json` | Yahoo chart `^GSPC`、`^SOX` |
| `scripts/fetch-cnn-realtime.js`      | 兩支 workflow 皆執行                | `public/data/global.json`                                          | CNN fear & greed            |

指數 `realtime.json` 多一個第 8 欄「昨收」（來源提供），前端用它計算漲跌點數/幅度。
`SP500`、`SOX`（費城半導體）的日期/時間為台灣時間（與主專案把美股指數當台灣時段指數處理的慣例一致）。
`global.json` 格式同主專案 `public/data/global.json`，`cnnUpdateTime` 為台灣時間。

## 世界行情（Mapverse 地圖世界）

[Mapverse](https://github.com/17Kobe/Mapverse) 的股市頁所需的資料**全部由本專案抓取**（Mapverse 自己不再有爬蟲），
輸出在 `public/data/world/`，由 Cloudflare Pages 以 `https://<本專案網域>/data/world/…` 提供（已開放 CORS）。

| 腳本                          | 輸出                              | 內容                                                                                      | 來源                                    |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| `scripts/fetch-world-quotes.js` | `public/data/world/quotes.json`   | 各國指數、商品、匯率、加密貨幣、公債殖利率（清單見 [`world_markets.json`](world_markets.json)） | Yahoo → CNBC → 證交所 / 櫃買 / 本地即時檔 |
| `scripts/fetch-tw-top.js`     | `public/data/world/tw-top.json`   | 台股市值排行前 20（收盤價 × 已發行股數）                                                  | 證交所 OpenAPI                          |

`world_markets.json` 每個代碼有一串 `sources`，**依序嘗試**，前一個失敗才換下一個（例如日經 225：Yahoo → CNBC）。
全部失敗才沿用上一版並標 `stale`；整體成功率低於一半視為來源異常，不覆蓋現有資料；
報價與上一版相同（休市期間）不重寫檔案，不會產生多餘的 commit。
可用來源類型：`yahoo`、`cnbc`、`tpex`（櫃買指數）、`twse`（加權指數即時）、`te`（Trading Economics）、
`local`（沿用上方 `TAIEX` / `SP500` / `SOX` 的 `realtime.json`，不另外連網）。細節見 [`scripts/lib/world-sources.js`](scripts/lib/world-sources.js)。

Mapverse 的 `site/markets.json` 新增代碼後，在本機執行（預設讀取相鄰的 `../Mapverse`，可用 `MAPVERSE_REPO` 指定）：

```bash
npm run sync-world            # 補上新代碼（預設 Yahoo 來源）；--prune 移除 Mapverse 已不存在的代碼
```

再視需要手動為新代碼加備援來源，然後 commit & push。

`quotes.json` 格式：`{ generated, ok, total, quotes: { <代碼>: { p 現價, c 漲跌, pct 漲跌幅%, prev 前收, t 報價時間(unix 秒), spark 近幾日收盤, stale? } } }`。
`tw-top.json` 格式：`{ generated, date, top: [{ rk, s, name, cap(兆元), p, c, pct, ind, addr }] }`。

## 本地測試

```bash
# 安裝依賴
npm install

# 執行抓取
npm run fetch
npm run fetch-world
npm run fetch-tw-top
```

> 本機在 HTTP proxy 後面時，axios 會被擋（HTTP 400）：加上環境變數 `NODE_USE_ENV_PROXY=1`（Node 24+）即可。GitHub Actions 不需要。

## GitHub Actions

工作流程由 cloudflare-cron-worker 以 `workflow_dispatch` 觸發，每 10 分鐘一次：

- 台股：台灣時間週一至週五 09:00 - 13:50
- 美股：紐約時間週一至週五 09:30 - 16:10（含收盤後 16:03 抓最終收盤價）
- 世界行情（`fetch-world-realtime.yml`）：平日（UTC）每 10 分鐘、週末每小時

也可以透過 GitHub Actions 頁面手動觸發。
