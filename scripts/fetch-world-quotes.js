/**
 * 世界行情抓取腳本（給 Mapverse 地圖世界使用）
 *
 * 讀取 world_markets.json，對每個代碼依序嘗試多個來源（Yahoo → CNBC → …），
 * 輸出 public/data/world/quotes.json：
 *   { generated, ok, total, quotes: { <代碼>: { p, c, pct, prev, t, spark, stale? } } }
 *
 * 穩定性設計：
 * - 單一來源失敗會自動換下一個來源；全部失敗才沿用上一版資料並標記 stale
 * - 成功率低於一半視為來源整體異常，不覆蓋現有檔案（直接以失敗結束）
 * - 報價與上一版完全相同（休市期間）不重寫檔案，避免產生沒有意義的 commit
 */

const fs = require('fs');
const path = require('path');
const { fetchChain, needsCtx } = require('./lib/world-sources');

const ROOT = path.join(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'public', 'data', 'world', 'quotes.json');
const CONCURRENCY = 4;
const MIN_SUCCESS_RATIO = 0.5;

function loadPrev() {
    try {
        return JSON.parse(fs.readFileSync(OUT_FILE, 'utf-8')).quotes || {};
    } catch {
        return {};
    }
}

async function runPool(items, worker) {
    const results = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                results[i] = await worker(items[i]);
            }
        })
    );
    return results;
}

async function main() {
    const { items } = JSON.parse(fs.readFileSync(path.join(ROOT, 'world_markets.json'), 'utf-8'));
    const prev = loadPrev();
    console.log(`🚀 抓取世界行情，共 ${items.length} 個代碼...`);

    const results = [];
    const quotes = {};
    // 第一階段：一般項目；第二階段：含 calc 備援的項目（要用到第一階段抓好的報價）
    const phase1 = items.filter((i) => !needsCtx(i));
    const phase2 = items.filter(needsCtx);
    const ctx = { quotes };
    for (const batch of [phase1, phase2]) {
        const out = await runPool(batch, async (item) => ({ item, ...(await fetchChain(item, ctx)) }));
        for (const r of out) {
            results.push(r);
            if (r.quote) quotes[r.item.s] = r.quote;
        }
    }

    const failed = [];
    const fellBack = [];
    for (const { item, quote, via, errors } of results) {
        if (quote) {
            // 主要來源（第一個）失敗而由備援補上的，列出來方便追蹤哪個來源壞了
            if (errors.length) fellBack.push(`${item.s} 改由 ${via}（${errors.join('；')}）`);
        } else {
            failed.push(item.s);
            console.warn(`⚠ ${item.s} 全部來源失敗：${errors.join('；')}`);
            if (prev[item.s]) quotes[item.s] = { ...prev[item.s], stale: true };
        }
    }
    fellBack.forEach((m) => console.log(`↪ ${m}`));

    const ok = items.length - failed.length;
    console.log(`✓ 成功 ${ok} / ${items.length}${failed.length ? `，失敗：${failed.join(', ')}` : ''}`);
    if (failed.length) console.log(`::warning::world quotes 有 ${failed.length} 個代碼抓取失敗：${failed.join(', ')}`);

    if (ok / items.length < MIN_SUCCESS_RATIO) {
        throw new Error(`成功率過低 (${ok}/${items.length})，保留現有資料不覆蓋`);
    }

    if (JSON.stringify(quotes) === JSON.stringify(prev)) {
        console.log('⏭ 報價與上一版相同，不更新檔案');
        return;
    }

    const out = { generated: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), ok, total: items.length, quotes };
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(out), 'utf-8');
    console.log(`💾 已寫入 ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((e) => {
    console.error('❌ 世界行情抓取失敗:', e.message);
    process.exit(1);
});
