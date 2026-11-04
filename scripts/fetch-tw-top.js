/**
 * 台股市值排行抓取腳本（給 Mapverse 地圖世界的「台股市值前十大」使用）
 *
 * 來源：證交所 OpenAPI（官方、免 API key）
 *   - t187ap03_L        上市公司基本資料：已發行普通股數、住址、產業別
 *   - STOCK_DAY_ALL     全部上市證券最新交易日的收盤價與漲跌
 * 市值 = 收盤價 × 已發行普通股數（單位：新台幣兆元）。
 *
 * 輸出 public/data/world/tw-top.json：
 *   { generated, date: "YYYY-MM-DD", top: [{ rk, s, name, cap, p, c, pct, ind, addr }] }
 * 只保留前 TOP_N 名（比前十大多一些，讓前端的建築在排名小幅變動時仍有資料）。
 * 內容與上一版相同（同一交易日）不重寫檔案。
 */

const fs = require('fs');
const path = require('path');
const { httpGet, withRetry, num } = require('./lib/world-sources');

const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'public', 'data', 'world', 'tw-top.json');
const BASIC_URL = 'https://openapi.twse.com.tw/v1/opendata/t187ap03_L';
const DAY_URL = 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL';
const TOP_N = 20;
const MIN_COMPANIES = 800; // 少於這個數量視為來源異常
const REALTIME_DIR = path.join(ROOT, 'public', 'data');

// 證交所「產業別」代碼
const INDUSTRY = {
    '01': '水泥工業', '02': '食品工業', '03': '塑膠工業', '04': '紡織纖維', '05': '電機機械',
    '06': '電器電纜', '08': '玻璃陶瓷', '09': '造紙工業', '10': '鋼鐵工業', '11': '橡膠工業',
    '12': '汽車工業', '14': '建材營造', '15': '航運業', '16': '觀光餐旅', '17': '金融保險',
    '18': '貿易百貨', '19': '綜合企業', '20': '其他', '21': '化學工業', '22': '生技醫療業',
    '23': '油電燃氣業', '24': '半導體業', '25': '電腦及週邊設備業', '26': '光電業', '27': '通信網路業',
    '28': '電子零組件業', '29': '電子通路業', '30': '資訊服務業', '31': '其他電子業', '32': '文化創意業',
    '33': '農業科技業', '34': '電子商務', '35': '綠能環保', '36': '數位雲端', '37': '運動休閒',
    '38': '居家生活', '80': '管理股票',
};

// 民國日期 "1151102" → "2026-11-02"
function rocToIso(s) {
    const m = /^(\d{2,3})(\d{2})(\d{2})$/.exec(String(s || ''));
    return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}

// 組合排行（獨立成函式方便測試）
function rank(basics, days, topN = TOP_N) {
    const day = new Map(days.map((d) => [d.Code, d]));
    const rows = [];
    for (const b of basics) {
        const code = b['公司代號'];
        const d = day.get(code);
        const shares = num(b['已發行普通股數或TDR原股發行股數']);
        const close = num(d?.ClosingPrice);
        const change = num(d?.Change);
        if (!/^\d{4}$/.test(code) || !shares || !close || change == null) continue;
        const prev = close - change;
        rows.push({
            s: code,
            name: b['公司簡稱'],
            cap: (close * shares) / 1e12,
            p: close,
            c: +change.toFixed(4),
            pct: prev > 0 ? +((change / prev) * 100).toFixed(2) : 0,
            ind: INDUSTRY[String(b['產業別']).trim()] || '',
            addr: String(b['住址'] || '').trim(),
        });
    }
    rows.sort((a, b) => b.cap - a.cap);
    return {
        total: rows.length,
        top: rows.slice(0, topN).map((r, i) => ({ rk: i + 1, ...r, cap: +r.cap.toFixed(3) })),
    };
}

// 讀個股即時檔（iKDx 自選股用的同一份）：[日期YYYYMMDD, 開, 高, 低, 現價, 成交量, 時間HH:MM:SS]
function readRealtime(code, dir = REALTIME_DIR) {
    try {
        const r = JSON.parse(fs.readFileSync(path.join(dir, code, 'realtime.json'), 'utf-8'));
        const price = Number(r[4]);
        return /^\d{8}$/.test(String(r[0])) && Number.isFinite(price) && price > 0 ? { date: String(r[0]), price, time: r[6] } : null;
    } catch {
        return null;
    }
}

/**
 * 把「現價與漲跌幅」換成最新的即時價（排名與市值排序仍用證交所收盤資料，才不會因盤中雜訊亂跳）。
 * 證交所 STOCK_DAY_ALL 盤中是「前一個交易日」的收盤，收盤後才變成當天：
 *   - 即時資料日期 > 證交所資料日期（盤中）：昨收 = 證交所收盤價 p，現價 = 即時價
 *   - 即時資料日期 <= 證交所資料日期（收盤後 / 沒有即時資料）：維持證交所的收盤價與漲跌
 * 即時價不可信時（缺檔、日期比證交所舊）一律不動，不會讓畫面出現怪數字。
 */
function applyRealtime(top, dayIso, read = readRealtime) {
    const dayYmd = dayIso.replace(/-/g, '');
    return top.map((t) => {
        const rt = read(t.s);
        if (!rt || rt.date <= dayYmd) return t;
        const prev = t.p;
        const change = +(rt.price - prev).toFixed(4);
        return {
            ...t,
            p: rt.price,
            c: change,
            pct: prev > 0 ? +((change / prev) * 100).toFixed(2) : 0,
            // 市值也跟著現價走（排名順序不動）。cap = 昨收市值 × 現價 / 昨收
            cap: prev > 0 ? +((t.cap * rt.price) / prev).toFixed(3) : t.cap,
            live: `${rt.date.slice(4, 6)}/${rt.date.slice(6, 8)} ${String(rt.time || '').slice(0, 5)}`,
        };
    });
}

async function main() {
    console.log('🚀 抓取台股市值排行 (證交所 OpenAPI)...');
    const [basics, days] = await Promise.all([
        withRetry(() => httpGet(BASIC_URL), 3, 2000),
        withRetry(() => httpGet(DAY_URL), 3, 2000),
    ]);
    if (!Array.isArray(basics) || !Array.isArray(days)) throw new Error('證交所回傳格式不是陣列');

    const ranked = rank(basics, days);
    const { total } = ranked;
    if (total < MIN_COMPANIES) throw new Error(`可計算市值的公司只有 ${total} 家，來源可能異常，不寫入`);
    if (ranked.top[0]?.s !== '2330') throw new Error(`市值第一名是 ${ranked.top[0]?.s}，不是台積電，資料可能有誤，不寫入`);

    const date = rocToIso(days.find((d) => d.Date)?.Date);
    if (!date) throw new Error('收盤資料沒有日期');
    const top = applyRealtime(ranked.top, date);
    const liveN = top.filter((t) => t.live).length;
    console.log(`📈 即時價套用 ${liveN}/${top.length} 檔（證交所收盤資料日期 ${date}）`);

    let prevTop = null;
    try {
        prevTop = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8'));
    } catch {
        /* 第一次執行 */
    }
    if (prevTop && prevTop.date === date && JSON.stringify(prevTop.top) === JSON.stringify(top)) {
        console.log(`⏭ ${date} 的排行沒有變動，不更新檔案`);
        return;
    }

    const out = { generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), date, top };
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(out), 'utf-8');
    console.log(`💾 已寫入 ${path.relative(ROOT, OUT_FILE)}（${date}，前十：${top.slice(0, 10).map((t) => t.name).join('、')}）`);
}

if (require.main === module) {
    main().catch((e) => {
        console.error('❌ 台股市值排行抓取失敗:', e.message);
        process.exit(1);
    });
}

module.exports = { rank, rocToIso, applyRealtime, readRealtime };
