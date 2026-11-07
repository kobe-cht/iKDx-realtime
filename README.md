# iKDx-realtime

台灣股票即時股價抓取服務

## 功能

透過 GitHub Actions 在台灣時間每週一到週五 9:00 至 13:50 期間抓取目標股票的即時股價。工作流程由專案外部的 cloudflare-cron-worker 約每 10 分鐘觸發一次（排程設定在 worker，不在本專案；見下方「GitHub Actions」）。

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

## 世界行情（Mapverse 環遊股村）

[Mapverse](https://github.com/17Kobe/Mapverse)（環遊股村）的股市頁所需的資料**全部由本專案抓取**（Mapverse 自己不再有爬蟲），
輸出在 `public/data/world/`，由 Cloudflare Pages 以 `https://<本專案網域>/data/world/…` 提供（已開放 CORS）。

| 腳本                          | 輸出                              | 內容                                                                                      | 來源                                    |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------- |
| `scripts/fetch-world-quotes.js` | `public/data/world/quotes.json`   | 各國指數、商品、匯率、加密貨幣、公債殖利率（清單見 [`world_markets.json`](world_markets.json)） | Yahoo → CNBC → 證交所 / 櫃買 / 本地即時檔 |
| `scripts/fetch-tw-top.js`     | `public/data/world/tw-top.json`   | 台股市值排行前 20（收盤價 × 已發行股數）                                                  | 證交所 OpenAPI                          |
| `scripts/fetch-world-top.js`  | `public/data/world/top10.json`    | 其它十個國家 / 地區（中日韓印英德法美加港）的市值前十大公司（候選名單見 [`world_top.json`](world_top.json)） | Yahoo quote（需 crumb）                  |
| `scripts/fetch-world-econ.js` | `public/data/world/econ.json`     | 各國經濟數據：物價、就業、GDP、PMI、貿易、台灣景氣燈號、六家央行政策利率等（清單見 [`world_econ.json`](world_econ.json)） | FRED、Eurostat、Trading Economics、國發會 |
| `scripts/fetch-world-fng.js`  | `public/data/world/fng.json`      | CNN 貪婪與恐慌指數（概況卡的情緒條）；`{ generated, score 0~100, rating, updated, prev: { close, week, month, year } }`，失敗沿用上一版 | CNN dataviz API                         |

`world_markets.json` 每個代碼有一串 `sources`，**依序嘗試**，前一個失敗才換下一個（例如日經 225：Yahoo → CNBC）。
全部失敗才沿用上一版並標 `stale`；整體成功率低於一半視為來源異常，不覆蓋現有資料；
報價與上一版相同（休市期間）不重寫檔案，不會產生多餘的 commit。
可用來源類型：`yahoo`、`cnbc`、`tpex`（櫃買指數）、`twse`（加權指數即時）、`te`（Trading Economics）、
`local`（沿用上方 `TAIEX` / `SP500` / `SOX` 的 `realtime.json`，不另外連網）、
`calc`（由其他報價換算，目前用於台幣交叉盤：例如澳幣/台幣 = 澳幣/美元 × 美元/台幣，且**換算優先**，
因為 Yahoo 的交叉盤報價偶爾會有壞掉的前收盤，導致漲跌幅失真）。細節見 [`scripts/lib/world-sources.js`](scripts/lib/world-sources.js)。

### 經濟數據（econ.json）

`world_econ.json` 每個指標也有一串 `sources`，但和行情不同：**會全部嘗試，挑期間最新的那個**
（不同來源更新時間不同，例如 FRED 的密大消費者信心比 Trading Economics 晚一個月），
後面的來源要新 20 天以上才會取代前面的。其他保護：

- 資料過期檢查：月資料超過 130 天、季資料超過 220 天、週資料超過 45 天視為失敗（來源停更時不會把舊資料當最新）；
  央行政策利率（`period: "rate"`）放寬到 400 天，因為利率可以很久不變，來源標示的月份可能是上次調整的月份
- 全部來源失敗才沿用上一版並標 `stale`；整體成功率低於一半不覆蓋
- 來源類型：`fred`（美國，FRED CSV，可算年增 / 月增 / 月差；用日期找比較期，不數筆數，因為資料偶爾缺月）、
  `eurostat`（歐元區）、`te`（Trading Economics 各國「指標總覽」頁的表格，同一國家共用一次請求）、
  `ndc`（國發會景氣對策信號；網站會擋 Node 的連線，所以改用系統的 `curl`）
- 央行政策利率（`US_RATE`、`EU_RATE`、`JP_RATE`、`CN_RATE`、`TW_RATE`、`UK_RATE`）：美國用 FRED 的 `DFEDTARU`（目標上限）與 `DFEDTARL`（下限，`lowId`，輸出多一個 `lo`），
  歐洲央行用 FRED 的 `ECBMRRFR`，其餘四國用 Trading Economics 各國頁的「Interest Rate」那一列（備援：美、歐的 Trading Economics）
- 經濟數據一個月才更新一次，所以每次 workflow 只在上次抓取超過 3 小時（`ECON_MAX_AGE_MIN`，預設 180 分鐘）才真的去抓；
  手動觸發 workflow 時勾選 `force_econ`（或本機設 `FORCE=1`）可強制重抓
- 中國、日本、台灣的指標目前只有 Trading Economics 一個來源（這幾個國家沒有可免費、穩定取用的官方 API）；
  它改版或擋 IP 時，這些指標會沿用上一版，Mapverse 前端再退回 `markets.json` 內手寫的備用值
- **景氣燈號（`ndc`）在 GitHub Actions 上會被 Cloudflare 擋掉（HTTP 403，擋的是機房 IP）**，本機則可以。
  所以雲端抓不到時會沿用上一版並標 `stale`；國發會每月 27 日左右公布新燈號後，在本機執行
  `FORCE=1 npm run fetch-world-econ`，再 commit & push `public/data/world/econ.json` 即可。
  （想全自動：可以在 cloudflare-cron-worker 加一個代抓的端點，Cloudflare 對自家 Worker 的連線通常不擋，但尚未驗證。）

Mapverse 的 `site/markets.json` 新增代碼後，在本機執行（預設讀取相鄰的 `../Mapverse`，可用 `MAPVERSE_REPO` 指定）：

```bash
npm run sync-world            # 補上新代碼（預設 Yahoo 來源）；--prune 移除 Mapverse 已不存在的代碼
```

再視需要手動為新代碼加備援來源，然後 commit & push。經濟數據的指標則直接編輯 `world_econ.json`。

`quotes.json` 格式：`{ generated, ok, total, quotes: { <代碼>: { p 現價, c 漲跌, pct 漲跌幅%, prev 前收, t 報價時間(unix 秒), spark 近幾日收盤, stale? } } }`。
`tw-top.json` 格式：`{ generated, date, top: [{ rk, s, name, cap(兆元), p, c, pct, ind, addr }] }`。
`top10.json` 格式：`{ generated, countries: { <國家代碼 cn/jp/kr/in/uk/de/fr/us/ca/hk>: { date, t 最新報價時間(unix 秒), cur 幣別, title 旗幟上的分隔標題, top: [{ rk, s, name, cap(兆元，本地幣別), p, c, pct }] } } }`。

### 各國市值前十大（top10.json）

台灣有證交所的官方開放資料（全市場股數 + 收盤價），其它國家沒有等價的免費來源，所以改用「候選名單」做法：
[`world_top.json`](world_top.json) 每國列約 15~20 家大型股的 Yahoo 代碼與中文名，腳本一次用 Yahoo 的 `v7/finance/quote`
（`scripts/lib/yahoo-quote.js`，先取 cookie + crumb）查全部候選，依市值（本地幣別）排序後取前 10 名。

- 市值、現價、漲跌幅都是 Yahoo 的盤中資料（約延遲 15 分鐘）；倫敦的股價原本是便士，腳本會換成英鎊
- 候選名單要比十家多一些，排名才會隨市值變動；公司掉出前段班或新公司崛起時，編輯 `world_top.json`。同一家公司只放一個掛牌代碼，且用該國本地掛牌的代碼（市值才是同一種幣別）
- 中國只算 A 股（上交所 / 深交所）；Yahoo 對同時有 H 股的公司，市值口徑可能和各家網站略有差異
- 單一國家可用的候選不到 10 家，沿用上一版那一國並讓腳本以失敗結束（workflow 會回報，其它國家照常更新）；成功的國家少於 5 個視為來源異常，不寫入；排行與上一版相同不重寫檔案
- Yahoo 是非官方介面，crumb 偶爾被限流或改版；失敗時網頁自動不顯示那一國的公司列

`econ.json` 格式：`{ generated, ok, total, items: { <指標代碼>: { v 最新值, prev 前一期, d 變動, unit 單位, ref 期間('2026-09' | '2026-Q3' | '2026-10-24'), via 來源, light? 燈號, stale? } } }`。

## 本地測試

```bash
# 安裝依賴
npm install

# 執行抓取
npm run fetch
npm run fetch-world
npm run fetch-world-econ      # FORCE=1 略過 3 小時間隔
npm run fetch-tw-top
npm run fetch-world-top
npm run fetch-world-fng

> 本機在 HTTP proxy 後面時，axios 會被擋（HTTP 400）：加上環境變數 `NODE_USE_ENV_PROXY=1`（Node 24+）即可。GitHub Actions 不需要。

## GitHub Actions

工作流程檔裡沒有 cron；由專案外部的 cloudflare-cron-worker 以 `workflow_dispatch` 觸發，大約每 10 分鐘一次（實際頻率以 worker 的設定為準）：

- 台股：台灣時間週一至週五 09:00 - 13:50
- 美股：紐約時間週一至週五 09:30 - 16:10（含收盤後 16:03 抓最終收盤價）
- 世界行情（`fetch-world-realtime.yml`）：平日（UTC）每 10 分鐘、週末每小時

也可以透過 GitHub Actions 頁面手動觸發。
