const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 目標股票來源：與主專案「有抓收盤」的清單一致（target_stock_ids.json），
// 由主專案 src/configs/stock-ids.js 的 TARGET_STOCK_IDS 同步而來，取代過往硬編白名單。
const TARGET_IDS_PATH = path.join(__dirname, '..', 'target_stock_ids.json');

// 每個 API 請求查詢的股票數量（TWSE mis 批次查詢可一次帶多檔）
const BATCH_SIZE = 50;
// 同時併發的請求數量（控制併發以避免被 TWSE 阻擋）
const CONCURRENCY = 3;
// 整體抓取時間預算（毫秒）- 須在 GitHub Actions 6 分鐘排程間隔內完成
const TOTAL_FETCH_TIME = 120000;
// 每輪重試之間的間隔（毫秒）
const RETRY_INTERVAL = 3000;
// 併發請求啟動時的隨機錯開上限（毫秒），避免同一瞬間打出大量相同請求
const REQUEST_JITTER = 500;

// 讀取目標股票 ID 清單
function loadTargetIds() {
    return JSON.parse(fs.readFileSync(TARGET_IDS_PATH, 'utf-8'));
}

// 依目標 ID 過濾股票清單；stock_list.json 未收錄者以預設 type 補上（多為 TSE 上市）
function loadStockList() {
    const stockListPath = path.join(__dirname, '..', 'stock_list.json');
    const stockList = JSON.parse(fs.readFileSync(stockListPath, 'utf-8'));
    const targetIds = loadTargetIds();

    const byId = new Map(stockList.map((s) => [s.id, s]));
    return targetIds.map((id) => {
        const found = byId.get(id);
        if (found) return found;
        // stock_list.json 尚未收錄（清單較新），預設為上市（tse）
        return { id, name: id, type: 'twse' };
    });
}

// 確保目錄存在
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// 讀取現有的 realtime.json
function loadExistingData(stockId) {
    const filePath = path.join(__dirname, '..', 'public', 'data', stockId, 'realtime.json');
    if (fs.existsSync(filePath)) {
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch (e) {
            console.log(`⚠ ${stockId} 讀取現有資料失敗，使用空陣列`);
            return [];
        }
    }
    return [];
}

// 儲存資料
function saveData(stockId, data) {
    const dirPath = path.join(__dirname, '..', 'public', 'data', stockId);
    ensureDir(dirPath);
    const filePath = path.join(dirPath, 'realtime.json');
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    console.log(`✓ ${stockId} 資料已儲存`);
}

// 延遲函數
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 格式化日期為 YYYYMMDD
function formatDate(dateStr) {
    if (!dateStr) return null;
    // 移除所有非數字字符
    return dateStr.replace(/\D/g, '').slice(0, 8);
}

// 建立批次 API URL（一次抓多支股票）
function buildBatchUrl(stocks) {
    // ex_ch=tse_2330.tw|tse_2317.tw|otc_00679B.tw 。00937B、00679B 為 OTC 股票
    const exCh = stocks
        .map((stock) => {
            const exchange = stock.type === 'twse' ? 'tse' : 'otc';
            return `${exchange}_${stock.id}.tw`;
        })
        .join('|');
    return `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0`;
}

// 從 TWSE API 批次抓取多支股票資料
async function fetchBatchStockData(stocks) {
    const url = buildBatchUrl(stocks);

    try {
        const res = await axios.get(url, {
            timeout: 15000,
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'application/json',
                Referer: 'https://mis.twse.com.tw/stock/fibest.jsp',
            },
        });

        // 回傳 msgArray，每個元素對應一支股票
        return res.data?.msgArray || [];
    } catch (error) {
        console.log(`⚠ 批次請求失敗: ${error.message}`);
        return [];
    }
}

// 解析數值，若為 - 則回傳 '-'
function parseValue(val) {
    if (val === '-' || val === null || val === undefined || val === '') {
        return '-';
    }
    const num = Number(val);
    return isNaN(num) ? '-' : num;
}

// 解析日期
function parseDate(data) {
    let todayDate = data.d;
    if (!todayDate && data.tlong) {
        const d = new Date(Number(data.tlong));
        todayDate = d.toISOString().slice(0, 10).replace(/-/g, '');
    }
    if (todayDate && todayDate.includes('/')) {
        todayDate = todayDate.replace(/\//g, '');
    }
    return formatDate(todayDate);
}

// 將陣列分割成多個批次
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// 以受控併發執行多個非同步任務，回傳所有結果
async function runWithConcurrency(taskFns, concurrency) {
    const results = new Array(taskFns.length);
    let nextIndex = 0;

    async function worker() {
        while (true) {
            const current = nextIndex++;
            if (current >= taskFns.length) return;
            results[current] = await taskFns[current]();
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, taskFns.length) }, worker);
    await Promise.all(workers);
    return results;
}

// 將一輪抓回的資料併入彙總狀態
function mergeQuotes(dataArray, bestDataMap, validStockIds) {
    let newValid = 0;
    for (const data of dataArray) {
        const stockId = data.c; // 股票代號
        if (!stockId) continue;

        const hasValidPrice = data.z && data.z !== '-' && !isNaN(Number(data.z));
        if (hasValidPrice) {
            bestDataMap.set(stockId, data);
            if (!validStockIds.has(stockId)) {
                validStockIds.add(stockId);
                newValid++;
            }
        } else if (!bestDataMap.get(stockId)) {
            // 保存最後一筆資料（即使 z 是 -），但只在還沒有更好的資料時
            bestDataMap.set(stockId, data);
        }
    }
    return newValid;
}

// 多批併發抓取，直到所有股票都有有效成交價或超過整體時間預算
async function fetchAllWithConcurrency(stocks) {
    const startTime = Date.now();

    // 每支股票的最佳資料 / 已取得有效價的集合
    const bestDataMap = new Map();
    stocks.forEach((stock) => bestDataMap.set(stock.id, null));
    const validStockIds = new Set();

    // 預先切分批次（每個請求查詢 BATCH_SIZE 支）
    const allBatches = chunkArray(stocks, BATCH_SIZE);
    console.log(`\n📦 共 ${stocks.length} 支股票，切為 ${allBatches.length} 批（每批 ${BATCH_SIZE} 支），併發 ${CONCURRENCY}`);

    let round = 0;
    while (Date.now() - startTime < TOTAL_FETCH_TIME) {
        round++;

        // 只重試「仍有股票尚未取得有效成交價」的批次
        const pendingBatches = allBatches.filter((batch) => batch.some((s) => !validStockIds.has(s.id)));
        if (pendingBatches.length === 0) break;

        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`\n⏱ [${elapsed}s] 第 ${round} 輪：待抓 ${pendingBatches.length} 批`);

        // 為每個待抓批次建立任務（啟動時加入隨機抖動錯開，避免同時打出大量請求）
        const tasks = pendingBatches.map((batch) => async () => {
            await delay(Math.floor(Math.random() * REQUEST_JITTER));
            const dataArray = await fetchBatchStockData(batch);
            return mergeQuotes(dataArray, bestDataMap, validStockIds);
        });

        await runWithConcurrency(tasks, CONCURRENCY);

        console.log(`   ✓ 累計有效成交價: ${validStockIds.size}/${stocks.length}`);

        if (validStockIds.size === stocks.length) {
            console.log(`\n🎉 所有 ${stocks.length} 支股票都已取得有效成交價！`);
            break;
        }

        if (Date.now() - startTime < TOTAL_FETCH_TIME) {
            await delay(RETRY_INTERVAL);
        }
    }

    const finalElapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n📊 抓取完成 (耗時 ${finalElapsed}s)，有效成交價: ${validStockIds.size}/${stocks.length}`);

    return bestDataMap;
}

// 處理並儲存批次資料
function processBatchData(stocks, bestDataMap) {
    for (const stock of stocks) {
        const data = bestDataMap.get(stock.id);

        if (!data) {
            console.log(`⚠ ${stock.id} 無法取得任何資料`);
            continue;
        }

        const todayDate = parseDate(data);
        if (!todayDate) {
            console.log(`⚠ ${stock.id} 無法解析日期`);
            continue;
        }

        // 建立新資料列 [日期, 開盤價, 最高價, 最低價, 收盤價, 成交量, 時間]
        // 只保留最新一筆資料（一維陣列）
        const newRow = [
            todayDate,
            parseValue(data.o),
            parseValue(data.h),
            parseValue(data.l),
            parseValue(data.z),
            parseValue(data.v),
            data.t || '-', // 時間放在最後一個元素
        ];

        console.log(`✓ ${stock.id} 更新即時資料: ${JSON.stringify(newRow)}`);

        // 直接儲存為一維陣列（只保留最新資料）
        saveData(stock.id, newRow);
    }
}

// 主函數
async function main() {
    console.log('🚀 開始抓取即時股價...');
    console.log(`📅 執行時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);

    // 讀取並過濾股票清單（與主專案「有抓收盤」的清單一致）
    const stocks = loadStockList();
    console.log(`📋 目標股票數量: ${stocks.length}`);
    console.log(`📦 每請求 ${BATCH_SIZE} 支，併發 ${CONCURRENCY}，整體時間預算 ${TOTAL_FETCH_TIME / 1000} 秒`);

    // 多批併發抓取
    const bestDataMap = await fetchAllWithConcurrency(stocks);

    // 處理並儲存所有資料
    processBatchData(stocks, bestDataMap);

    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ 所有股票處理完成！');
    console.log(`${'='.repeat(60)}`);
}

main().catch((error) => {
    console.error('❌ 執行失敗:', error);
    process.exit(1);
});
