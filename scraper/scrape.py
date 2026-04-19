import json, asyncio, os
from playwright.async_api import async_playwright

TARGET_USER = "vocabuki"
TARGET_TAG  = "ボカブキイベント"

async def login(page, username, password):
    await page.goto("https://x.com/i/flow/login", wait_until="domcontentloaded")
    await page.wait_for_timeout(3000)

    # Step1: ユーザー名
    await page.wait_for_selector('input[autocomplete="username"]', timeout=15000)
    await page.fill('input[autocomplete="username"]', username)
    await page.keyboard.press("Enter")
    await page.wait_for_timeout(2000)

    # Step2: パスワード or 追加確認画面のどちらが来ても対応
    for _ in range(3):
        await page.wait_for_timeout(1500)

        if await page.query_selector('input[type="password"]'):
            await page.fill('input[type="password"]', password)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(3000)
            break

        # 「電話番号 or ユーザー名」確認画面
        if await page.query_selector('input[data-testid="ocfEnterTextTextInput"]'):
            await page.fill('input[data-testid="ocfEnterTextTextInput"]', username)
            await page.keyboard.press("Enter")
            continue

        # その他の入力欄（テキスト系）が出た場合
        text_input = await page.query_selector('input[type="text"]')
        if text_input:
            await text_input.fill(username)
            await page.keyboard.press("Enter")
            continue

    await page.wait_for_timeout(3000)
    print("ログイン完了")

async def scrape():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = await ctx.new_page()
        page.set_default_timeout(60000)

        username = os.environ.get("X_USERNAME")
        password = os.environ.get("X_PASSWORD")
        if username and password:
            await login(page, username, password)

        # 対象ユーザーページ
        await page.goto(f"https://x.com/{TARGET_USER}", wait_until="domcontentloaded")
        await page.wait_for_timeout(5000)

        # 現在のURLを確認（ログイン失敗でリダイレクトされていないか）
        print(f"現在のURL: {page.url}")

        posts = []
        articles = await page.query_selector_all("article")
        print(f"取得した article 数: {len(articles)}")

        for article in articles:
            text_el = await article.query_selector("[data-testid='tweetText']")
            time_el = await article.query_selector("time")
            link_el = await article.query_selector("a[href*='/status/']")

            if not text_el:
                continue

            text = await text_el.inner_text()
            if TARGET_TAG not in text:
                continue

            posts.append({
                "text": text,
                "time": await time_el.get_attribute("datetime") if time_el else "",
                "url":  "https://x.com" + await link_el.get_attribute("href") if link_el else ""
            })

        await browser.close()

        # 既存データとマージ
        try:
            with open("posts.json") as f:
                existing = json.load(f)
        except:
            existing = []

        urls = {p["url"] for p in existing}
        merged = existing + [p for p in posts if p["url"] not in urls]
        merged.sort(key=lambda x: x["time"], reverse=True)

        with open("posts.json", "w") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)

        print(f"今回マッチ: {len(posts)}件 / 合計: {len(merged)}件")

asyncio.run(scrape())
