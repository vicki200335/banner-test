const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
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
        quotaData[region][channel] -= parseInt(amount, 10);
    } else if (action === 'add') {
        quotaData[region][channel] += parseInt(amount, 10);
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
    }

    return res.status(400).json({ error: '无效的bannerId' });
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

/**
 * 外科瓣膜期刊自动追踪 + AI润色 + 自动分发（MVP，内存版）
 */
const valveTool = {
    sources: [
        { id: 'pubmed', name: 'PubMed', type: 'api', url: 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/', active: true },
        { id: 'crossref', name: 'CrossRef', type: 'api', url: 'https://api.crossref.org/works', active: true }
    ],
    articles: [],
    articleFingerprints: new Set(),
    deliveries: []
};

function getEmailConfig() {
    return {
        fromEmail: process.env.FROM_EMAIL,
        ownerEmail: process.env.OWNER_EMAIL
    };
}

function stripTags(value = '') {
    return value
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function escapeXml(value = '') {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}

function extractTag(block, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
    const match = block.match(regex);
    return match ? stripTags(escapeXml(match[1])) : '';
}

function parseRss(xmlText) {
    const items = [];
    const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    let match = itemRegex.exec(xmlText);

    while (match) {
        const block = match[1];
        items.push({
            title: extractTag(block, 'title'),
            link: extractTag(block, 'link'),
            pubDate: extractTag(block, 'pubDate') || new Date().toISOString(),
            description: extractTag(block, 'description') || extractTag(block, 'content:encoded')
        });
        match = itemRegex.exec(xmlText);
    }

    return items;
}

function buildPubMedSearchUrl() {
    const params = new URLSearchParams({
        db: 'pubmed',
        sort: 'pub+date',
        retmode: 'json',
        retmax: '10',
        term: '(heart valve surgery[Title/Abstract]) OR (valve replacement[Title/Abstract]) OR (TAVR[Title/Abstract]) OR (mitral valve[Title/Abstract])'
    });
    return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params.toString()}`;
}

function buildPubMedSummaryUrl(ids) {
    const params = new URLSearchParams({
        db: 'pubmed',
        retmode: 'json',
        id: ids.join(',')
    });
    return `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params.toString()}`;
}

async function fetchPubMedItems() {
    const searchText = await fetchWithTimeout(buildPubMedSearchUrl());
    const searchResult = JSON.parse(searchText);
    const ids = searchResult?.esearchresult?.idlist || [];

    if (!ids.length) {
        return [];
    }

    const summaryText = await fetchWithTimeout(buildPubMedSummaryUrl(ids));
    const summaryResult = JSON.parse(summaryText);

    return ids.map((id) => {
        const item = summaryResult?.result?.[id] || {};
        const title = item.title || `PubMed Article ${id}`;
        const pubDate = item.pubdate || new Date().toISOString();
        const journal = item.fulljournalname || item.source || 'PubMed';

        return {
            title,
            link: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
            pubDate,
            description: `${journal}. PMID: ${id}`
        };
    });
}

function extractCrossRefPubDate(issued) {
    const parts = issued?.['date-parts']?.[0] || [];
    if (!parts.length) {
        return new Date().toISOString();
    }

    const [year, month = 1, day = 1] = parts;
    return new Date(Date.UTC(year, month - 1, day)).toISOString();
}

async function fetchCrossRefItems() {
    const sinceDate = new Date(Date.now() - (180 * 24 * 60 * 60 * 1000));
    const params = new URLSearchParams({
        rows: '10',
        sort: 'published',
        order: 'desc',
        filter: `from-pub-date:${sinceDate.toISOString().slice(0, 10)}`,
        query: 'heart valve surgery TAVR mitral valve replacement'
    });

    const jsonText = await fetchWithTimeout(`https://api.crossref.org/works?${params.toString()}`);
    const result = JSON.parse(jsonText);
    const works = result?.message?.items || [];

    return works.map((item) => {
        const title = Array.isArray(item.title) ? item.title[0] : '';
        const doi = item.DOI || '';
        const abstract = stripTags(item.abstract || '');
        const container = Array.isArray(item['container-title']) ? item['container-title'][0] : 'CrossRef';

        return {
            title: title || doi || 'CrossRef Article',
            link: doi ? `https://doi.org/${doi}` : (item.URL || ''),
            pubDate: extractCrossRefPubDate(item.issued),
            description: abstract || `${container}${doi ? `, DOI: ${doi}` : ''}`
        };
    }).filter((item) => item.link);
}

function createFingerprint(item) {
    const content = `${item.title || ''}|${item.link || ''}|${item.pubDate || ''}`;
    return crypto.createHash('sha256').update(content).digest('hex');
}

async function fetchWithTimeout(url, ms = 12000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
            throw new Error(`请求失败: ${response.status}`);
        }
        return await response.text();
    } finally {
        clearTimeout(timeout);
    }
}

function buildFallbackSummary(article) {
    const shortDesc = (article.description || '无摘要').slice(0, 280);
    return {
        keyQuestion: `该研究聚焦于：${article.title}`,
        methods: '来源为期刊最新推送，建议进入原文确认研究设计（随机/回顾/队列）与样本量。',
        findings: shortDesc,
        limitations: '仅基于来源接口返回的摘要/元数据自动整理，未读取全文统计细节。',
        clinicalImpact: '可作为术式策略或围术期管理的早期信号，正式决策请以原文与指南为准。',
        polishedCn: `【外科瓣膜速递】${article.title}\n要点：${shortDesc}\n建议：结合科室病例结构评估可迁移性。`,
        disclaimer: '以下内容由AI辅助整理，不替代临床判断，以原文为准。'
    };
}

async function summarizeWithAI(article) {
    if (!process.env.OPENAI_API_KEY) {
        return buildFallbackSummary(article);
    }

    const payload = {
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        response_format: { type: 'json_object' },
        messages: [
            {
                role: 'system',
                content: '你是心外科瓣膜文献助手。只能基于提供内容总结，不得编造。输出JSON字段：keyQuestion, methods, findings, limitations, clinicalImpact, polishedCn, disclaimer。'
            },
            {
                role: 'user',
                content: `标题: ${article.title}\n发布时间:${article.pubDate}\n链接:${article.link}\n摘要:${article.description || '无'}`
            }
        ]
    };

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`AI接口失败: ${response.status} ${errorText}`);
    }

    const result = await response.json();
    const content = result?.choices?.[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    return {
        keyQuestion: parsed.keyQuestion || '',
        methods: parsed.methods || '',
        findings: parsed.findings || '',
        limitations: parsed.limitations || '',
        clinicalImpact: parsed.clinicalImpact || '',
        polishedCn: parsed.polishedCn || '',
        disclaimer: parsed.disclaimer || '以下内容由AI辅助整理，不替代临床判断，以原文为准。'
    };
}

async function syncValveSources() {
    const activeSources = valveTool.sources.filter((source) => source.active);
    let created = 0;
    const errors = [];

    for (const source of activeSources) {
        try {
            let parsedItems = [];

            if (source.id === 'pubmed') {
                parsedItems = await fetchPubMedItems();
            } else if (source.id === 'crossref') {
                parsedItems = await fetchCrossRefItems();
            } else if (source.type === 'rss') {
                const xmlText = await fetchWithTimeout(source.url);
                parsedItems = parseRss(xmlText);
            }

            parsedItems.forEach((item) => {
                const fingerprint = createFingerprint(item);
                if (valveTool.articleFingerprints.has(fingerprint)) {
                    return;
                }

                const article = {
                    id: `article_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
                    sourceId: source.id,
                    sourceName: source.name,
                    title: item.title,
                    link: item.link,
                    pubDate: item.pubDate,
                    description: item.description,
                    fingerprint,
                    status: 'new',
                    aiSummary: null,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString()
                };

                valveTool.articleFingerprints.add(fingerprint);
                valveTool.articles.unshift(article);
                created += 1;
            });
        } catch (error) {
            errors.push({ source: source.name, message: error.message });
        }
    }

    return {
        created,
        totalArticles: valveTool.articles.length,
        errors
    };
}

function formatEmailContent(article) {
    const summary = article.aiSummary || buildFallbackSummary(article);
    return `${summary.polishedCn}\n\n研究问题: ${summary.keyQuestion}\n方法: ${summary.methods}\n结论: ${summary.findings}\n局限性: ${summary.limitations}\n临床意义: ${summary.clinicalImpact}\n原文: ${article.link}\n${summary.disclaimer}`;
}

async function sendDigestEmail({ toEmail, article }) {
    const cfg = getEmailConfig();
    if (!cfg.fromEmail) {
        throw new Error('邮件配置不完整，请设置 FROM_EMAIL，并确保系统存在 sendmail 命令');
    }

    const subject = `外科瓣膜文献速递 | ${article.title}`;
    const text = formatEmailContent(article);
    const mail = `From: ${cfg.fromEmail}
To: ${toEmail}
Subject: ${subject}
Content-Type: text/plain; charset=UTF-8

${text}
`;

    return await new Promise((resolve, reject) => {
        const proc = spawn('sendmail', ['-t', '-i']);
        let stderr = '';

        proc.on('error', (error) => {
            reject(new Error(`调用sendmail失败: ${error.message}`));
        });

        proc.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`sendmail发送失败(code=${code}): ${stderr || '未知错误'}`));
                return;
            }
            resolve({ subject, messageId: `sendmail_${Date.now()}` });
        });

        proc.stdin.write(mail);
        proc.stdin.end();
    });
}

app.get('/api/valve_tool/config', (req, res) => {
    const cfg = getEmailConfig();
    res.json({
        ownerEmail: cfg.ownerEmail || '',
        mailReady: Boolean(cfg.fromEmail)
    });
});

// 获取来源
app.get('/api/valve_tool/sources', (req, res) => {
    res.json(valveTool.sources);
});

// 手动同步来源
app.post('/api/valve_tool/sources/sync', async (req, res) => {
    try {
        const result = await syncValveSources();
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 查询文章
app.get('/api/valve_tool/articles', (req, res) => {
    const { status = 'all', limit = '20' } = req.query;
    const size = Number(limit);
    const filtered = status === 'all'
        ? valveTool.articles
        : valveTool.articles.filter((item) => item.status === status);

    res.json(filtered.slice(0, Number.isNaN(size) ? 20 : size));
});

// AI总结单篇文章
app.post('/api/valve_tool/articles/:id/summarize', async (req, res) => {
    const article = valveTool.articles.find((item) => item.id === req.params.id);
    if (!article) {
        return res.status(404).json({ error: '文章不存在' });
    }

    try {
        article.aiSummary = await summarizeWithAI(article);
        article.status = 'summarized';
        article.updatedAt = new Date().toISOString();
        return res.json({ success: true, article });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// 仅发送到邮箱（你自己的邮箱）
app.post('/api/valve_tool/send_email', async (req, res) => {
    const { articleId, email } = req.body;
    const cfg = getEmailConfig();
    const targetEmail = email || cfg.ownerEmail;

    if (!articleId) {
        return res.status(400).json({ error: '缺少articleId' });
    }

    if (!targetEmail) {
        return res.status(400).json({ error: '缺少收件邮箱，请在请求中传email或设置OWNER_EMAIL' });
    }

    const article = valveTool.articles.find((item) => item.id === articleId);
    if (!article) {
        return res.status(404).json({ error: '文章不存在' });
    }

    try {
        if (!article.aiSummary) {
            article.aiSummary = await summarizeWithAI(article);
            article.status = 'summarized';
        }

        const mailResult = await sendDigestEmail({ toEmail: targetEmail, article });

        const delivery = {
            id: `delivery_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
            articleId: article.id,
            toEmail: targetEmail,
            status: 'sent',
            subject: mailResult.subject,
            messageId: mailResult.messageId,
            sentAt: new Date().toISOString()
        };

        valveTool.deliveries.unshift(delivery);
        article.status = 'delivered';
        article.updatedAt = new Date().toISOString();

        return res.json({ success: true, delivery });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// 发送日志
app.get('/api/valve_tool/logs', (req, res) => {
    res.json(valveTool.deliveries.slice(0, 100));
});

// 启动后做一次轻量同步（失败不影响服务）
setTimeout(() => {
    syncValveSources().catch((error) => {
        console.warn('初始化同步失败:', error.message);
    });
}, 1500);

// 每6小时自动同步
setInterval(() => {
    syncValveSources().catch((error) => {
        console.warn('定时同步失败:', error.message);
    });
}, 6 * 60 * 60 * 1000);

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`服务器运行在 http://localhost:${PORT}`);
});
