/**
 * 美股即時報價抓取腳本
 *
 * 使用 Yahoo Finance v7 quote API 批次取得多檔美股即時報價，
 * 並將最新一筆資料存成一維陣列 [日期, O, H, L, 收盤(成交), V, 時間]，
 * 與台股 realtime.json 格式對齊。
 *
 * 對應儲存路徑：public/data/us/<SYMBOL>/realtime.json
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 每批抓取的股票數量（Yahoo quote API 支援 symbols 用逗號分隔批次查詢）
const BATCH_SIZE = 20;
// 每批最多重試持續時間（毫秒）
const BATCH_FETCH_TIME = 60_000;
// 重試間隔（毫秒）
const RETRY_INTERVAL = 5_000;
// 單次請求 timeout
const REQUEST_TIMEOUT = 15_000;

// User-Agent，模擬瀏覽器避免被擋
const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Yahoo Finance v7 quote API 需要 cookie + crumb 驗證，否則回傳 401。
// 快取取得的憑證，遇到 401 時再重新取得。
let cachedCrumb = null;
let cachedCookie = null;

// 取得 Yahoo Finance 的 cookie 與 crumb（驗證憑證）
async function getYahooCredentials(forceRefresh = false) {
    if (!forceRefresh && cachedCrumb && cachedCookie) {
        return { crumb: cachedCrumb, cookie: cachedCookie };
    }

    // Step 1: 取得 cookie（fc.yahoo.com 會回傳非 2xx 狀態，但會帶 Set-Cookie）
    let cookie = '';
    try {
        const cookieRes = await axios.get('https://fc.yahoo.com', {
            timeout: REQUEST_TIMEOUT,
            headers: { 'User-Agent': USER_AGENT },
            validateStatus: () => true,
        });
        const setCookie = cookieRes.headers['set-cookie'];
        if (Array.isArray(setCookie) && setCookie.length > 0) {
            cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
        }
    } catch (error) {
        console.log(`⚠ 取得 cookie 失敗: ${error.message}`);
    }

    // 後備：用 finance.yahoo.com 首頁取得 cookie
    if (!cookie) {
        try {
            const fallbackRes = await axios.get('https://finance.yahoo.com', {
                timeout: REQUEST_TIMEOUT,
                headers: { 'User-Agent': USER_AGENT },
                validateStatus: () => true,
            });
            const setCookie = fallbackRes.headers['set-cookie'];
            if (Array.isArray(setCookie) && setCookie.length > 0) {
                cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
            }
        } catch (error) {
            console.log(`⚠ 後備取得 cookie 失敗: ${error.message}`);
        }
    }

    // Step 2: 用 cookie 取得 crumb
    let crumb = '';
    try {
        const crumbRes = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
            timeout: REQUEST_TIMEOUT,
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'text/plain',
                ...(cookie ? { Cookie: cookie } : {}),
            },
        });
        crumb = typeof crumbRes.data === 'string' ? crumbRes.data.trim() : '';
    } catch (error) {
        console.log(`⚠ 取得 crumb 失敗: ${error.message}`);
    }

    cachedCookie = cookie;
    cachedCrumb = crumb;
    if (crumb) {
        console.log(`🔑 已取得 Yahoo 驗證憑證 (crumb: ${crumb.slice(0, 8)}...)`);
    } else {
        console.log('⚠ 無法取得 crumb，將嘗試不帶 crumb 請求');
    }
    return { crumb, cookie };
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
    // 路徑：public/data/us/<SYMBOL>/realtime.json
    const dirPath = path.join(__dirname, '..', 'public', 'data', 'us', stockId);
    ensureDir(dirPath);
    const filePath = path.join(dirPath, 'realtime.json');
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    console.log(`✓ ${stockId} 資料已儲存`);
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 將陣列分割成多個批次
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// 把 yahoo regularMarketTime（unix 秒）轉為 YYYYMMDD（紐約時區）
function unixToNyDateStr(unixSec) {
    if (!unixSec) return null;
    const d = new Date(Number(unixSec) * 1000);
    // 直接用 toLocaleDateString 轉成 en-CA 格式 (YYYY-MM-DD)，紐約時區
    const ymd = d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    return ymd.replace(/-/g, '');
}

// 把 yahoo regularMarketTime（unix 秒）轉為 HH:MM:SS（紐約時區）
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

// 批次抓取美股 quote
async function fetchQuoteBatch(symbols) {
    const { crumb, cookie } = await getYahooCredentials();

    const buildUrl = (c) => {
        let u = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`;
        if (c) u += `&crumb=${encodeURIComponent(c)}`;
        return u;
    };

    const doRequest = (url, ck) =>
        axios.get(url, {
            timeout: REQUEST_TIMEOUT,
            headers: {
                'User-Agent': USER_AGENT,
                Accept: 'application/json',
                ...(ck ? { Cookie: ck } : {}),
            },
        });

    try {
        const res = await doRequest(buildUrl(crumb), cookie);
        return res.data?.quoteResponse?.result || [];
    } catch (error) {
        // 401/403 代表憑證失效，重新取得 cookie + crumb 後再試一次
        const status = error.response?.status;
        if (status === 401 || status === 403) {
            console.log(`⚠ 收到 ${status}，重新取得 Yahoo 憑證後重試...`);
            const fresh = await getYahooCredentials(true);
            try {
                const res = await doRequest(buildUrl(fresh.crumb), fresh.cookie);
                return res.data?.quoteResponse?.result || [];
            } catch (retryError) {
                console.log(`⚠ 批次請求失敗（重試後）: ${retryError.message}`);
                return [];
            }
        }
        console.log(`⚠ 批次請求失敗: ${error.message}`);
        return [];
    }
}

// 重試直到所有股票都有有效成交價，或超過 BATCH_FETCH_TIME
async function fetchBatchWithRetry(stocks) {
    const symbols = stocks.map((s) => s.id);
    const startTime = Date.now();

    // 每支股票的最新 quote
    const bestDataMap = new Map();
    stocks.forEach((stock) => bestDataMap.set(stock.id, null));

    const validStockIds = new Set();
    let retryCount = 0;

    console.log(`\n📦 開始批次抓取 ${stocks.length} 支美股，最長持續 ${BATCH_FETCH_TIME / 1000} 秒...`);
    console.log(`📋 股票: ${symbols.join(', ')}`);

    while (Date.now() - startTime < BATCH_FETCH_TIME) {
        retryCount++;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`\n⏱ [${elapsed}s] 第 ${retryCount} 次抓取...`);

        const quotes = await fetchQuoteBatch(symbols);

        if (quotes.length > 0) {
            for (const q of quotes) {
                const stockId = q.symbol;
                if (!stockId) continue;

                const hasValidPrice =
                    q.regularMarketPrice !== undefined && q.regularMarketPrice !== null && !isNaN(Number(q.regularMarketPrice));

                if (hasValidPrice) {
                    bestDataMap.set(stockId, q);
                    if (!validStockIds.has(stockId)) {
                        validStockIds.add(stockId);
                        console.log(`✓ ${stockId} 取得即時報價: ${q.regularMarketPrice}`);
                    }
                } else if (!bestDataMap.get(stockId)) {
                    bestDataMap.set(stockId, q);
                }
            }
        }

        if (validStockIds.size === stocks.length) {
            console.log(`\n🎉 全部 ${stocks.length} 支美股都已取得即時報價！`);
            break;
        }

        if (Date.now() - startTime < BATCH_FETCH_TIME) {
            await delay(RETRY_INTERVAL);
        }
    }

    const finalElapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n📊 批次抓取完成（耗時 ${finalElapsed}s），有效報價: ${validStockIds.size}/${stocks.length}`);

    return bestDataMap;
}

// 處理並儲存批次資料
function processBatchData(stocks, bestDataMap) {
    for (const stock of stocks) {
        const q = bestDataMap.get(stock.id);
        if (!q) {
            console.log(`⚠ ${stock.id} 無法取得任何資料`);
            continue;
        }

        const dateStr = unixToNyDateStr(q.regularMarketTime);
        if (!dateStr) {
            console.log(`⚠ ${stock.id} 無法解析日期`);
            continue;
        }
        const timeStr = unixToNyTimeStr(q.regularMarketTime);

        // [日期, O, H, L, 收盤(現價), V, 時間]
        const newRow = [
            dateStr,
            parseValue(q.regularMarketOpen),
            parseValue(q.regularMarketDayHigh),
            parseValue(q.regularMarketDayLow),
            parseValue(q.regularMarketPrice),
            parseValue(q.regularMarketVolume),
            timeStr,
        ];

        console.log(`✓ ${stock.id} 更新即時資料: ${JSON.stringify(newRow)}`);
        saveData(stock.id, newRow);
    }
}

async function main() {
    console.log('🚀 開始抓取美股即時報價...');
    console.log(`📅 執行時間（NY）: ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}`);

    const stocks = loadStockList();
    console.log(`📋 美股總數: ${stocks.length}`);

    const batches = chunkArray(stocks, BATCH_SIZE);
    console.log(`📦 共分為 ${batches.length} 批（每批 ${BATCH_SIZE} 支）`);

    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 處理第 ${i + 1}/${batches.length} 批（${batch.length} 支股票）`);
        console.log(`${'='.repeat(60)}`);

        const bestDataMap = await fetchBatchWithRetry(batch);
        processBatchData(batch, bestDataMap);
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ 全部美股處理完成！');
    console.log(`${'='.repeat(60)}`);
}

main().catch((error) => {
    console.error('❌ 執行失敗:', error);
    process.exit(1);
});
