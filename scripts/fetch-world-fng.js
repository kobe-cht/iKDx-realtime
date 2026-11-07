/**
 * CNN 貪婪與恐慌指數抓取腳本（給 Mapverse 環遊股村概況卡的情緒條使用）
 *
 * 來源與 fetch-cnn-realtime.js（iKDx 主站用的 public/data/global.json）相同，
 * 這裡另外輸出 public/data/world/fng.json，並多帶前一日 / 一週 / 一個月 / 一年的數值：
 *   { generated, score, rating, updated, prev: { close, week, month, year } }
 * score 為 0～100；rating 為 CNN 原文（extreme fear / fear / neutral / greed / extreme greed）；
 * updated 為 CNN 資料時間（ISO，UTC）。
 *
 * 穩定性：失敗時不動現有檔案（沿用上一版），並以非 0 結束讓 workflow 回報；結果沒變不重寫檔案。
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
const OUT_FILE = path.join(__dirname, '..', 'public', 'data', 'world', 'fng.json');
const RATINGS = ['extreme fear', 'fear', 'neutral', 'greed', 'extreme greed'];

const num = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null);
const iso = (v) => {
    const t = new Date(v);
    return isNaN(t) ? null : t.toISOString().replace(/\.\d+Z$/, 'Z');
};

async function fetchOnce() {
    const res = await axios.get(API_URL, {
        timeout: 15000,
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            Accept: 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            Referer: 'https://edition.cnn.com/markets/fear-and-greed',
            Origin: 'https://edition.cnn.com',
        },
    });
    const f = res.data?.fear_and_greed;
    const score = num(f?.score);
    const rating = String(f?.rating || '').toLowerCase();
    const updated = iso(f?.timestamp);
    if (score == null || score < 0 || score > 100 || !RATINGS.includes(rating) || !updated) {
        throw new Error(`CNN 回應格式不對: ${JSON.stringify(f)}`);
    }
    return {
        score,
        rating,
        updated,
        prev: {
            close: num(f.previous_close),
            week: num(f.previous_1_week),
            month: num(f.previous_1_month),
            year: num(f.previous_1_year),
        },
    };
}

async function main() {
    console.log('🚀 抓取 CNN 貪婪與恐慌指數...');
    let data;
    for (let i = 1; i <= 3; i++) {
        try {
            data = await fetchOnce();
            break;
        } catch (e) {
            console.warn(`⚠ 第 ${i} 次失敗: ${e.message}`);
            if (i === 3) throw e;
            await new Promise((r) => setTimeout(r, 2000 * i));
        }
    }

    let old = null;
    try {
        old = JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8'));
    } catch {
        /* 第一次執行沒有舊檔 */
    }
    if (old && JSON.stringify({ ...old, generated: 0 }) === JSON.stringify({ generated: 0, ...data })) {
        console.log('= 與上一版相同，不重寫檔案');
        return;
    }

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    const out = { generated: iso(Date.now()), ...data };
    fs.writeFileSync(OUT_FILE, JSON.stringify(out), 'utf-8');
    console.log(`✓ 已寫入 ${path.relative(path.join(__dirname, '..'), OUT_FILE)}: ${JSON.stringify(out)}`);
}

main().catch((e) => {
    console.error('❌ CNN 貪婪與恐慌指數抓取失敗:', e.message);
    process.exit(1);
});
