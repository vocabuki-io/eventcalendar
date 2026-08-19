# VOCABUKI Calendar MCP サーバー

Claude から MCP 経由で、イベントカレンダー (`events.json`) に**イベントの詳細・画像・URLリンクを直接**登録するためのサーバーです。

- 依存パッケージ **なし**（`npm install` 不要）。Node.js 18 以上があれば動きます。
- GitHub Contents API 経由で `events.json` をコミットします。GitHub Pages に 1〜2 分で反映されます。
- `admin.html` と同じデータ・同じ検証ルールを使うので、どちらから編集しても壊れません。

---

## 1. セットアップ

### 1-1. GitHub トークンを用意する

[fine-grained personal access token](https://github.com/settings/personal-access-tokens) を作成します。

| 項目 | 設定 |
| --- | --- |
| Repository access | `vocabuki-io/eventcalendar` のみ |
| Permissions → Contents | **Read and write** |
| Expiration | 90日など、短めを推奨 |

> トークンはこのリポジトリの内容を書き換えられます。`admin.html` のパスワードとは別物で、こちらが実質的な鍵です。他人に渡さない／漏れたら即 revoke してください。

### 1-2. Claude Desktop に登録する

設定ファイル（macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`、Windows: `%APPDATA%\Claude\claude_desktop_config.json`）に追記します。

```json
{
  "mcpServers": {
    "vocabuki-calendar": {
      "command": "node",
      "args": ["/絶対パス/eventcalendar/mcp/server.mjs"],
      "env": {
        "GITHUB_TOKEN": "github_pat_xxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

保存して Claude Desktop を再起動すると、ツール一覧に `vocabuki-calendar` が現れます。

### 1-3. Claude Code に登録する場合

```bash
claude mcp add vocabuki-calendar \
  --env GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxx \
  -- node /絶対パス/eventcalendar/mcp/server.mjs
```

### 1-4. 環境変数

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `GITHUB_TOKEN` | （必須） | Contents: Read and write 権限のトークン |
| `GITHUB_OWNER` | `vocabuki-io` | リポジトリのオーナー |
| `GITHUB_REPO` | `eventcalendar` | リポジトリ名 |
| `GITHUB_BRANCH` | `main` | 書き込み先ブランチ |
| `EVENTS_PATH` | `events.json` | イベントデータのパス |
| `IMAGES_DIR` | `images` | `upload_image` の保存先ディレクトリ |
| `MAX_IMAGE_BYTES` | `8388608`（8MB） | 画像 1 枚の上限 |
| `VOCABUKI_READONLY` | （未設定） | `1` にすると読み取り専用。動作確認用 |

**まず安全に試したいとき**は `VOCABUKI_READONLY=1` を付けて起動してください。`list_events` などの読み取りだけ動き、書き込みは全て拒否されます。
**下書きで試したいとき**は `GITHUB_BRANCH` を別ブランチにすると、公開サイトに反映されません。

---

## 2. 使えるツール

| ツール | 用途 |
| --- | --- |
| `list_events` | イベント一覧・検索（日付範囲、キーワード） |
| `get_event` | イベント 1 件を全フィールド取得 |
| `create_event` | イベントを新規追加 |
| `update_event` | 既存イベントを部分更新（追記・削除も可） |
| `delete_event` | イベントを削除（イベント名の確認が必要） |
| `upload_image` | 画像をリポジトリに保存し、設定用のパスを返す |
| `list_meta` | タグ一覧・休業日・登録済み出演者などのマスタ情報 |

### イベントのフィールド

`date` と `title` 以外はすべて任意です。未設定のフィールドは公開ページで既定値にフォールバックします。

| フィールド | 型 | 説明 |
| --- | --- | --- |
| `date` | `"2026-09-05"` | 開催日（必須） |
| `title` | 文字列 | イベント名（必須） |
| `tags` | 文字列配列 | タグ ID。最初の色付きタグがカレンダーの色になる |
| `djs` / `vjs` | 配列 | X の ID（`"nono4e"` / `"@nono4e"` / `{"id":"nono4e","name":"乃々瀬"}`）。未登録なら自動登録 |
| `openTime` / `closeTime` | `"23:30"` | 深夜営業なので `24:00` `26:00` も可。既定は 24:00 / 5:00 |
| `venue` | 文字列 | 既定は「歌舞伎町 Gest32ビル 5F」 |
| `price` | 文字列 | 例 `"¥2,000 (1D込)"` |
| `description` | 文字列 | **イベント詳細**。改行はそのまま表示される |
| `flyer` | 文字列 | フライヤー画像の URL、または `upload_image` が返すパス |
| `images` | `[{url, caption}]` | **ギャラリー画像**。詳細画面でタップ拡大できる |
| `links` | `[{label, url}]` | **URLリンク**。予約フォーム・チケットなど |
| `xurl` | 文字列 | 告知ポスト（X）の URL |
| `comingSoon` | 真偽値 | `true` で「COMING SOON」表示になり出演者を伏せる |

`javascript:` などの危険な URL は登録時に拒否され、万一データに混ざっても公開ページ側で描画されません。

---

## 3. 使い方の例

Claude にそのまま日本語で頼めます。

> 9/5 に「ボカ戻せ」を追加して。DJ は @nono4e と @005_900、OPEN 23:30 CLOSE 5:00、料金は 2000円（1D込）。
> 詳細に「今回はボカロ100%です」と入れて、予約フォーム https://example.com/r をリンクに付けて。

> このフライヤー画像を 9/5 のイベントに設定して。
> （画像ファイルのパスを渡すか、URL を伝える）

> 9/5 のイベントに、前回の様子の写真を 2 枚ギャラリーに追加して。

> 来月のイベント一覧を出して。

### 内部的な流れ（画像を付ける場合）

1. `upload_image` → `images/xxxx.jpg` というパスが返る
2. `create_event` / `update_event` の `flyer` または `images[].url` にそのパスを渡す

`upload_image` は JPEG / PNG / GIF / WebP のみ受け付け、実データの先頭バイトで形式を判定します（拡張子は信用しません）。

---

## 4. 同時編集について

`admin.html` と MCP から同時に保存しても、後勝ちで上書きすることはありません。
GitHub が競合（409）を返した場合、サーバーは最新の `events.json` を読み直して変更を当て直し、最大 4 回まで再試行します。

---

## 5. テスト

```bash
node mcp/test/run-tests.mjs
```

GitHub API をインメモリのスタブに差し替えて動くので、**ネットワークにも本物のリポジトリにも一切触れません**。
スキーマ検証・各ツールの動作・競合再試行・MCP プロトコル（stdio）まで確認します。

---

## 6. 困ったとき

| 症状 | 対処 |
| --- | --- |
| `設定エラー: GITHUB_TOKEN が...` | 環境変数が渡っていない。Claude Desktop の設定ファイルの `env` を確認 |
| `GitHub エラー: ... 404` | トークンの Repository access にこのリポジトリが入っていない |
| `GitHub エラー: ... 403` | Contents 権限が Read only になっている |
| `入力エラー: 同じ日に同名のイベントが...` | 既存イベントの更新なら `update_event` を使う |
| 反映されない | GitHub Pages のビルド待ち（1〜2 分）。ブラウザの再読み込みも試す |
