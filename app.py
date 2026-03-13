import os
import re
import html
import smtplib
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Dict, List, Any

import requests
import feedparser
from flask import Flask, jsonify, request, send_from_directory

app = Flask(__name__, static_folder='.', static_url_path='')

API_KEY = os.getenv('API_KEY', '')
LLM_BASE_URL = os.getenv('LLM_BASE_URL', 'https://api.openai.com/v1/chat/completions')
LLM_MODEL = os.getenv('LLM_MODEL', 'gpt-4o-mini')
SMTP_SERVER = os.getenv('SMTP_SERVER', 'smtp.gmail.com')
SMTP_PORT = int(os.getenv('SMTP_PORT', '587'))
SENDER_EMAIL = os.getenv('SENDER_EMAIL', '')
SENDER_PASSWORD = os.getenv('SENDER_PASSWORD', '')

INDUSTRY_RSS_FEEDS = [
    'https://www.tctmd.com/rss.xml',
    'https://www.medscape.com/public/medscape_rss',
    'https://www.edwards.com/newsroom/rss',
    'https://news.bostonscientific.com/rss',
    'https://www.medtronic.com/us-en/about/news.xml',
    'https://www.abbott.com/corpnewsroom/rss.xml',
]

PUBMED_QUERY = '("Edwards Lifesciences" OR "Inspiris" OR "Resilia" OR "Magna Ease" OR "Mitris" OR "PERIMOUNT") AND ("surgical aortic valve replacement" OR SAVR OR "surgical mitral valve replacement" OR SMVR)'
CROSSREF_QUERY = '("Inspiris" OR "Magna Ease" OR "Mitris" OR "PERIMOUNT" OR "SAVR" OR "SMVR" OR "surgical aortic valve replacement" OR "surgical mitral valve replacement" OR "structural valve deterioration" OR "hemodynamics" OR "COMMENCE trial") AND "valve"'

processed_items: List[Dict[str, Any]] = []


def clean_html(text: str) -> str:
    text = html.unescape(text or '')
    text = re.sub(r'<[^>]+>', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def safe_request_json(url: str, params: Dict[str, Any] = None, timeout: int = 20) -> Dict[str, Any]:
    try:
        response = requests.get(url, params=params, timeout=timeout)
        response.raise_for_status()
        return response.json()
    except Exception:
        return {}


def fetch_pubmed(days: int = 30) -> List[Dict[str, Any]]:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y/%m/%d')
    params = {
        'db': 'pubmed',
        'retmode': 'json',
        'retmax': '60',
        'sort': 'pub+date',
        'term': f'({PUBMED_QUERY}) AND ("{since}"[Date - Publication] : "3000"[Date - Publication])',
    }

    search = safe_request_json('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', params)
    ids = search.get('esearchresult', {}).get('idlist', [])
    if not ids:
        return []

    summary = safe_request_json('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi', {
        'db': 'pubmed', 'retmode': 'json', 'id': ','.join(ids)
    })

    fetch = safe_request_json('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi', {
        'db': 'pubmed', 'retmode': 'xml', 'id': ','.join(ids)
    })
    # efetch xml not parsed here; fallback to available fields
    _ = fetch

    items = []
    for pmid in ids:
        try:
            it = summary.get('result', {}).get(pmid, {})
            title = it.get('title', '').strip()
            pub_date = it.get('pubdate', '')
            authors = ', '.join([a.get('name', '') for a in it.get('authors', []) if a.get('name')])
            items.append({
                'source': 'PubMed',
                'title': title,
                'authors': authors,
                'published_at': pub_date,
                'link': f'https://pubmed.ncbi.nlm.nih.gov/{pmid}/',
                'content': it.get('elocationid', '') or f'PMID: {pmid}',
                'id': f'pubmed-{pmid}',
            })
        except Exception:
            continue
    return items


def crossref_date(issued: Dict[str, Any]) -> str:
    try:
        p = issued.get('date-parts', [[]])[0]
        year, month, day = (p + [1, 1, 1])[:3]
        return datetime(year, month, day, tzinfo=timezone.utc).isoformat()
    except Exception:
        return datetime.now(timezone.utc).isoformat()


def fetch_crossref(days: int = 30) -> List[Dict[str, Any]]:
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%d')
    params = {
        'rows': 60,
        'sort': 'published',
        'order': 'desc',
        'filter': f'from-pub-date:{since}',
        'query': CROSSREF_QUERY,
    }
    data = safe_request_json('https://api.crossref.org/works', params)
    works = data.get('message', {}).get('items', [])
    items = []
    for w in works:
        try:
            title = (w.get('title') or [''])[0]
            doi = w.get('DOI', '')
            link = f'https://doi.org/{doi}' if doi else w.get('URL', '')
            abstract = clean_html(w.get('abstract', '')) if w.get('abstract') else '内容受版权保护，请点击链接查看'
            authors = ', '.join([
                ' '.join(filter(None, [a.get('given', ''), a.get('family', '')])).strip()
                for a in (w.get('author') or [])
            ]).strip(', ')
            items.append({
                'source': 'Crossref',
                'title': title or link,
                'authors': authors,
                'published_at': crossref_date(w.get('issued', {})),
                'link': link,
                'content': abstract,
                'id': f'crossref-{doi or hash(link)}',
            })
        except Exception:
            continue
    return items


def parse_feed_date(entry: Any) -> datetime:
    try:
        if getattr(entry, 'published_parsed', None):
            return datetime(*entry.published_parsed[:6], tzinfo=timezone.utc)
        if getattr(entry, 'updated_parsed', None):
            return datetime(*entry.updated_parsed[:6], tzinfo=timezone.utc)
    except Exception:
        pass
    return datetime.now(timezone.utc)


def fetch_rss(days: int = 30) -> List[Dict[str, Any]]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=days)
    items = []

    for feed_url in INDUSTRY_RSS_FEEDS:
        try:
            feed = feedparser.parse(feed_url)
            source_title = getattr(feed.feed, 'title', 'Industry RSS')
            for entry in feed.entries:
                pub_dt = parse_feed_date(entry)
                if pub_dt < cutoff:
                    continue
                summary = clean_html(getattr(entry, 'summary', '') or getattr(entry, 'description', ''))
                items.append({
                    'source': source_title,
                    'title': getattr(entry, 'title', ''),
                    'authors': getattr(entry, 'author', ''),
                    'published_at': pub_dt.isoformat(),
                    'link': getattr(entry, 'link', ''),
                    'content': summary,
                    'id': f"rss-{hash(getattr(entry, 'link', '') + getattr(entry, 'title', ''))}",
                })
        except Exception:
            continue

    return items


def parse_date_safe(raw: str) -> datetime:
    try:
        if re.match(r'^\d{4}-\d{2}-\d{2}', raw):
            return datetime.fromisoformat(raw.replace('Z', '+00:00'))
        return datetime.fromisoformat(raw)
    except Exception:
        return datetime.now(timezone.utc)


def rewrite_with_llm(item: Dict[str, Any]) -> str:
    prompt = f"""请严格按照以下 Markdown 模板输出，且只能基于输入内容，不得补充未知事实：
1. 标题（英文原版 + 中文翻译）
2. 发布时间与来源
3. 内容摘要/核心数据（中文提炼版）
4. 关键点（最重要三条临床数据、实验终点或商业动态）
5. 对爱德华外科瓣膜的启示（无关联写“无直接关联”）
6. 原文链接（必须与输入链接一致）

输入：
标题：{item.get('title','')}
来源：{item.get('source','')}
发布时间：{item.get('published_at','')}
作者：{item.get('authors','')}
文本：{item.get('content','')}
链接：{item.get('link','')}
"""
    if not API_KEY:
        return (
            f"### 1) 标题（英文原版 + 中文翻译）\n- {item.get('title','')}\n- 中文：{item.get('title','')}\n\n"
            f"### 2) 发布时间与来源\n- {item.get('published_at','')} | {item.get('source','')}\n\n"
            f"### 3) 内容摘要/核心数据（中文提炼版）\n- {item.get('content','')[:260]}\n\n"
            "### 4) 关键点\n- 信息待补充\n- 信息待补充\n- 信息待补充\n\n"
            "### 5) 对爱德华外科瓣膜的启示\n- 无直接关联\n\n"
            f"### 6) 原文链接\n- {item.get('link','')}"
        )

    headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {API_KEY}'}
    payload = {
        'model': LLM_MODEL,
        'messages': [
            {'role': 'system', 'content': '你是医疗信息编辑助手，严格遵循格式输出 Markdown。'},
            {'role': 'user', 'content': prompt},
        ],
        'temperature': 0.2,
    }
    try:
        r = requests.post(LLM_BASE_URL, json=payload, headers=headers, timeout=40)
        r.raise_for_status()
        return r.json().get('choices', [{}])[0].get('message', {}).get('content', '模型返回为空')
    except Exception as e:
        return f"模型处理失败：{e}\n\n原文链接：{item.get('link','')}"


def markdown_to_html(md: str) -> str:
    text = html.escape(md)
    text = re.sub(r'^###\s(.+)$', r'<h3>\1</h3>', text, flags=re.M)
    text = re.sub(r'^-\s(.+)$', r'<li>\1</li>', text, flags=re.M)
    text = text.replace('\n', '<br/>')
    text = text.replace('<br/><li>', '<li>').replace('</li><br/>', '</li>')
    text = re.sub(r'(<li>.*?</li>)', r'<ul>\1</ul>', text, flags=re.S)
    return text


def send_email(recipient: str, items: List[Dict[str, Any]]) -> None:
    if not (SMTP_SERVER and SMTP_PORT and SENDER_EMAIL and SENDER_PASSWORD):
        raise RuntimeError('SMTP 配置不完整')

    body_md = '\n\n---\n\n'.join([x.get('processed_markdown', '') for x in items])
    body_html = f"<html><body><h2>外科瓣膜近30天更新</h2>{markdown_to_html(body_md)}</body></html>"

    msg = MIMEMultipart('alternative')
    msg['Subject'] = f'外科瓣膜行业更新（{datetime.now().strftime("%Y-%m-%d")})'
    msg['From'] = SENDER_EMAIL
    msg['To'] = recipient
    msg.attach(MIMEText(body_md, 'plain', 'utf-8'))
    msg.attach(MIMEText(body_html, 'html', 'utf-8'))

    with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=30) as server:
        server.starttls()
        server.login(SENDER_EMAIL, SENDER_PASSWORD)
        server.sendmail(SENDER_EMAIL, [recipient], msg.as_string())


@app.route('/')
def root():
    return send_from_directory('.', 'valve_digest_tool.html')


@app.post('/api/fetch_and_process')
def fetch_and_process():
    global processed_items
    try:
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(fetch_pubmed), pool.submit(fetch_crossref), pool.submit(fetch_rss)]
            merged = []
            for fut in as_completed(futures):
                try:
                    merged.extend(fut.result())
                except Exception:
                    continue

        dedup: Dict[str, Dict[str, Any]] = {}
        for item in merged:
            key = (item.get('link') or '') + '|' + (item.get('title') or '')
            if key and key not in dedup:
                dedup[key] = item

        sorted_items = sorted(dedup.values(), key=lambda x: parse_date_safe(x.get('published_at', '')), reverse=True)[:15]
        for item in sorted_items:
            item['processed_markdown'] = rewrite_with_llm(item)

        processed_items = sorted_items
        return jsonify({'success': True, 'count': len(processed_items), 'items': processed_items})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@app.post('/api/send_email')
def send_email_api():
    try:
        recipient = (request.json or {}).get('recipient', '').strip()
        if not recipient:
            return jsonify({'success': False, 'error': '请填写收件人邮箱'}), 400
        if not processed_items:
            return jsonify({'success': False, 'error': '请先获取并处理最新更新'}), 400

        send_email(recipient, processed_items)
        return jsonify({'success': True, 'message': '邮件发送成功'})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=3000, debug=False)
