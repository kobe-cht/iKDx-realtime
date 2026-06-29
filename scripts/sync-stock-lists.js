/**
 * 同步股票白名單腳本（單一真實來源：主專案 iKDx）
 *
 * 讀取主專案 src/configs/stock-ids.js 的白名單，重新產生 realtime repo 需要的：
 *   - target_stock_ids.json   （台股「有抓收盤」的目標 ID 清單）
 *   - us_stock_list.json       （美股個股 + ETF，含中文名稱）
 *
 * 使用時機：主專案白名單（TARGET_STOCK_IDS / US_STOCK_IDS / US_ETF_IDS）有增減時，
 *           在 realtime repo 執行一次，再 commit & push。
 *
 * 用法：
 *   node scripts/sync-stock-lists.js
 *   IKDX_MAIN_REPO=../iKDx node scripts/sync-stock-lists.js   （自訂主專案路徑）
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');

// 主專案路徑：預設為同工作區的相鄰資料夾 ../iKDx，可用環境變數覆寫
const MAIN_REPO = process.env.IKDX_MAIN_REPO ? path.resolve(process.env.IKDX_MAIN_REPO) : path.join(ROOT, '..', 'iKDx');

const STOCK_IDS_PATH = path.join(MAIN_REPO, 'src', 'configs', 'stock-ids.js');

// 由 stock-ids.js 原始碼解析 `'ID', // 名稱` 形式，建立 id → 名稱對照表
function parseNameMap(sourceText) {
    const map = {};
    const re = /'([^']+)'\s*,\s*\/\/\s*(.+)/g;
    let m;
    while ((m = re.exec(sourceText)) !== null) {
        const id = m[1].trim();
        const name = m[2].trim();
        if (id && name && !map[id]) map[id] = name;
    }
    return map;
}

// 讀取既有 JSON，失敗回傳預設值
function readJsonSafe(filePath, fallback) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return fallback;
    }
}

async function main() {
    if (!fs.existsSync(STOCK_IDS_PATH)) {
        console.error(`❌ 找不到主專案白名單檔：${STOCK_IDS_PATH}`);
        console.error('   請確認 iKDx 與 iKDx-realtime 為相鄰資料夾，或設定 IKDX_MAIN_REPO 環境變數。');
        process.exit(1);
    }

    // 動態 import 主專案的 ESM 設定檔（純資料、無 Node/瀏覽器 API）
    const stockIds = await import(pathToFileURL(STOCK_IDS_PATH).href);
    const { TARGET_STOCK_IDS, US_STOCK_IDS, US_ETF_IDS } = stockIds;

    // 名稱來源：先解析原始碼註解，缺漏時退回既有清單，再退回 id 本身
    const nameMap = parseNameMap(fs.readFileSync(STOCK_IDS_PATH, 'utf-8'));
    const existingUs = readJsonSafe(path.join(ROOT, 'us_stock_list.json'), []);
    const existingNameMap = Object.fromEntries(existingUs.map((s) => [s.id, s.name]));
    const resolveName = (id) => nameMap[id] || existingNameMap[id] || id;

    // ===== 台股 target_stock_ids.json =====
    const twIds = [...TARGET_STOCK_IDS];
    const twPath = path.join(ROOT, 'target_stock_ids.json');
    const prevTwIds = readJsonSafe(twPath, []);
    fs.writeFileSync(twPath, JSON.stringify(twIds, null, 4) + '\n', 'utf-8');

    const twAdded = twIds.filter((id) => !prevTwIds.includes(id));
    const twRemoved = prevTwIds.filter((id) => !twIds.includes(id));
    console.log(`✓ target_stock_ids.json：${twIds.length} 支`);
    if (twAdded.length) console.log(`   ＋新增 ${twAdded.length}：${twAdded.join(', ')}`);
    if (twRemoved.length) console.log(`   －移除 ${twRemoved.length}：${twRemoved.join(', ')}`);

    // ===== 美股 us_stock_list.json =====
    const usList = [
        ...US_STOCK_IDS.map((id) => ({ id, name: resolveName(id), type: 'us_stock' })),
        ...US_ETF_IDS.map((id) => ({ id, name: resolveName(id), type: 'us_etf' })),
    ];
    const usPath = path.join(ROOT, 'us_stock_list.json');
    const prevUsIds = existingUs.map((s) => s.id);
    fs.writeFileSync(usPath, JSON.stringify(usList, null, 4) + '\n', 'utf-8');

    const usIds = usList.map((s) => s.id);
    const usAdded = usIds.filter((id) => !prevUsIds.includes(id));
    const usRemoved = prevUsIds.filter((id) => !usIds.includes(id));
    console.log(`✓ us_stock_list.json：${usList.length} 支（個股 ${US_STOCK_IDS.length}、ETF ${US_ETF_IDS.length}）`);
    if (usAdded.length) console.log(`   ＋新增 ${usAdded.length}：${usAdded.join(', ')}`);
    if (usRemoved.length) console.log(`   －移除 ${usRemoved.length}：${usRemoved.join(', ')}`);

    console.log('\n✅ 同步完成，請 commit 並 push 以套用到 GitHub Actions。');
}

main().catch((err) => {
    console.error('❌ 同步失敗:', err);
    process.exit(1);
});
