/**
 * 世界行情的資料來源集合（給 Mapverse 地圖世界使用）。
 *
 * 每個來源都回傳統一格式的報價，抓不到回傳 null 或丟出錯誤：
 *   { p: 現價, c: 漲跌, pct: 漲跌幅%, prev: 前收, t: 報價時間(unix 秒), spark: 近幾日收盤 }
 *
 * 來源（world_markets.json 每個項目的 sources 依序嘗試，前一個失敗才換下一個）：
 *   yahoo   Yahoo Finance chart（非官方、免費，約延遲 15 分鐘），能拿到近幾日收盤畫迷你走勢
 *   cnbc    CNBC 報價介面：各國指數、期貨、匯率、公債殖利率（code 是 CNBC 代碼）
 *   tpex    櫃買指數，櫃買中心官方 OpenAPI（日資料）
 *   twse    加權指數，證交所 mis（盤中即時）
 *   te      Trading Economics 頁面摘要（台灣 10 年公債殖利率；網頁改版會失敗）
 *   local   本專案其它腳本已寫入的 public/data/<code>/realtime.json（TAIEX、SP500、SOX），不需再連網
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DATA_DIR = path.join(__dirname, '..', '..', 'public', 'data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 轉數字：去掉千分位、% 與正號；不是有限數字回傳 null
function num(x) {
    if (x == null) return null;
    const n = Number(String(x).replace(/[,%+]/g, '').trim());
    return Number.isFinite(n) ? n : null;
}

function makeQuote(price, change, t, spark) {
    if (!Number.isFinite(price) || !Number.isFinite(change)) return null;
    const prev = price - change;
    if (!prev || !Number.isFinite(prev)) return null;
    return {
        p: +price.toFixed(4),
        c: +change.toFixed(4),
        pct: +((change / prev) * 100).toFixed(3),
        prev: +prev.toFixed(4),
        t: Math.floor(t),
        spark: spark && spark.length > 1 ? spark : [+prev.toFixed(4), +price.toFixed(4)],
    };
}

// 404 這類「確定不存在」的錯誤不用重試
class PermanentError extends Error {}

async function withRetry(fn, tries = 3, baseDelay = 1200) {
    let last;
    for (let i = 0; i < tries; i++) {
        try {
            return await fn(i);
        } catch (e) {
            last = e;
            if (e instanceof PermanentError || i === tries - 1) break;
            await sleep(baseDelay * (i + 1) + (/429/.test(e.message) ? 3000 * (i + 1) : 0));
        }
    }
    throw last;
}

async function httpGet(url, { headers = {}, json = true } = {}) {
    try {
        const res = await axios.get(url, {
            timeout: 20000,
            headers: { 'User-Agent': UA, Accept: json ? 'application/json' : 'text/html', ...headers },
            responseType: json ? 'json' : 'text',
            transformResponse: json ? undefined : (d) => d,
            // 本機在 HTTP proxy 後面時，axios 自己的 proxy 處理會被擋（400）；
            // 設 NODE_USE_ENV_PROXY=1（Node 24+）改由 Node 內建處理。GitHub Actions 沒有 proxy，不受影響
            ...(process.env.NODE_USE_ENV_PROXY ? { proxy: false } : {}),
        });
        return res.data;
    } catch (e) {
        const status = e.response?.status;
        if (status === 404) throw new PermanentError(`HTTP 404 ${url}`);
        throw new Error(status ? `HTTP ${status}` : e.message);
    }
}

/* ---------- Yahoo ---------- */

function parseChart(data) {
    const res = data?.chart?.result?.[0];
    if (!res) return null;
    const meta = res.meta || {};
    const ts = res.timestamp || [];
    const closes = res.indicators?.quote?.[0]?.close || [];
    const pairs = [];
    ts.forEach((t, i) => {
        if (typeof closes[i] === 'number') pairs.push([t, closes[i]]);
    });
    let price = meta.regularMarketPrice;
    if (typeof price !== 'number' && pairs.length) price = pairs[pairs.length - 1][1];
    if (typeof price !== 'number') return null;
    // 前一個交易日收盤：倒數第二根日 K（最後一根是今天，盤中會隨價格變動）
    const prev = pairs.length >= 2 ? pairs[pairs.length - 2][1] : (meta.chartPreviousClose ?? meta.previousClose);
    if (typeof prev !== 'number' || !prev) return null;
    const t = meta.regularMarketTime || (pairs.length ? pairs[pairs.length - 1][0] : Date.now() / 1000);
    const spark = pairs.slice(-6).map(([, c]) => +c.toFixed(4));
    if (spark.length) spark[spark.length - 1] = +price.toFixed(4);
    return makeQuote(price, price - prev, t, spark);
}

async function fetchYahoo(symbol) {
    return withRetry(async (i) => {
        const host = i % 2 === 0 ? 'query1' : 'query2';
        const url =
            `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
            '?range=5d&interval=1d&includePrePost=false';
        const q = parseChart(await httpGet(url));
        if (!q) throw new Error('empty result');
        return q;
    });
}

/* ---------- CNBC ---------- */

// last_time 可能是 "2026-11-03T13:20:15.000+0800" 或只有日期 "2026-11-02"（沒有時間就用現在）
function parseCnbcTime(s) {
    if (typeof s === 'string' && s.includes('T')) {
        const ms = Date.parse(s.replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
        if (Number.isFinite(ms)) return ms / 1000;
    }
    return Date.now() / 1000;
}

async function fetchCnbc(code) {
    return withRetry(async () => {
        const url =
            'https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=' +
            encodeURIComponent(code) +
            '&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1';
        const d = await httpGet(url);
        const raw = d?.FormattedQuoteResult?.FormattedQuote;
        const q = Array.isArray(raw) ? raw[0] : raw;
        const price = num(q?.last);
        if (price == null) throw new Error(`CNBC 無報價 (code=${q?.code})`);
        let change = num(q.change);
        if (change == null) {
            const prev = num(q.previous_day_closing);
            if (prev == null) throw new Error('CNBC 缺少漲跌');
            change = price - prev;
        }
        const out = makeQuote(price, change, parseCnbcTime(q.last_time));
        if (!out) throw new Error('CNBC 報價無法換算');
        return out;
    }, 2);
}

/* ---------- 櫃買指數 ---------- */

async function fetchTpex() {
    return withRetry(async () => {
        let rows = await httpGet('https://www.tpex.org.tw/openapi/v1/tpex_index');
        rows = (rows || []).filter((r) => r.Close && r.Change !== null && r.Change !== undefined && r.Change !== '');
        if (!rows.length) throw new Error('empty result');
        const last = rows[rows.length - 1];
        const d = last.Date; // YYYYMMDD，收盤時間 13:30（台灣）
        const t = Date.parse(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T13:30:00+08:00`) / 1000;
        const spark = rows.slice(-6).map((r) => +num(r.Close).toFixed(4));
        return makeQuote(num(last.Close), num(last.Change), t, spark);
    });
}

/* ---------- 證交所 mis（加權指數） ---------- */

async function fetchTwse() {
    return withRetry(async () => {
        const d = await httpGet('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0', {
            headers: { Referer: 'https://mis.twse.com.tw/stock/fibest.jsp' },
        });
        const m = d?.msgArray?.[0];
        const price = num(m?.z);
        const prev = num(m?.y);
        const date = String(m?.d || '').replace(/\D/g, '').slice(0, 8);
        if (price == null || prev == null || date.length !== 8 || !m.t) throw new Error('mis 欄位不完整（尚無成交）');
        const t = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${m.t}+08:00`) / 1000;
        return makeQuote(price, price - prev, t);
    });
}

/* ---------- Trading Economics（台灣 10 年公債殖利率） ---------- */

async function fetchTe(slug) {
    return withRetry(async () => {
        const html = await httpGet('https://tradingeconomics.com/' + slug, { json: false });
        const desc = /id="metaDesc"[^>]*content="([^"]*)"/.exec(html)?.[1];
        if (!desc) throw new Error('找不到 metaDesc（網頁改版？）');
        // 例："eased to 1.99% on October 30, 2026, marking a 0.02 percentage points decrease"
        const mp = /(?:to|at)\s+([\d.]+)%\s+on\s+(\w+ \d+, \d{4})/.exec(desc);
        if (!mp) throw new Error('無法解析殖利率摘要');
        const mc = /([\d.]+) percentage points? (increase|decrease)/.exec(desc);
        const change = mc ? Number(mc[1]) * (mc[2] === 'increase' ? 1 : -1) : 0;
        const t = Date.parse(`${mp[2]} 12:00:00 UTC`) / 1000;
        return makeQuote(Number(mp[1]), change, t);
    }, 2);
}

/* ---------- 本專案其它腳本已抓好的即時檔 ---------- */

// realtime.json 格式：[日期YYYYMMDD, 開, 高, 低, 現價, 成交量, 時間HH:MM:SS(台灣), 昨收]
async function fetchLocal(id) {
    const file = path.join(DATA_DIR, id, 'realtime.json');
    const row = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const [date, , , , price, , time, prev] = row;
    if (typeof price !== 'number' || typeof prev !== 'number' || !/^\d{8}$/.test(date)) {
        throw new Error(`${id}/realtime.json 欄位不完整`);
    }
    const t = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time || '13:30:00'}+08:00`) / 1000;
    return makeQuote(price, price - prev, t);
}

const SOURCES = {
    yahoo: fetchYahoo,
    cnbc: fetchCnbc,
    tpex: fetchTpex,
    twse: fetchTwse,
    te: fetchTe,
    local: fetchLocal,
    calc: fetchCalc,
};

/* ---------- 由其他報價換算（匯率交叉盤的備援） ---------- */

// 例如 澳幣/台幣 = 澳幣/美元 × 美元/台幣；日圓/台幣 = 美元/台幣 ÷ 美元/日圓。
// 需要 a、b 兩個代碼的報價已經抓好（ctx.quotes），所以含 calc 的項目會排在第二階段（見 needsCtx）
function fetchCalc(_code, src, ctx) {
    const a = ctx?.quotes?.[src.a];
    const b = ctx?.quotes?.[src.b];
    if (!a || !b) throw new Error(`calc 缺少 ${!a ? src.a : src.b} 的報價`);
    const op = src.op === 'div' ? (x, y) => x / y : (x, y) => x * y;
    const p = op(a.p, b.p);
    const prev = op(a.prev, b.prev);
    const spark =
        a.spark.length === b.spark.length && a.spark.length > 2
            ? a.spark.map((v, i) => +op(v, b.spark[i]).toFixed(4))
            : null;
    return makeQuote(p, p - prev, Math.min(a.t, b.t), spark);
}

const needsCtx = (item) => item.sources.some((s) => s.type === 'calc');

// 報價是否合理：價格與前收必須是正數
function isValid(q) {
    return !!q && q.p > 0 && q.prev > 0 && Number.isFinite(q.pct) && Number.isFinite(q.t);
}

/**
 * 依序嘗試 item.sources（[{ type, code }]），回傳第一個有效的報價。
 * ctx.quotes 是已經抓好的報價（calc 來源要用）。
 * @returns {Promise<{ quote: object|null, via: string|null, errors: string[] }>}
 */
async function fetchChain(item, ctx) {
    const errors = [];
    for (const src of item.sources) {
        const fn = SOURCES[src.type];
        if (!fn) {
            errors.push(`${src.type}: 未知的來源類型`);
            continue;
        }
        try {
            const quote = await fn(src.code, src, ctx);
            if (isValid(quote)) return { quote, via: src.type, errors };
            errors.push(`${src.type}: 報價無效`);
        } catch (e) {
            errors.push(`${src.type}: ${e.message}`);
        }
    }
    return { quote: null, via: null, errors };
}

module.exports = { SOURCES, fetchChain, needsCtx, parseChart, parseCnbcTime, makeQuote, isValid, num, httpGet, withRetry, sleep, PermanentError };
