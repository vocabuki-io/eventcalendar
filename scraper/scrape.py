import json, asyncio, os, re
from datetime import datetime
from playwright.async_api import async_playwright

TARGET_USER = "vocabuki"
TARGET_TAG  = "ボカブキイベント"
REPLY_FETCH_THRESHOLD = 3


def parse_date(text: str) -> str | None:
    m = re.search(r'(\d{4})/(\d{1,2})/(\d{1,2})', text)
    if m:
        y, mo, d = m.groups()
        return f"{y}-{int(mo):02d}-{int(d):02d}"
    m = re.search(r'(\d{2})/(\d{1,2})/(\d{1,2})', text)
    if m:
        y, mo, d = m.groups()
        return f"20{y}-{int(mo):02d}-{int(d):02d}"
    m = re.search(r'🗓[^\d]*(\d{1,2})/(\d{1,2})', text)
    if m:
        mo, d = int(m.group(1)), int(m.group(2))
        now = datetime.now()
        year = now.year
        if mo < now.month or (mo == now.month and d < now.day):
            year += 1
        return f"{year}-{mo:02d}-{d:02d}"
    return None


def parse_time(text: str) -> str | None:
    m = re.search(r'🗓[^\n]*?(\d{1,2}):(\d{2})', text)
    if m:
        return f"{int(m.group(1)):02d}:{m.group(2)}"
    m = re.search(r'(?:OPEN|START|開場|開演)[^\d]*(\d{1,2}):(\d{2})', text, re.IGNORECASE)
    if m:
        return f"{int(m.group(1)):02d}:{m.group(2)}"
    return None


def extract_performers_from_text(text: str) -> dict:
    sections = {'djs': [], 'vjs': [], 'staff': []}
    current = None
    for line in text.splitlines():
        l = line.strip()
        if re.search(r'\bDJ\b|🎧', l, re.IGNORECASE):
            current = 'djs'
        elif re.search(r'\bVJ\b|📺', l, re.IGNORECASE):
            current = 'vjs'
        elif re.search(r'STAFF|💫|スタッフ|CREW|クルー', l, re.IGNORECASE):
            current = 'staff'
        elif current:
            m = re.search(r'(.+?)\s+@(\S+)', l)
            if m:
                name = m.group(1).strip()
                xid  = m.group(2).rstrip('）).,')
                sections[current].append({'name': name, 'x': '@' + xid})
    return sections


def extract_xids_from_text(text: str) -> set:
    return set(re.findall(r'@(\w+)', text))


def merge_performers(base: dict, extra: dict) -> dict:
    result = {}
    for role in ('djs', 'vjs', 'staff'):
        seen   = {p['x'] for p in base.get(role, [])}
        merged = list(base.get(role, []))
        for p in extra.get(role, []):
            if p['x'] not in seen:
                merged.append(p)
                seen.add(p['x'])
        result[role] = merged
    return result


def total_performers(perf: dict) -> int:
    return sum(len(v) for v in perf.values())


def parse_event(text: str) -> dict:
    tags    = re.findall(r'#([^\s#　]+)', text)
    exclude = {'ボカブキ', 'ボカブキイベント'}
    title   = next((t for t in tags if t not in exclude), None)

    date_line = ""
    m = re.search(r'🗓[^\n]+', text)
    if m:
        date_line = m.group(0)

    price = None
    m = re.search(r'💰\s*([^\n]+)', text)
    if m:
        price = m.group(1).strip()

    performers = extract_performers_from_text(text)

    return {
        'title':      title,
        'date':       parse_date(date_line or text),
        'start_time': parse_time(date_line or text),
        'price':      price,
        'performers': performers,
    }


async def fetch_reply_performers(page, post_url: str, op_handle: str) -> dict:
    sections = {'djs': [], 'vjs': [], 'staff': []}
    try:
        await page.goto(post_url, wait_until="domcontentloaded")
        await page.wait_for_timeout(4000)

        articles = await page.query_selector_all("article")
        if len(articles) <= 1:
            return sections

        current_role = None

        for article in articles[1:]:
            handle_el = await article.query_selector('[data-testid="User-Name"] a[href^="/"]')
            if not handle_el:
                continue
            href = await handle_el.get_attribute("href")
            reply_handle = href.strip("/").lower()

            # OPと同じアカウントのリプのみ（別アカは絶対スキップ）
            if reply_handle != op_handle.lower():
                continue

            text_el = await article.query_selector("[data-testid='tweetText']")
            if not text_el:
                continue
            reply_text = await text_el.inner_text()

            for line in reply_text.splitlines():
                l = line.strip()
                if re.search(r'\bDJ\b|🎧', l, re.IGNORECASE):
                    current_role = 'djs'
                elif re.search(r'\bVJ\b|📺', l, re.IGNORECASE):
                    current_role = 'vjs'
                elif re.search(r'STAFF|💫|スタッフ|CREW|クルー', l, re.IGNORECASE):
                    current_role = 'staff'
                elif current_role:
                    m = re.search(r'(.+?)\s+@(\S+)', l)
                    if m:
                        name = m.group(1).strip()
                        xid  = m.group(2).rstrip('）).,')
                        sections[current_role].append({'name': name, 'x': '@' + xid})

    except Exception as e:
        print(f"  リプライ取得エラー: {e}")

    return sections


async def login(page, username, password):
    await page.goto("https://x.com/i/flow/login", wait_until="domcontentloaded")
    await page.wait_for_timeout(3000)
    await page.wait_for_selector('input[autocomplete="username"]', timeout=15000)
    await page.fill('input[autocomplete="username"]', username)
    await page.keyboard.press("Enter")
    await page.wait_for_timeout(2000)

    for _ in range(3):
        await page.wait_for_timeout(1500)
        if await page.query_selector('input[type="password"]'):
            await page.fill('input[type="password"]', password)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(3000)
            break
        for sel in ['input[data-testid="ocfEnterTextTextInput"]', 'input[type="text"]']:
            el = await page.query_selector(sel)
            if el:
                await el.fill(username)
                await page.keyboard.press("Enter")
                break

    print("ログイン完了")


async def scrape():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = await ctx.new_page()
        page.set_default_timeout(60000)

        username = os.environ.get("X_USERNAME")
        password = os.environ.get("X_PASSWORD")
        if username and password:
            await login(page, username, password)

        await page.goto(f"https://x.com/{TARGET_USER}", wait_until="domcontentloaded")
        await page.wait_for_timeout(5000)
        print(f"現在のURL: {page.url}")

        articles = await page.query_selector_all("article")
        print(f"取得した article 数: {len(articles)}")

        raw_posts = []
        for article in articles:
            text_el = await article.query_selector("[data-testid='tweetText']")
            time_el = await article.query_selector("time")
            link_el = await article.query_selector("a[href*='/status/']")
            if not text_el:
                continue
            text = await text_el.inner_text()
            if TARGET_TAG not in text:
                continue

            img_els    = await article.query_selector_all("img[src*='pbs.twimg.com/media']")
            image_urls = []
            for img in img_els:
                src = await img.get_attribute("src")
                if src:
                    src = re.sub(r'\?.*$', '?format=jpg&name=large', src)
                    image_urls.append(src)

            post_url = ""
            if link_el:
                href     = await link_el.get_attribute("href")
                post_url = "https://x.com" + href

            raw_posts.append({
                'text':       text,
                'time':       await time_el.get_attribute("datetime") if time_el else "",
                'url':        post_url,
                'image_urls': image_urls,
            })

        # 既存データ読み込み
        try:
            with open("posts.json") as f:
                existing = json.load(f)
        except:
            existing = []

        existing_urls = {p["url"] for p in existing}
        new_posts     = [p for p in raw_posts if p["url"] not in existing_urls]
        print(f"新規ポスト: {len(new_posts)}件")

        for post in new_posts:
            parsed = parse_event(post['text'])
            print(f"  解析: {parsed['title']} / {parsed['date']}")

            op_performer_count = total_performers(parsed['performers'])
            op_xid_count       = len(extract_xids_from_text(post['text']))

            # 演者が少ない場合はリプライも取得
            if post['url'] and (op_performer_count < REPLY_FETCH_THRESHOLD or op_xid_count < REPLY_FETCH_THRESHOLD):
                print(f"  → リプライ取得 (OP演者:{op_performer_count}人, xid:{op_xid_count}個)")
                reply_perf = await fetch_reply_performers(page, post['url'], TARGET_USER)
                parsed['performers'] = merge_performers(parsed['performers'], reply_perf)
                # タイムラインに戻る
                await page.goto(f"https://x.com/{TARGET_USER}", wait_until="domcontentloaded")
                await page.wait_for_timeout(3000)

            post['parsed'] = parsed
            print(f"    DJ:{len(parsed['performers']['djs'])} VJ:{len(parsed['performers']['vjs'])} STAFF:{len(parsed['performers']['staff'])}")

        merged = existing + new_posts
        merged.sort(key=lambda x: x['time'], reverse=True)

        with open("posts.json", "w") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)

        print(f"完了: 合計 {len(merged)}件")

        await browser.close()


asyncio.run(scrape())
