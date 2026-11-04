/**
 * Yahoo Finance 報價（v7 quote）：一次查很多檔，回傳市值、現價、漲跌幅等欄位。
 *
 * chart 介面（world-sources.js 的 yahoo 來源）沒有市值，quote 介面有，但需要 cookie + crumb：
 *   1. GET https://fc.yahoo.com             → 回 404，但 Set-Cookie 會給一組 cookie
 *   2. GET .../v1/test/getcrumb（帶 cookie）→ 回純文字 crumb
 *   3. GET .../v7/finance/quote?symbols=…&crumb=…（帶同一組 cookie）
 * 同一個程式執行期間共用一組 session；被拒絕（401 / 403 / 429）就換新的再試。
 * 非官方介面，偶爾限流或改版，呼叫端要能容忍失敗。
 */

const axios = require('axios');
const { withRetry } = require('./world-sources');

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// 本機在 HTTP proxy 後面時要設 NODE_USE_ENV_PROXY=1（Node 24+），原因同 world-sources.js 的 httpGet
const proxyOpt = () => (process.env.NODE_USE_ENV_PROXY ? { proxy: false } : {});

let session = null;

async function getSession(force = false) {
    if (session && !force) return session;
    const first = await axios.get('https://fc.yahoo.com', {
        timeout: 20000,
        headers: { 'User-Agent': UA },
        maxRedirects: 0,
        validateStatus: () => true,
        ...proxyOpt(),
    });
    const cookie = (first.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
    if (!cookie) throw new Error('Yahoo 沒有回傳 cookie');
    const res = await axios.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        timeout: 20000,
        headers: { 'User-Agent': UA, Cookie: cookie },
        validateStatus: () => true,
        ...proxyOpt(),
    });
    const crumb = typeof res.data === 'string' ? res.data.trim() : '';
    if (res.status !== 200 || !crumb || crumb.includes('<')) throw new Error(`getcrumb HTTP ${res.status}`);
    session = { cookie, crumb };
    return session;
}

/**
 * 查報價。symbols 是 Yahoo 代碼陣列；回傳 Map<代碼, 報價物件>（Yahoo 不認得的代碼不會出現）。
 * 欄位見 Yahoo 的 quote：marketCap、regularMarketPrice、regularMarketChange、regularMarketChangePercent、
 * regularMarketTime、currency…
 */
async function fetchYahooQuotes(symbols) {
    const list = await withRetry(
        async (i) => {
            const s = await getSession(i > 0);
            const host = i % 2 === 0 ? 'query1' : 'query2';
            const res = await axios.get(`https://${host}.finance.yahoo.com/v7/finance/quote`, {
                timeout: 30000,
                params: { symbols: symbols.join(','), crumb: s.crumb },
                headers: { 'User-Agent': UA, Cookie: s.cookie, Accept: 'application/json' },
                validateStatus: () => true,
                ...proxyOpt(),
            });
            if (res.status !== 200) {
                session = null; // 下一輪重新要 cookie 與 crumb
                throw new Error(`HTTP ${res.status}`);
            }
            const result = res.data?.quoteResponse?.result;
            if (!Array.isArray(result)) throw new Error('Yahoo quote 回傳格式不對');
            return result;
        },
        3,
        2000,
    );
    return new Map(list.map((q) => [q.symbol, q]));
}

module.exports = { fetchYahooQuotes };
