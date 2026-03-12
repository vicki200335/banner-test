# 外科瓣膜顶刊自动邮件工具（简化版）

按你的要求，当前版本已简化为：

1. 自动同步两个来源：PubMed + CrossRef。
2. AI 提炼文章要点（未配置 OpenAI Key 时自动使用 fallback 文案）。
3. 只发送到你自己的邮箱（不再对接企业微信/飞书等下游系统）。

## 1. 环境要求

- Node.js 18+（建议 20+）
- npm
- 系统安装 `sendmail` 命令（用于真正发送邮件）

## 2. 安装依赖

```bash
npm install
```

## 3. 邮件环境变量配置

```bash
export FROM_EMAIL=your_sender@example.com
export OWNER_EMAIL=yourname@example.com
```

说明：

- `OWNER_EMAIL` 是默认收件邮箱。前端留空邮箱时会自动使用它。
- 发送时后端调用系统 `sendmail -t -i`，请确保机器上已有可用的 sendmail 配置。

## 4. 启动服务

```bash
npm start
```

默认端口 `3000`。

## 5. 页面使用

打开：

- `http://localhost:3000/valve_digest_tool.html`

操作顺序：

1. 点击「立即同步」拉取最新文章。
2. 选择一篇文章。
3. 点击「AI提炼所选文章」（可选，不点也会在发信前自动提炼）。
4. 输入你的邮箱（或留空用 `OWNER_EMAIL`）。
5. 点击「发送到我的邮箱」。

## 6. API（仅保留邮件流程）

### 6.1 查看邮件配置状态

```bash
curl http://localhost:3000/api/valve_tool/config
```

### 6.2 同步来源

```bash
curl -X POST http://localhost:3000/api/valve_tool/sources/sync
```

### 6.3 查看文章

```bash
curl "http://localhost:3000/api/valve_tool/articles?status=all&limit=10"
```

### 6.4 AI 提炼单篇文章

```bash
curl -X POST http://localhost:3000/api/valve_tool/articles/<articleId>/summarize
```

### 6.5 发送到邮箱

```bash
curl -X POST http://localhost:3000/api/valve_tool/send_email \
  -H "Content-Type: application/json" \
  -d '{"articleId":"<articleId>","email":"yourname@example.com"}'
```

> `email` 可省略，省略时使用 `OWNER_EMAIL`。

### 6.6 查看发送日志

```bash
curl http://localhost:3000/api/valve_tool/logs
```

## 7. AI 配置（可选）

如需调用 OpenAI：

```bash
export OPENAI_API_KEY=your_key
export OPENAI_MODEL=gpt-4o-mini
```

未配置 `OPENAI_API_KEY` 时，系统会自动使用 fallback 摘要。

## 8. 注意事项

- 当前是 MVP，数据内存存储，重启服务会丢失。
- PubMed / CrossRef 接口可用性依赖第三方服务状态与限流策略。
- AI 内容仅作辅助，不替代临床判断。
