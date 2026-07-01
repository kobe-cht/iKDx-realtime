/**
 * 美股即時報價抓取腳本 (Finnhub 版)
 *
 * 使用 Finnhub /quote API 逐檔取得美股即時報價，
 * 並將最新一筆資料存成一維陣列 [日期, O, H, L, 收盤(現價), V, 時間]，
 * 與台股 realtime.json 格式對齊。
 *
 * Finnhub 免費額度：60 req/min，本腳本每筆間隔 1100ms 節流，
 * 45 檔約 50 秒完成全部抓取。
 *
 * 需要環境變數：FINNHUB_TOKEN
 * 對應儲存路徑：public/data/us/<SYMBOL>/realtime.json
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ---- 設定 ----
const FINNHUB_TOKEN = process.env.FINNHUB_TOKEN;
const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const REQUEST_TIMEOUT = 10_000;
const REQUEST_INTERVAL = 1_100; // 免費 60 req/min，留 10% margin
const MAX_RETRIES = 2; // 單檔失敗最多重試 2 次 (退避 1s → 2s)

// fail-fast：沒有 token 直接結束
if (!FINNHUB_TOKEN) {
    console.error('❌ 缺少環境變數 FINNHUB_TOKEN');
    console.error('   請在 GitHub Secrets 或本機 env 設定 FINNHUB_TOKEN');
    process.exit(1);
}

// ---- 工具函式 ----

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 讀取美股清單
function loadStockList() {
    const stockListPath = path.join(__dirname, '..', 'us_stock_list.json');
    return JSON.parse(fs.readFileSync(stockListPath, 'utf-8'));
}

// 確保目錄存在
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// 儲存資料
function saveData(stockId, data) {
    const dirPath = path.join(__dirname, '..', 'public', 'data', 'us', stockId);
    ensureDir(dirPath);
    const filePath = path.join(dirPath, 'realtime.json');
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    console.log(`✓ ${stockId} 資料已儲存`);
}

// 把 unix 秒轉為 YYYYMMDD（紐約時區）
function unixToNyDateStr(unixSec) {
    if (!unixSec) return null;
    const d = new Date(Number(unixSec) * 1000);
    const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return ymd.replace(/-/g, '');
}

// 把 unix 秒轉為 HH:MM:SS（紐約時區）
function unixToNyTimeStr(unixSec) {
    if (!unixSec) return '-';
    const d = new Date(Number(unixSec) * 1000);
    return d.toLocaleTimeString('en-GB', {
        timeZone: 'America/New_York',
        hour12: false,
    });
}

function parseValue(val) {
    if (val === null || val === undefined || val === '') return '-';
    const num = Number(val);
    return isNaN(num) ? '-' : num;
}

// 將股票 symbol 轉為 Finnhub 相容格式
// Finnhub 對 BRK-B / BRK.B 都接受，這裡先試原字串；若失敗，caller 會 fallback
function toFinnhubSymbol(id) {
    return id;
}

// ---- Finnhub API ----

/**
 * 呼叫 Finnhub /quote 端點取得單檔即時報價
 * 回傳: { c, d, dp, h, l, o, pc, t } 或 null (失敗)
 * @see https://finnhub.io/docs/api/quote
 */
async function fetchQuoteOnce(symbol) {
    const url = `${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_TOKEN}`;
    const res = await axios.get(url, {
        timeout: REQUEST_TIMEOUT,
        headers: {
            Accept: 'application/json',
            'User-Agent': 'iKDx-realtime/1.0',
        },
    });
    return res.data;
}

/**
 * 帶重試的抓取。回傳 quote 物件或 null。
 */
async function fetchQuoteWithRetry(stockId) {
    // 主 symbol + fallback (BRK-B → BRK.B 這種情況)
    const candidates = [stockId];
    if (stockId.includes('-')) candidates.push(stockId.replace(/-/g, '.'));
    else if (stockId.includes('.')) candidates.push(stockId.replace(/\./g, '-'));

    for (const sym of candidates) {
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                const data = await fetchQuoteOnce(sym);
                // Finnhub 對不存在 symbol 會回 { c: 0, d: null, ... }，視為無效
                if (data && typeof data.c === 'number' && data.c > 0) {
                    return { symbol: sym, quote: data };
                }
                // c === 0 代表 symbol 無效 or 剛開始交易，換 candidate
                if (attempt === 0) {
                    console.log(`   ⚠ ${sym} 回傳無效報價 (c=${data?.c})，嘗試其他 symbol...`);
                    break; // 跳出 retry loop，嘗試下一個 candidate
                }
            } catch (err) {
                const status = err.response?.status;
                const msg = err.message || 'unknown error';

                // 429 rate limit → 較長退避
                if (status === 429) {
                    const backoff = 2_000 * (attempt + 1);
                    console.log(`   ⚠ ${sym} 429 rate limit，${backoff}ms 後重試...`);
                    await delay(backoff);
                    continue;
                }
                // 401 → token 有問題，直接放棄整支腳本
                if (status === 401) {
                    console.error(`❌ FINNHUB_TOKEN 無效或被撤銷 (401)`);
                    process.exit(1);
                }
                // 其他錯誤 → 指數退避重試
                if (attempt < MAX_RETRIES) {
                    const backoff = 1_000 * Math.pow(2, attempt);
                    console.log(`   ⚠ ${sym} 失敗 (${status || 'net'}: ${msg})，${backoff}ms 後重試...`);
                    await delay(backoff);
                } else {
                    console.log(`   ✗ ${sym} 最終失敗: ${msg}`);
                }
            }
        }
    }
    return null;
}

/**
 * 將 Finnhub quote 轉為輸出格式:
 * [日期, O, H, L, 現價, V, 時間]
 * 注意: Finnhub /quote 不提供 volume，V 填 "-"
 */
function buildRow(quote) {
    const dateStr = unixToNyDateStr(quote.t);
    const timeStr = unixToNyTimeStr(quote.t);
    return [
        dateStr,
        parseValue(quote.o),
        parseValue(quote.h),
        parseValue(quote.l),
        parseValue(quote.c),
        '-', // Finnhub /quote 不提供 volume
        timeStr,
    ];
}

// ---- 主流程 ----

async function main() {
    console.log('🚀 開始抓取美股即時報價 (Finnhub)...');
    console.log(`📅 執行時間 (NY): ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`);

    const stocks = loadStockList();
    console.log(`📋 美股總數: ${stocks.length}`);
    console.log(`⏱ 節流: 每 ${REQUEST_INTERVAL}ms 一筆，預估 ${Math.round((stocks.length * REQUEST_INTERVAL) / 1000)}s`);
    console.log('='.repeat(60));

    const startTime = Date.now();
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i];
        const prefix = `[${i + 1}/${stocks.length}]`;

        const result = await fetchQuoteWithRetry(stock.id);

        if (result) {
            const row = buildRow(result.quote);
            // 若日期解析失敗（t=0），跳過寫入
            if (!row[0]) {
                console.log(`${prefix} ⚠ ${stock.id} 無有效時間戳，跳過`);
                failCount++;
            } else {
                console.log(`${prefix} ✓ ${stock.id} 現價: ${result.quote.c} (t=${row[6]} NY, date=${row[0]})`);
                saveData(stock.id, row);
                successCount++;
            }
        } else {
            console.log(`${prefix} ✗ ${stock.id} 全部嘗試失敗`);
            failCount++;
        }

        // 節流：最後一筆不需 delay
        if (i < stocks.length - 1) {
            await delay(REQUEST_INTERVAL);
        }
    }

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log('='.repeat(60));
    console.log(`📊 完成 (耗時 ${elapsed}s)：成功 ${successCount}/${stocks.length}，失敗 ${failCount}`);

    // 全部失敗 → 退出碼 1，讓 workflow 顯示紅
    if (successCount === 0) {
        console.error('❌ 全部股票抓取失敗');
        process.exit(1);
    }
}

main().catch((error) => {
    console.error('❌ 執行失敗:', error);
    process.exit(1);
});
