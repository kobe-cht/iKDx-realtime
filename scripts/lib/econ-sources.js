/**
 * 經濟數據的資料來源集合（給 Mapverse 地圖世界的「經濟數據」主題使用）。
 *
 * 每個來源回傳統一格式：{ v 最新值, prev 前一期, unit 單位, ref 期間('YYYY-MM' | 'YYYY-Qn' | 'YYYY-MM-DD'), light? }
 * world_econ.json 每個指標的 sources 會全部嘗試，挑期間最新的那個（見 fetchEconChain）：
 *   fred      美國聖路易聯儲 FRED 的 CSV（官方統計的轉載，不用 API key）。可換算：level 原值、yoy 年增、mom 月增、diff 月差
 *   eurostat  歐盟統計局 Eurostat 的 JSON API（歐元區）
 *   te        Trading Economics 各國「指標總覽」頁的表格（最新值、前值、單位、期間），同一國家的指標共用一次請求
 *   ndc       國發會景氣對策信號（台灣景氣燈號）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { num, withRetry, httpGet } = require('./world-sources');

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// FRED 對瀏覽器的 User-Agent 會直接卡住不回應，用一般程式的 UA 才正常
const BOT_UA = 'iKDx-realtime/1.0 (+https://github.com/kobe-cht/iKDx-realtime)';

const r4 = (x) => (x == null ? null : +x.toFixed(4));

function pad2(n) {
    return String(n).padStart(2, '0');
}

// 期間換成統一的字串。period：month（預設）/ quarter / week
function normRef(dateOrMonth, period) {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(dateOrMonth);
    if (!m) return dateOrMonth;
    if (period === 'quarter') return `${m[1]}-Q${Math.floor((+m[2] - 1) / 3) + 1}`;
    if (period === 'week' && m[3]) return dateOrMonth;
    return `${m[1]}-${m[2]}`;
}

// 期間結束日（UTC 毫秒），用來判斷資料是不是太舊
function refEnd(ref) {
    let m = /^(\d{4})-Q(\d)$/.exec(ref);
    if (m) return Date.UTC(+m[1], +m[2] * 3, 0);
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ref);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    m = /^(\d{4})-(\d{2})$/.exec(ref);
    return m ? Date.UTC(+m[1], +m[2], 0) : NaN;
}

// 各種期間允許的最大資料年齡（天）。超過代表來源已經停更或抓到舊資料，視為失敗而不是當作最新值
const MAX_AGE_DAYS = { month: 130, quarter: 220, week: 45 };
const FRESHER_MS = 20 * 86400e3;

/* ---------- FRED ---------- */

// 'YYYY-MM-DD' 往前（後）推 n 個月，日固定為 01（FRED 月資料的日期都是月初）
function shiftMonth(date, n) {
    const [y, m] = date.split('-').map(Number);
    const t = y * 12 + (m - 1) + n;
    return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}-01`;
}

async function fetchFred(src) {
    return withRetry(async () => {
        const csv = await httpGet('https://fred.stlouisfed.org/graph/fredgraph.csv?id=' + encodeURIComponent(src.id), {
            json: false,
            headers: { 'User-Agent': BOT_UA, Accept: 'text/csv' },
        });
        const rows = String(csv)
            .trim()
            .split(/\r?\n/)
            .slice(1)
            .map((l) => l.split(','))
            .filter((r) => r[1] && r[1] !== '.' && Number.isFinite(Number(r[1])))
            .map(([d, v]) => [d, Number(v)]);
        const n = rows.length;
        if (n < 3) throw new Error(`FRED ${src.id} 資料不足`);
        const mode = src.mode || 'level';
        if (!['level', 'yoy', 'mom', 'diff'].includes(mode)) throw new Error('未知的 FRED mode ' + mode);
        const by = new Map(rows);
        // 用日期找對應的月份，不能數筆數：資料偶爾會缺一個月（例如 2025/10 美國政府關門沒公布），數筆數會整個錯位
        const calc = (date) => {
            const cur = by.get(date);
            if (mode === 'level') return cur;
            if (mode === 'yoy') {
                const base = by.get(shiftMonth(date, -12));
                return base == null ? NaN : (cur / base - 1) * 100;
            }
            const p = by.get(shiftMonth(date, -1));
            if (p == null) return NaN;
            return mode === 'mom' ? (cur / p - 1) * 100 : cur - p; // diff
        };
        const d1 = rows[n - 1][0];
        const v = calc(d1);
        if (!Number.isFinite(v)) throw new Error(`FRED ${src.id} 缺少 ${d1} 的比較期資料`);
        // 前一期：月資料用「上個月」的日期；週資料（level）直接取前一筆
        const prev = mode === 'level' ? rows[n - 2][1] : by.has(shiftMonth(d1, -1)) ? calc(shiftMonth(d1, -1)) : NaN;
        const scale = src.scale || 1;
        return {
            v: r4(v * scale),
            prev: Number.isFinite(prev) ? r4(prev * scale) : null,
            unit: src.unit || '',
            ref: normRef(d1, src.period),
        };
    }, 2);
}

/* ---------- Eurostat ---------- */

async function fetchEurostat(src) {
    return withRetry(async () => {
        const url = `https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/${src.dataset}?${src.query}&lastTimePeriod=4`;
        const d = await httpGet(url);
        const times = Object.entries(d?.dimension?.time?.category?.index || {}).sort((a, b) => a[1] - b[1]);
        const pts = times.map(([t, i]) => [t, d.value?.[i]]).filter(([, v]) => typeof v === 'number');
        if (!pts.length) throw new Error('Eurostat 沒有資料（查詢條件可能已改版）');
        const [t, v] = pts[pts.length - 1];
        return { v: r4(v), prev: pts.length > 1 ? r4(pts[pts.length - 2][1]) : null, unit: src.unit || '', ref: t };
    }, 2);
}

/* ---------- Trading Economics 各國指標總覽 ---------- */

const teCache = new Map(); // 國家 → Promise<Map<slug, cells>>，同一輪只請求一次

function parseTeOverview(html, country) {
    const rows = new Map();
    const re = new RegExp(
        `<tr[^>]*>\\s*<td[^>]*>\\s*<a href=['"]/${country}/([^'"]+)['"][^>]*>\\s*(.*?)\\s*</a>\\s*</td>(.*?)</tr>`,
        'gs'
    );
    for (const m of html.matchAll(re)) {
        const cells = [...m[3].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => c[1].replace(/<[^>]+>/g, '').trim());
        if (!rows.has(m[1])) rows.set(m[1], cells); // [最新值, 前值, 最高, 最低, 單位, 期間]
    }
    return rows;
}

function teCountry(country) {
    if (!teCache.has(country)) {
        const p = withRetry(async () => {
            const html = await httpGet(`https://tradingeconomics.com/${country}/indicators`, { json: false });
            const rows = parseTeOverview(String(html), country);
            if (rows.size < 20) throw new Error(`TE ${country} 總覽頁只解析到 ${rows.size} 列（網頁改版？）`);
            return rows;
        }, 3);
        p.catch(() => teCache.delete(country)); // 失敗不快取，下一個指標可以重試
        teCache.set(country, p);
    }
    return teCache.get(country);
}

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };

// 'Sep/26' → '2026-09'（季資料轉成 'YYYY-Qn'）；'Q3/26' → '2026-Q3'
function parseTeRef(s, period) {
    let m = /^Q(\d)\/(\d{2})$/.exec(s);
    if (m) return `20${m[2]}-Q${m[1]}`;
    m = /^([A-Z][a-z]{2})\/(\d{2})$/.exec(s);
    if (!m || !MONTHS[m[1]]) return null;
    return normRef(`20${m[2]}-${pad2(MONTHS[m[1]])}`, period === 'week' ? 'month' : period);
}

async function fetchTe(src) {
    const [country, slug] = src.path.split('/');
    const rows = await teCountry(country);
    const cells = rows.get(slug);
    if (!cells) throw new Error(`TE ${country} 總覽頁沒有 ${slug}`);
    const v = num(cells[0]);
    const ref = parseTeRef(cells[5] || '', src.period);
    if (v == null || !ref) throw new Error(`TE ${src.path} 欄位無法解析：${JSON.stringify(cells)}`);
    return { v, prev: num(cells[1]), unit: cells[4] || '', ref };
}

/* ---------- 國發會景氣對策信號 ---------- */

// 分數 → 燈號：9～16 藍、17～22 黃藍、23～31 綠、32～37 黃紅、38～45 紅
function lightOf(score) {
    return score <= 16 ? 'blue' : score <= 22 ? 'yellow-blue' : score <= 31 ? 'green' : score <= 37 ? 'yellow-red' : 'red';
}

// 國發會網站在 Cloudflare 後面，會依 TLS 指紋擋掉 Node 的連線（403），curl 則可以，所以這個來源改用系統的 curl。
// 需要先取首頁的 csrf-token 與 cookie，再 POST 取資料
function curl(args) {
    return new Promise((resolve, reject) => {
        execFile('curl', ['-sS', '-L', '-m', '25', '-A', BROWSER_UA, ...args], { maxBuffer: 5e6 }, (err, stdout, stderr) =>
            err ? reject(new Error(`curl 失敗：${(stderr || err.message).trim().slice(0, 120)}`)) : resolve(stdout)
        );
    });
}

async function fetchNdc() {
    const jar = path.join(os.tmpdir(), `ndc-${process.pid}-${Date.now()}.txt`);
    try {
        return await withRetry(async () => {
            const home = await curl(['-c', jar, '-b', jar, '-w', '\n__HTTP__%{http_code}', 'https://index.ndc.gov.tw/n/zh_tw']);
            const token = /csrf-token" content="([^"]+)"/.exec(home)?.[1];
            if (!token) {
                const code = /__HTTP__(\d+)\s*$/.exec(home)?.[1];
                const head = home.replace(/\s+/g, ' ').replace(/__HTTP__\d+\s*$/, '').trim().slice(0, 100);
                throw new Error(`NDC 首頁找不到 csrf-token（HTTP ${code}，被擋或網站改版）：${head}`);
            }
            const body = await curl([
                '-c', jar, '-b', jar, '-X', 'POST', '-d', '',
                '-H', `X-CSRF-TOKEN: ${token}`,
                '-H', 'X-Requested-With: XMLHttpRequest',
                '-H', 'Referer: https://index.ndc.gov.tw/n/zh_tw',
                'https://index.ndc.gov.tw/n/json/lightscore',
            ]);
            let line;
            try {
                line = JSON.parse(body)?.line;
            } catch {
                throw new Error('NDC lightscore 回傳不是 JSON');
            }
            if (!Array.isArray(line) || line.length < 2) throw new Error('NDC lightscore 沒有資料');
            const last = line[line.length - 1];
            const prev = line[line.length - 2];
            const ref = `${String(last.x).slice(0, 4)}-${String(last.x).slice(4, 6)}`;
            return { v: last.y, prev: prev.y, unit: 'score', ref, light: lightOf(last.y) };
        }, 3);
    } finally {
        fs.rm(jar, { force: true }, () => {});
    }
}

const SOURCES = { fred: fetchFred, eurostat: fetchEurostat, te: fetchTe, ndc: fetchNdc };

// 驗證：數值有限、期間可解析、資料沒有過期
function validate(item, r, now = Date.now()) {
    if (!r || !Number.isFinite(r.v)) return '數值無效';
    const end = refEnd(r.ref);
    if (!Number.isFinite(end)) return `期間無法解析：${r.ref}`;
    const age = (now - end) / 86400e3;
    const max = MAX_AGE_DAYS[item.period || 'month'];
    if (age > max) return `資料過期（${r.ref}，已 ${Math.round(age)} 天）`;
    return null;
}

/**
 * 試所有來源，挑「期間最新」的那個（同期間取排在前面的來源）。
 * 不能只取第一個成功的：不同來源更新時間不同（例如 FRED 的密大消費者信心比 Trading Economics 晚一個月）。
 * 資料過期（見 validate）的來源視為失敗。
 * @returns {Promise<{ result: object|null, via: string|null, errors: string[] }>}
 */
async function fetchEconChain(item) {
    const errors = [];
    const good = [];
    for (const src of item.sources) {
        const fn = SOURCES[src.type];
        if (!fn) {
            errors.push(`${src.type}: 未知的來源類型`);
            continue;
        }
        try {
            const r = await fn({ period: item.period, ...src });
            const bad = validate(item, r);
            if (bad) errors.push(`${src.type}: ${bad}`);
            else good.push({ r, type: src.type, end: refEnd(r.ref) });
        } catch (e) {
            errors.push(`${src.type}: ${e.message}`);
        }
    }
    if (!good.length) return { result: null, via: null, errors };
    // 後面的來源要比前面的新 20 天以上才換：不同來源的期間精細度不同（FRED 週資料有確切日期，TE 只有月份）
    const best = good.reduce((a, b) => (b.end - a.end > FRESHER_MS ? b : a));
    if (best !== good[0]) errors.push(`${good[0].type}: 資料較舊（${good[0].r.ref}），改用 ${best.type}（${best.r.ref}）`);
    const d = best.r.prev == null ? null : r4(best.r.v - best.r.prev);
    return { result: { ...best.r, d }, via: best.type, errors };
}

module.exports = { fetchEconChain, parseTeOverview, parseTeRef, lightOf, validate, refEnd, normRef, shiftMonth, SOURCES };
