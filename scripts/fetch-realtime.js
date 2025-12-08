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

// 重試間隔（毫秒）
const RETRY_INTERVAL = 3000;
// 最大重試時間（毫秒）- 30秒
const MAX_RETRY_TIME = 30000;

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
    console.log(`✓ ${stockId} 資料已儲存至 ${filePath}`);
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

// 從 TWSE API 抓取單一股票資料
async function fetchStockData(stock) {
    const exchange = stock.type === 'twse' ? 'tse' : 'otc';
    const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${exchange}_${stock.id}.tw`;
    
    try {
        const res = await axios.get(url, { 
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });
        return res.data?.msgArray?.[0] || null;
    } catch (error) {
        console.log(`⚠ ${stock.id} 請求失敗: ${error.message}`);
        return null;
    }
}

// 持續抓取直到有有效的成交價或超時
async function fetchWithRetry(stock) {
    const startTime = Date.now();
    let lastValidData = null;
    
    while (Date.now() - startTime < MAX_RETRY_TIME) {
        const data = await fetchStockData(stock);
        
        if (data) {
            // 檢查 z (成交價) 是否有效
            if (data.z && data.z !== '-' && !isNaN(Number(data.z))) {
                console.log(`✓ ${stock.id} 取得有效成交價: ${data.z}`);
                return data;
            }
            // 保存最後一筆資料（即使 z 是 -）
            lastValidData = data;
            console.log(`⏳ ${stock.id} 成交價為 -, 等待重試...`);
        }
        
        await delay(RETRY_INTERVAL);
    }
    
    console.log(`⚠ ${stock.id} 超過30秒仍無有效成交價，使用最後取得的資料`);
    return lastValidData;
}

// 處理單一股票
async function processStock(stock) {
    console.log(`\n📊 處理 ${stock.id} ${stock.name}...`);
    
    // 讀取現有資料
    const existingData = loadExistingData(stock.id);
    
    // 抓取即時資料（含重試機制）
    const todayData = await fetchWithRetry(stock);
    
    if (!todayData) {
        console.log(`⚠ ${stock.id} 無法取得任何資料`);
        return;
    }
    
    // 解析日期
    let todayDate = todayData.d;
    if (!todayDate && todayData.tlong) {
        const d = new Date(Number(todayData.tlong));
        todayDate = d.toISOString().slice(0, 10).replace(/-/g, '');
    }
    if (todayDate && todayDate.includes('/')) {
        // 處理 2025/12/05 格式
        todayDate = todayDate.replace(/\//g, '');
    }
    
    todayDate = formatDate(todayDate);
    
    if (!todayDate) {
        console.log(`⚠ ${stock.id} 無法解析日期`);
        return;
    }
    
    // 解析數值，若為 - 則回傳 '-'
    const parseValue = (val) => {
        if (val === '-' || val === null || val === undefined || val === '') {
            return '-';
        }
        const num = Number(val);
        return isNaN(num) ? '-' : num;
    };
    
    // 建立新資料列 [日期, 開盤價, 最高價, 最低價, 收盤價, 成交量]
    const newRow = [
        todayDate,
        parseValue(todayData.o),
        parseValue(todayData.h),
        parseValue(todayData.l),
        parseValue(todayData.z),
        parseValue(todayData.v)
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

// 主函數
async function main() {
    console.log('🚀 開始抓取即時股價...');
    console.log(`📅 執行時間: ${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
    console.log(`📋 白名單股票數量: ${TARGET_STOCK_IDS.length}`);
    
    // 讀取並過濾股票清單
    const stocks = loadStockList();
    console.log(`📊 符合白名單的股票數量: ${stocks.length}`);
    
    if (stocks.length === 0) {
        console.log('⚠ 沒有符合白名單的股票');
        
        // 如果 stock_list.json 中沒有白名單股票，建立預設資料
        console.log('📝 使用預設白名單建立股票資料...');
        const defaultStocks = TARGET_STOCK_IDS.map(id => ({
            id,
            name: id,
            type: id.startsWith('00') && id.length >= 5 ? 'twse' : 'twse' // ETF 和一般股票
        }));
        
        for (const stock of defaultStocks) {
            await processStock(stock);
        }
    } else {
        // 處理每支股票
        for (const stock of stocks) {
            await processStock(stock);
        }
    }
    
    console.log('\n✅ 所有股票處理完成！');
}

main().catch(error => {
    console.error('❌ 執行失敗:', error);
    process.exit(1);
});
