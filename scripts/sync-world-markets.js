/**
 * 同步 Mapverse 的市場清單到 world_markets.json
 *
 * Mapverse 的 site/markets.json 決定地圖上要顯示哪些代碼；本專案的 world_markets.json
 * 決定每個代碼用哪些來源抓。新增代碼後執行：
 *
 *   npm run sync-world                          # 補上新代碼（預設只有 Yahoo 來源），列出已不存在的代碼
 *   npm run sync-world -- --prune               # 同時移除已不存在的代碼
 *   MAPVERSE_REPO=/path/to/Mapverse npm run sync-world
 *
 * 補上之後請視需要手動加備援來源（例如 CNBC），格式見 scripts/lib/world-sources.js。
 * 預設路徑 ../Mapverse（與本專案放在同一層資料夾）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILE = path.join(ROOT, 'world_markets.json');
const mapverse = process.env.MAPVERSE_REPO || path.join(ROOT, '..', 'Mapverse');
const marketsFile = path.join(mapverse, 'site', 'markets.json');

if (!fs.existsSync(marketsFile)) {
    console.error(`找不到 ${marketsFile}，請用 MAPVERSE_REPO 指定 Mapverse 專案路徑`);
    process.exit(1);
}

const prune = process.argv.includes('--prune');
const wanted = JSON.parse(fs.readFileSync(marketsFile, 'utf-8')).items.map((i) => i.s);
const world = JSON.parse(fs.readFileSync(FILE, 'utf-8'));
const have = new Set(world.items.map((i) => i.s));

const added = wanted.filter((s) => !have.has(s));
const extra = world.items.map((i) => i.s).filter((s) => !wanted.includes(s));

for (const s of added) world.items.push({ s, sources: [{ type: 'yahoo', code: s }] });
if (prune) world.items = world.items.filter((i) => wanted.includes(i.s));

// 依 Mapverse 的順序排列，已不存在的（沒有 --prune 時）放最後
const order = new Map(wanted.map((s, i) => [s, i]));
world.items.sort((a, b) => (order.get(a.s) ?? 1e6) - (order.get(b.s) ?? 1e6));

// 每個項目寫成一行，方便閱讀與 diff
const obj = (o) => `{${Object.entries(o).map(([k, v]) => `"${k}": ${JSON.stringify(v)}`).join(', ')}}`;
const lines = world.items.map((o) => `    {"s": ${JSON.stringify(o.s)}, "sources": [${o.sources.map(obj).join(', ')}]}`);
const head = Object.entries(world)
    .filter(([k]) => k !== 'items')
    .map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},\n`)
    .join('');
fs.writeFileSync(FILE, `{\n${head}  "items": [\n${lines.join(',\n')}\n  ]\n}\n`, 'utf-8');

console.log(`新增 ${added.length}：${added.join(', ') || '（無）'}`);
console.log(`${prune ? '已移除' : 'Mapverse 已不存在（加 --prune 移除）'} ${extra.length}：${extra.join(', ') || '（無）'}`);
