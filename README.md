# 外科瓣膜行业更新单页应用（Flask）

## 终端预览链接
服务启动后，浏览器打开：
- `http://127.0.0.1:3000/`
- 或 `http://127.0.0.1:3000/valve_digest_tool.html`

> 如果你在远程开发环境（如 VS Code Remote / 云端容器），请把 **3000 端口**做端口转发，再访问转发后的预览链接。

## 一键启动（推荐）
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install flask requests feedparser
python3 app.py
```

## 配置说明（你只需要改这些）
在启动前设置以下环境变量：

```bash
# 1) 大模型
export API_KEY="你的大模型API Key"
export LLM_BASE_URL="https://api.openai.com/v1/chat/completions"   # 如用其他供应商，改为其兼容地址
export LLM_MODEL="gpt-4o-mini"

# 2) 邮件 SMTP
export SMTP_SERVER="smtp.gmail.com"
export SMTP_PORT="587"
export SENDER_EMAIL="你的发件邮箱"
export SENDER_PASSWORD="你的邮箱授权码/应用专用密码"
```

### 邮箱怎么配
1. 登录你的邮箱后台，开启 SMTP。
2. 生成“应用专用密码”或“授权码”（不要用登录密码）。
3. 把授权码填到 `SENDER_PASSWORD`。
4. 前端页面底部输入收件人邮箱，点击“发送邮件”。

## RSS 源配置
`app.py` 顶部有 `INDUSTRY_RSS_FEEDS`，已预置 TCTMD、Medscape 及厂家源。你拿到更准确的官方 XML 后，直接替换列表即可。

## 当前接口
- `POST /api/fetch_and_process`：抓取近 30 天数据、去重排序、取前 15 条并调用模型处理。
- `POST /api/send_email`：将处理结果以 HTML 邮件发送到收件人。

## 备注
- 若未配置 `API_KEY`，系统会返回 fallback 内容（不会中断流程）。
- 所有外部请求都带有异常处理，单个来源失败不会导致整个任务中断。
