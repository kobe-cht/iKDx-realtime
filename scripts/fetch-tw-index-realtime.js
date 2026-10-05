/**
 * 加權指數 (TAIEX) 即時報價抓取腳本
 *
 * 來源：TWSE mis（tse_t00.tw）。輸出 public/data/TAIEX/realtime.json，
 * 格式與個股 realtime.json 對齊並多一欄昨收：
 *   [日期YYYYMMDD, 開, 高, 低, 現價, 成交量("-"), 時間HH:MM:SS, 昨收]
 * 昨收由來源直接提供，前端用它算漲跌點數/幅度，不依賴本地日線的日期標記。
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_URL =
    'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0';

function toNumber(val) {
    const num = Number(val);
    return val === '-' || val === '' || val == null || isNaN(num) ? null : num;
}

async function main() {
    console.log('🚀 抓取加權指數即時報價 (TWSE mis)...');

    const res = await axios.get(API_URL, {
        timeout: 15000,
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Accept: 'application/json',
            Referer: 'https://mis.twse.com.tw/stock/fibest.jsp',
        },
    });

    const quote = res.data?.msgArray?.[0];
    if (!quote) {
        throw new Error(`TWSE 回傳無 msgArray[0]（ex_ch=tse_t00.tw），原始回應: ${JSON.stringify(res.data)}`);
    }

    const price = toNumber(quote.z);
    if (price === null) {
        // 開盤後第一筆指數計算前 z 為 "-"，屬正常情況，保留上一筆資料
        console.log(`⏭ 尚無成交指數 (z=${quote.z})，本次不更新`);
        return;
    }

    const prevClose = toNumber(quote.y);
    const date = String(quote.d || '').replace(/\D/g, '').slice(0, 8);
    if (date.length !== 8 || !quote.t || prevClose === null) {
        throw new Error(
            `TWSE 指數欄位不完整 (d=${quote.d}, t=${quote.t}, y=${quote.y})，無法寫入`
        );
    }

    const row = [date, toNumber(quote.o) ?? '-', toNumber(quote.h) ?? '-', toNumber(quote.l) ?? '-', price, '-', quote.t, prevClose];

    const dirPath = path.join(__dirname, '..', 'public', 'data', 'TAIEX');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'realtime.json'), JSON.stringify(row), 'utf-8');
    console.log(`✓ TAIEX 已儲存: ${JSON.stringify(row)}`);
}

main().catch((error) => {
    console.error('❌ 加權指數即時抓取失敗:', error.message);
    process.exit(1);
});
