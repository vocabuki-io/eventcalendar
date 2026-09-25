# Cloudflare への移行手順（vocabuki.com）

GitHub Pages（public リポジトリ）から、**private リポジトリ + Cloudflare Pages** に移すための手順です。
画面の名前やボタンの位置は変わることがあるので、見つからないときは近い名前のものを探してください。

```
[private] vocabuki-io/eventcalendar ──(Cloudflare Pages: npm run site)──▶ https://vocabuki.com
   全データ・下書き・管理用ファイル                     dist/ の中身だけ（公開してよいもの）
```

`npm run site` が `dist/` に書き出すもの（`site.mjs`）:

- `index.html` / `admin.html` / `js/` / `images/` / `fabicon.png`
- 絞り込んだ `events.json`
  - `draft: true` のイベントは出さない
  - COMING SOON のイベントは出演者・フライヤー・リンク・説明を落とす（日付とタイトルだけ）
  - `people` は公開イベントに出る人とスタッフだけ
  - `watchAccounts` など画面が使わないキーは出さない

---

## 1. ドメインを取る（お名前.com）

1. お名前.com で `vocabuki.com` を取得する
   - Whois 情報公開代行は **ON** のまま（個人情報を出さないため）
   - 同時に勧められるサーバーやオプションは不要
2. 取得できたら次へ（DNS の設定はまだ触らなくてよい）

## 2. Cloudflare にドメインを追加する

1. Cloudflare ダッシュボード → **Add a domain（サイトを追加）** → `vocabuki.com` → Free プラン
2. Cloudflare が表示する **ネームサーバー 2 つ**（`xxx.ns.cloudflare.com`）を控える
3. お名前.com の「ネームサーバーの変更」→「その他のネームサーバー」に、その 2 つを入れる
4. Cloudflare 側で「Active」になるまで待つ（数分〜最大 24 時間）

## 3. Cloudflare Pages とリポジトリをつなぐ

1. Cloudflare ダッシュボード → **Workers & Pages** → Create → **Pages** → Connect to Git
2. GitHub 連携を許可し、`vocabuki-io/eventcalendar` を選ぶ
3. ビルド設定

   | 項目 | 値 |
   | --- | --- |
   | Production branch | `main` |
   | Framework preset | None |
   | Build command | `npm run site` |
   | Build output directory | `dist` |
   | 環境変数 `NODE_VERSION` | `20` |

4. デプロイが終わると `https://<名前>.pages.dev` で見られる → **ここで一度、表示と動作を確認**

## 4. リポジトリを private にする

`pages.dev` で問題なく見られることを確認してから。

1. GitHub → `vocabuki-io/eventcalendar` → Settings → 一番下の **Change visibility** → Private
2. GitHub Pages（`vocabuki-io.github.io/eventcalendar`）はこの時点で見られなくなる（無料プランでは private の Pages は使えないため）
3. 管理画面・MCP はそのまま動く（今の PAT はこのリポジトリを指定していれば private でも有効）

> `vocabuki-io/Flyers` も public のままです。10〜12 月の予定名など内部の情報が入っているので、必要なら同じく private にしてください。

## 5. ドメインを Pages に付ける

1. Workers & Pages → このプロジェクト → **Custom domains** → Set up a domain
2. `vocabuki.com` を追加（同じ Cloudflare アカウントなので DNS は自動で設定される）
3. 必要なら `www.vocabuki.com` も追加し、`vocabuki.com` へリダイレクト

## 6. 管理画面に Google ログインを付ける（Cloudflare Access）

`/admin.html` を開くと、先に Cloudflare のログイン画面が出て、**「Google」ボタン**で入れるようになります。
許可したメールアドレスの人しか管理画面にたどり着けません（無料枠: 50 人まで）。

1. Cloudflare ダッシュボード → **Zero Trust**（初回はチーム名を決める。例: `vocabuki` → `vocabuki.cloudflareaccess.com`）
2. Google 側の準備（Google Cloud Console）
   1. プロジェクトを作成 → 「API とサービス」→「OAuth 同意画面」を外部・テスト中で作成
   2. 「認証情報」→「OAuth クライアント ID」→ 種類「ウェブ アプリケーション」
   3. 承認済みのリダイレクト URI に `https://<チーム名>.cloudflareaccess.com/cdn-cgi/access/callback`
   4. 表示された **クライアント ID** と **シークレット** を控える
3. Zero Trust → Settings → Authentication → Login methods → Add new → **Google** → 2 の ID とシークレットを入れる
4. Zero Trust → Access → Applications → Add → **Self-hosted**
   - Application domain: `vocabuki.com`、Path: `admin.html`
   - Identity providers: Google だけにチェック（「Instant Auth」を ON にすると Cloudflare の画面を飛ばして Google に直行する）
   - Policy: Action = Allow、Include = Emails → 管理する人のメールアドレス
   - Session duration: 1 か月など長めにすると、スマホで毎回ログインしなくて済む

いまの管理画面のパスワードと GitHub の PAT は、この後もそのまま必要です。
（Google ログインだけで保存まで済むようにするには、PAT を Cloudflare 側に預ける仕組みが別途必要。→ 今後の検討）
