const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const app = express();

// 启用CORS
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// 初始化额度数据（实际应用中应该从数据库获取）
let quotaData = {
    east: { clinic: 20, yandao: 20 },
    west: { clinic: 20, yandao: 20 },
    south: { clinic: 20, yandao: 20 },
    north: { clinic: 20, yandao: 20 },
    central: { clinic: 20, yandao: 20 }
};

// 操作历史记录
let operationHistory = [];

// 创建HTTP服务器
const server = http.createServer(app);

// 创建WebSocket服务器
const wss = new WebSocket.Server({ server });

// WebSocket连接处理
wss.on('connection', (ws) => {
    console.log('客户端已连接');
    
    // 发送初始数据给客户端
    ws.send(JSON.stringify({ type: 'quotaUpdate', data: quotaData }));
    
    // 连接关闭处理
    ws.on('close', () => {
        console.log('客户端已断开连接');
    });
});

// 广播数据更新给所有连接的客户端
function broadcastUpdate() {
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'quotaUpdate', data: quotaData }));
        }
    });
}

// API路由：获取额度数据
app.get('/api/quota', (req, res) => {
    res.json(quotaData);
});

// API路由：更新额度数据
app.post('/api/quota', (req, res) => {
    const { region, channel, action, amount, note, user } = req.body;
    
    if (!region || !channel || !action || !amount) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    
    // 更新额度数据
    if (action === 'use') {
        if (quotaData[region][channel] < amount) {
            return res.status(400).json({ error: '额度不足' });
        }
        quotaData[region][channel] -= parseInt(amount);
    } else if (action === 'add') {
        quotaData[region][channel] += parseInt(amount);
    }
    
    // 记录操作历史
    const operation = {
        time: new Date().toLocaleString(),
        region,
        channel,
        action,
        amount,
        user: user || '系统管理员',
        note: note || ''
    };
    
    operationHistory.push(operation);
    
    // 广播更新给所有客户端
    broadcastUpdate();
    
    res.json({ success: true, data: quotaData });
});

// API路由：获取操作历史
app.get('/api/history', (req, res) => {
    res.json(operationHistory);
});

// 统计banner点击和关键词提交数据
let bannerTestData = {
    clicks: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    submissions: []
};

// 记录用户提交状态，简单用内存存储，实际应用建议用数据库和用户身份验证
const userSubmissions = new Set();

// 统计banner点击接口
app.post('/api/banner_test/click', (req, res) => {
    const { bannerId, userId } = req.body;
    if (!bannerId || !userId) {
        return res.status(400).json({ error: '缺少bannerId或userId' });
    }
    // 统计点击次数
    if (bannerTestData.clicks[bannerId] !== undefined) {
        bannerTestData.clicks[bannerId] += 1;
        return res.json({ success: true });
    } else {
        return res.status(400).json({ error: '无效的bannerId' });
    }
});

// 提交关键词接口，限制每个用户只能提交一次
app.post('/api/banner_test/submit', (req, res) => {
    const { bannerId, keyword, userId } = req.body;
    if (!bannerId || !keyword || !userId) {
        return res.status(400).json({ error: '缺少必要参数' });
    }
    if (userSubmissions.has(userId)) {
        return res.status(400).json({ error: '您已提交过，不能重复提交' });
    }
    // 记录提交
    bannerTestData.submissions.push({ bannerId, keyword, userId, time: new Date().toISOString() });
    userSubmissions.add(userId);
    return res.json({ success: true });
});

// 获取banner测试数据统计
app.get('/api/banner_test/stats', (req, res) => {
    res.json(bannerTestData);
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});