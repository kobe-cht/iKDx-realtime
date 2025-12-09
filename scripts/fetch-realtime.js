const axios = require('axios');
const fs = require('fs');
const path = require('path');

// 白名單股票清單
const TARGET_STOCK_IDS = [
    '2330', // 台積電
    '2317', // 鴻海
    '2454', // 聯發科
    '2731', // 雄獅
    '2885', // 元大金
    '2891', // 中信金
    '0052', // 富邦科技
    '0056', // 元大高股息
    '1215', // 卜蜂
    '00713', // 元大台灣高息低波
    '2646', // 星宇航空
    '2308', // 台達電
    '2412', // 中華電
    '00646', // 元大S&P500
    '3008', // 大立光
    '00919', // 群益台灣精選高息
    '00937B', // 群益ESG投等債20+
    '00679B', // 元大美債20年
];

// 每批抓取的股票數量
const BATCH_SIZE = 30;
// 重試間隔（毫秒）
const RETRY_INTERVAL = 3000;
// 每批最大抓取時間（毫秒）- 30秒
const BATCH_FETCH_TIME = 30000;

// 讀取股票清單
function loadStockList() {
    const stockListPath = path.join(__dirname, '..', 'stock_list.json');
    const stockList = JSON.parse(fs.readFileSync(stockListPath, 'utf-8'));
    
    // 過濾白名單股票
    return stockList.filter(stock => TARGET_STOCK_IDS.includes(stock.id));
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`✓ ${stockId} 資料已儲存`);
}

// 延遲函數
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// 格式化日期為 YYYYMMDD
function formatDate(dateStr) {
    if (!dateStr) return null;
    // 移除所有非數字字符
    return dateStr.replace(/\D/g, '').slice(0, 8);
}

// 建立批次 API URL（一次抓多支股票）
function buildBatchUrl(stocks) {
    // ex_ch=tse_2330.tw,tse_2317.tw,otc_5483.tw
    const exCh = stocks.map(stock => {
        const exchange = stock.type === 'twse' ? 'tse' : 'otc';
        return `${exchange}_${stock.id}.tw`;
    }).join(',');
    
    return `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exCh}&json=1&delay=0`;
}

// 從 TWSE API 批次抓取多支股票資料
async function fetchBatchStockData(stocks) {
    const url = buildBatchUrl(stocks);
    
    try {
        const res = await axios.get(url, { 
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Referer': 'https://mis.twse.com.tw/stock/fibest.jsp'
            }
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

// 持續抓取一批股票 30 秒，直到所有股票都有有效成交價或超時
async function fetchBatchWithRetry(stocks) {
    const startTime = Date.now();
    
    // 初始化每支股票的最佳資料（用 Map 追蹤）
    const bestDataMap = new Map();
    stocks.forEach(stock => bestDataMap.set(stock.id, null));
    
    // 追蹤哪些股票已經有有效成交價
    const validStockIds = new Set();
    
    console.log(`\n📦 開始批次抓取 ${stocks.length} 支股票，持續 30 秒...`);
    console.log(`📋 股票: ${stocks.map(s => s.id).join(', ')}`);
    
    let retryCount = 0;
    
    while (Date.now() - startTime < BATCH_FETCH_TIME) {
        retryCount++;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        console.log(`\n⏱ [${elapsed}s] 第 ${retryCount} 次抓取...`);
        
        const dataArray = await fetchBatchStockData(stocks);
        
        if (dataArray.length > 0) {
            for (const data of dataArray) {
                const stockId = data.c; // 股票代號
                if (!stockId) continue;
                
                // 檢查 z (成交價) 是否有效
                const hasValidPrice = data.z && data.z !== '-' && !isNaN(Number(data.z));
                
                if (hasValidPrice) {
                    bestDataMap.set(stockId, data);
                    if (!validStockIds.has(stockId)) {
                        validStockIds.add(stockId);
                        console.log(`✓ ${stockId} 取得有效成交價: ${data.z}`);
                    }
                } else {
                    // 保存最後一筆資料（即使 z 是 -），但只在還沒有更好的資料時
                    if (!bestDataMap.get(stockId)) {
                        bestDataMap.set(stockId, data);
                    }
                }
            }
        }
        
        // 如果所有股票都有有效成交價，提前結束
        if (validStockIds.size === stocks.length) {
            console.log(`\n🎉 所有 ${stocks.length} 支股票都已取得有效成交價！`);
            break;
        }
        
        // 等待下次重試
        if (Date.now() - startTime < BATCH_FETCH_TIME) {
            await delay(RETRY_INTERVAL);
        }
    }
    
    const finalElapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`\n📊 批次抓取完成 (耗時 ${finalElapsed}s)，有效成交價: ${validStockIds.size}/${stocks.length}`);
    
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
        
        // 讀取現有資料
        const existingData = loadExistingData(stock.id);
        
        // 建立新資料列 [日期, 開盤價, 最高價, 最低價, 收盤價, 成交量]
        const newRow = [
            todayDate,
            parseValue(data.o),
            parseValue(data.h),
            parseValue(data.l),
            parseValue(data.z),
            parseValue(data.v)
        ];
        
        // 檢查是否有現有當日資料
        const existingIdx = existingData.findIndex(row => row[0] === todayDate);
        
        if (existingIdx === -1) {
            // 新增當日資料
            existingData.push(newRow);
            console.log(`✓ ${stock.id} 新增今日資料: ${JSON.stringify(newRow)}`);
        } else {
            // 更新現有資料（若新資料有更好的值）
            const existingRow = existingData[existingIdx];
            const updatedRow = newRow.map((val, idx) => {
                // 如果新值是 '-' 但舊值有效，保留舊值
                if (val === '-' && existingRow[idx] !== '-') {
                    return existingRow[idx];
                }
                return val;
            });
            existingData[existingIdx] = updatedRow;
            console.log(`✓ ${stock.id} 更新今日資料: ${JSON.stringify(updatedRow)}`);
        }
        
        // 儲存資料
        saveData(stock.id, existingData);
    }
}

// 主函數
async function main() {
    console.log('🚀 開始抓取即時股價...');
    console.log(`📅 執行時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
    console.log(`📋 白名單股票數量: ${TARGET_STOCK_IDS.length}`);
    console.log(`📦 每批最多 ${BATCH_SIZE} 支，每批持續抓取 ${BATCH_FETCH_TIME / 1000} 秒`);
    
    // 讀取並過濾股票清單
    let stocks = loadStockList();
    console.log(`📊 符合白名單的股票數量: ${stocks.length}`);
    
    // 如果 stock_list.json 中沒有白名單股票，建立預設資料
    if (stocks.length === 0) {
        console.log('⚠ 沒有符合白名單的股票，使用預設白名單建立股票資料...');
        stocks = TARGET_STOCK_IDS.map(id => ({
            id,
            name: id,
            // ETF（00 開頭且長度 >= 5）預設為 twse，其他也預設 twse
            type: 'twse'
        }));
    }
    
    // 將股票分批（每批最多 BATCH_SIZE 支）
    const batches = chunkArray(stocks, BATCH_SIZE);
    console.log(`📦 共分為 ${batches.length} 批`);
    
    // 逐批處理
    for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 處理第 ${i + 1}/${batches.length} 批（${batch.length} 支股票）`);
        console.log(`${'='.repeat(60)}`);
        
        // 批次抓取 30 秒
        const bestDataMap = await fetchBatchWithRetry(batch);
        
        // 處理並儲存資料
        processBatchData(batch, bestDataMap);
    }
    
    console.log(`\n${'='.repeat(60)}`);
    console.log('✅ 所有股票處理完成！');
    console.log(`${'='.repeat(60)}`);
}

main().catch(error => {
    console.error('❌ 執行失敗:', error);
    process.exit(1);
});
