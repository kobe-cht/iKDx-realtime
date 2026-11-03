/**
 * 經濟數據抓取腳本（給 Mapverse 地圖世界的「經濟數據」主題使用）
 *
 * 讀取 world_econ.json，對每個指標依序嘗試多個來源（FRED / Eurostat / Trading Economics / 國發會），
 * 輸出 public/data/world/econ.json：
 *   { generated, ok, total, items: { <指標代碼>: { v, prev, d, unit, ref, via, light?, stale? } } }
 *
 * 穩定性設計（同 fetch-world-quotes.js）：
 * - 單一來源失敗或資料過期會換下一個來源；全部失敗才沿用上一版並標 stale
 * - 成功率低於一半視為來源整體異常，不覆蓋現有檔案
 * - 結果與上一版相同不重寫檔案
 * - 經濟數據一個月才更新一次，所以每次執行只在上次抓取超過 ECON_MAX_AGE_MIN 分鐘（預設 180）時才真的去抓；
 *   FORCE=1 可略過這個限制（手動觸發 workflow 時使用）
 */

const fs = require('fs');
const path = require('path');
const { fetchEconChain } = require('./lib/econ-sources');

const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'public', 'data', 'world', 'econ.json');
const MIN_SUCCESS_RATIO = 0.5;
const MAX_AGE_MIN = Number(process.env.ECON_MAX_AGE_MIN || 180);
const CONCURRENCY = 3;

function readPrev() {
    try {
        return JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8'));
    } catch {
        return null;
    }
}

async function runPool(items, worker) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await worker(items[i]);
            }
        })
    );
    return out;
}

async function main() {
    const prevFile = readPrev();
    const prev = prevFile?.items || {};
    if (prevFile?.generated && process.env.FORCE !== '1') {
        const ageMin = (Date.now() - Date.parse(prevFile.generated)) / 60000;
        if (ageMin < MAX_AGE_MIN) {
            console.log(`⏭ 上次抓取是 ${Math.round(ageMin)} 分鐘前（< ${MAX_AGE_MIN}），本次略過（FORCE=1 可強制）`);
            return;
        }
    }

    const { items: defs } = JSON.parse(fs.readFileSync(path.join(ROOT, 'world_econ.json'), 'utf-8'));
    console.log(`🚀 抓取經濟數據，共 ${defs.length} 個指標...`);
    const results = await runPool(defs, async (def) => ({ def, ...(await fetchEconChain(def)) }));

    const items = {};
    const failed = [];
    for (const { def, result, via, errors } of results) {
        if (result) {
            items[def.id] = { ...result, via };
            if (errors.length) console.log(`↪ ${def.id} 改由 ${via}（${errors.join('；')}）`);
        } else {
            failed.push(def.id);
            console.warn(`⚠ ${def.id} 全部來源失敗：${errors.join('；')}`);
            if (prev[def.id]) items[def.id] = { ...prev[def.id], stale: true };
        }
    }

    const ok = defs.length - failed.length;
    console.log(`✓ 成功 ${ok} / ${defs.length}${failed.length ? `，失敗：${failed.join(', ')}` : ''}`);
    if (failed.length) console.log(`::warning::econ 有 ${failed.length} 個指標抓取失敗：${failed.join(', ')}`);
    if (ok / defs.length < MIN_SUCCESS_RATIO) {
        throw new Error(`成功率過低 (${ok}/${defs.length})，保留現有資料不覆蓋`);
    }

    if (JSON.stringify(items) === JSON.stringify(prev)) {
        // 內容沒變也要更新時間戳，否則「上次抓取」永遠過期，每次都會重新請求
        const out = { ...prevFile, generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z') };
        fs.writeFileSync(OUT_FILE, JSON.stringify(out), 'utf-8');
        console.log('⏭ 數據與上一版相同，只更新時間戳');
        return;
    }

    const out = { generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ok, total: defs.length, items };
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(out), 'utf-8');
    console.log(`💾 已寫入 ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((e) => {
    console.error('❌ 經濟數據抓取失敗:', e.message);
    process.exit(1);
});
