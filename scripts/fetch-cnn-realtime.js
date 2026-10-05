/**
 * CNN 恐慌與貪婪指數即時抓取腳本
 *
 * 輸出 public/data/global.json，格式與主專案 crawler/cnn-index.js 一致：
 *   { cnnIndex, cnnStatus, cnnUpdateTime }
 * cnnUpdateTime 為台灣時間 "YYYY/MM/DD HH:mm:ss"。
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_URL = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';

// CNN timestamp (ISO) → 台灣時間 "YYYY/MM/DD HH:mm:ss"
function toTaipeiString(isoOrMs) {
    return new Date(isoOrMs)
        .toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' })
        .replace(/-/g, '/');
}

async function main() {
    console.log('🚀 抓取 CNN 恐慌與貪婪指數...');

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

    const fng = res.data?.fear_and_greed;
    if (!fng || typeof fng.score !== 'number' || !fng.timestamp) {
        throw new Error(
            `CNN 回應缺少 fear_and_greed.score / timestamp，實際內容: ${JSON.stringify(fng)}`
        );
    }

    const data = {
        cnnIndex: fng.score,
        cnnStatus: fng.rating,
        cnnUpdateTime: toTaipeiString(fng.timestamp),
    };

    const dirPath = path.join(__dirname, '..', 'public', 'data');
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'global.json'), JSON.stringify(data), 'utf-8');
    console.log(`✓ CNN 指數已儲存: ${JSON.stringify(data)}`);
}

main().catch((error) => {
    console.error('❌ CNN 指數即時抓取失敗:', error.message);
    process.exit(1);
});
