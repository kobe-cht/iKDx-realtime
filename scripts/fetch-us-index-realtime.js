/**
 * S&P 500 (SP500) 即時報價抓取腳本
 *
 * 來源：Yahoo Finance chart API（^GSPC，免 API key）。輸出 public/data/SP500/realtime.json，
 * 格式與其它即時檔對齊並多一欄昨收：
 *   [日期YYYYMMDD, 開, 高, 低, 現價, 成交量("-"), 時間HH:MM:SS, 昨收]
 *
 * 日期/時間使用「台灣時間」：主專案把 SP500 當台灣時段指數處理（收盤價以美股交易日 +1 天標記、
 * 結算時間 13:30:00），即時資料用台灣時間才能讓前端「新資料時間 > 現有資料時間」的守門在
 * 整個美股盤中（台灣 21:30~隔日 05:00）都單調遞增，且之後的收盤結算能正確覆蓋。
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1m&range=1d';

// unix 秒 → 台灣時間 [YYYYMMDD, HH:MM:SS]
function toTaipeiParts(unixSec) {
    const [date, time] = new Date(unixSec * 1000)
        .toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })
        .split(' ');
    return [date.replace(/-/g, ''), time];
}

function round2(val) {
    return typeof val === 'number' ? +val.toFixed(2) : '-';
}

async function main() {
    console.log('🚀 抓取 S&P 500 即時報價 (Yahoo Finance)...');

    const res = await axios.get(API_URL, {
        timeout: 15000,
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
    });

    const result = res.data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) {
        throw new Error(`Yahoo 回傳無 chart.result[0].meta (^GSPC)，錯誤: ${JSON.stringify(res.data?.chart?.error)}`);
    }

    const { regularMarketPrice: price, regularMarketTime: ts, chartPreviousClose: prevClose } = meta;
    if (typeof price !== 'number' || price <= 0 || !ts || typeof prevClose !== 'number') {
        throw new Error(
            `Yahoo 指數欄位不完整 (price=${price}, time=${ts}, prevClose=${prevClose})，無法寫入`
        );
    }

    // 當日開盤價取第一根有值的 1 分 K
    const opens = result.indicators?.quote?.[0]?.open || [];
    const open = opens.find((v) => typeof v === 'number');

    const [date, time] = toTaipeiParts(ts);
    const row = [
        date,
        round2(open),
        round2(meta.regularMarketDayHigh),
        round2(meta.regularMarketDayLow),
        round2(price),
        '-',
        time,
        round2(prevClose),
    ];

    const dirPath = path.join(__dirname, '..', 'public', 'data', 'SP500');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'realtime.json'), JSON.stringify(row), 'utf-8');
    console.log(`✓ SP500 已儲存: ${JSON.stringify(row)}`);
}

main().catch((error) => {
    console.error('❌ S&P 500 即時抓取失敗:', error.message);
    process.exit(1);
});
