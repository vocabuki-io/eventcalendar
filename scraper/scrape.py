import json, asyncio, os
from playwright.async_api import async_playwright

TARGET_USER = "vocabuki"   # 対象アカウントのXのID
TARGET_TAG  = "ボカブキイベント"

async def scrape():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        ctx = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await ctx.new_page()

        # ログイン（レート制限回避のため）
        username = os.environ.get("X_USERNAME")
        password = os.environ.get("X_PASSWORD")
        if username and password:
            await page.goto("https://x.com/i/flow/login", wait_until="networkidle")
            await page.wait_for_timeout(2000)
            await page.fill('input[autocomplete="username"]', username)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(1500)
            await page.fill('input[type="password"]', password)
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(3000)

        # 対象ユーザーのページを開く
        await page.goto(f"https://x.com/{TARGET_USER}", wait_until="networkidle")
        await page.wait_for_timeout(4000)

        posts = []
        articles = await page.query_selector_all("article")

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

        # 既存データとマージ（重複排除）
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

        print(f"追加: {len(posts)}件 / 合計: {len(merged)}件")

asyncio.run(scrape())
