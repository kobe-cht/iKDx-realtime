/**
 * 各國市值前十大公司抓取腳本（給 Mapverse 地圖世界旗幟下方的「市值前十大」使用）
 *
 * 台灣另有 fetch-tw-top.js（證交所官方資料）。這支負責其它九個十大市值國家：
 * 中國、日本、韓國、印度、英國、德國、法國、美國、加拿大。
 *
 * 來源：Yahoo Finance quote（非官方、免費、免 API key，約延遲 15 分鐘），見 lib/yahoo-quote.js。
 * 這些國家沒有像證交所那樣一次給全市場的官方開放資料，所以用「候選名單」做法：
 *   world_top.json 列出每國約 15~20 家大型股的 Yahoo 代碼與中文名，
 *   腳本一次查全部候選，依市值（本地幣別）排序，取前 TOP_N 名。
 *
 * 輸出 public/data/world/top10.json：
 *   { generated, countries: { cn: { date, t, cur, title, top: [{ rk, s, name, cap, p, c, pct }] }, jp: …, … } }
 *   cap = 市值（兆元，本地幣別）；p / c / pct = 現價 / 漲跌 / 漲跌幅%（對前一個交易日收盤）；
 *   t = 這一國最新報價的時間（unix 秒）；date = 該時間的日期（UTC）。
 * 單一國家抓不到足夠的資料時沿用上一版的那一國，不影響其它國家；內容與上一版相同不重寫檔案。
 */

const fs = require('fs');
const path = require('path');
const { fetchYahooQuotes } = require('./lib/yahoo-quote');

const ROOT = path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'world_top.json');
const OUT_FILE = path.join(ROOT, 'public', 'data', 'world', 'top10.json');
const TOP_N = 10;
const MIN_COUNTRIES_OK = 5; // 成功的國家少於這個數量視為來源異常，不寫入
const MAX_ABS_PCT = 50; // 單日漲跌超過這個幅度（%）視為資料異常，該檔不採用

const round = (x, d) => +x.toFixed(d);

/**
 * 把一個國家的候選名單 + Yahoo 報價整理成排行。獨立成函式方便測試。
 * 回傳 null 表示可用的候選不到 TOP_N 家。
 */
function buildCountry(cfg, quotes, topN = TOP_N) {
    const rows = [];
    for (const [s, name] of cfg.stocks) {
        const q = quotes.get(s);
        if (!q) continue;
        const cap = Number(q.marketCap);
        let p = Number(q.regularMarketPrice);
        let c = Number(q.regularMarketChange);
        const pct = Number(q.regularMarketChangePercent);
        if (!(cap > 0) || !(p > 0) || !Number.isFinite(c) || !Number.isFinite(pct) || Math.abs(pct) > MAX_ABS_PCT) continue;
        // 倫敦證交所的股價以便士（GBp / GBX）計價，但市值是英鎊；統一換成英鎊
        if (q.currency === 'GBp' || q.currency === 'GBX') {
            p /= 100;
            c /= 100;
        }
        rows.push({ s, name, cap: cap / 1e12, p, c, pct, t: Number(q.regularMarketTime) || 0 });
    }
    if (rows.length < topN) return null;
    rows.sort((a, b) => b.cap - a.cap);
    const top = rows.slice(0, topN);
    const t = Math.max(...top.map((r) => r.t));
    return {
        date: t ? new Date(t * 1000).toISOString().slice(0, 10) : '',
        t,
        cur: cfg.cur,
        title: cfg.title,
        top: top.map((r, i) => ({
            rk: i + 1,
            s: r.s,
            name: r.name,
            cap: round(r.cap, 3),
            p: round(r.p, 4),
            c: round(r.c, 4),
            pct: round(r.pct, 2),
        })),
    };
}

async function main() {
    console.log('🚀 抓取各國市值前十大 (Yahoo quote)...');
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const symbols = [...new Set(cfg.countries.flatMap((c) => c.stocks.map((x) => x[0])))];
    const quotes = await fetchYahooQuotes(symbols);
    console.log(`📥 Yahoo 回傳 ${quotes.size}/${symbols.length} 檔`);

    let prev = {};
    try {
        prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8')).countries || {};
    } catch {
        /* 第一次執行 */
    }

    const countries = {};
    let ok = 0;
    for (const c of cfg.countries) {
        const built = buildCountry(c, quotes);
        if (built) {
            countries[c.k] = built;
            ok++;
            console.log(`✓ ${c.k} ${built.top.slice(0, 3).map((t) => t.name).join('、')}…（${built.top[0].cap} 兆${c.cur}）`);
        } else {
            const got = c.stocks.filter(([s]) => quotes.has(s)).length;
            console.warn(`⚠ ${c.k} 只有 ${got}/${c.stocks.length} 檔有可用報價，${prev[c.k] ? '沿用上一版' : '這一版沒有這個國家'}`);
            if (prev[c.k]) countries[c.k] = prev[c.k];
        }
    }
    if (ok < MIN_COUNTRIES_OK) throw new Error(`只有 ${ok} 個國家抓到資料，來源可能異常，不寫入`);

    if (JSON.stringify(prev) === JSON.stringify(countries)) {
        console.log('⏭ 排行沒有變動，不更新檔案');
        return;
    }
    const out = { generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), countries };
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(out), 'utf-8');
    console.log(`💾 已寫入 ${path.relative(ROOT, OUT_FILE)}（${Object.keys(countries).length} 個國家）`);
    if (ok < cfg.countries.length) process.exitCode = 1; // 有國家沒更新：檔案照寫，但讓 workflow 回報警示
}

if (require.main === module) {
    main().catch((e) => {
        console.error('❌ 各國市值前十大抓取失敗:', e.message);
        process.exit(1);
    });
}

module.exports = { buildCountry };
