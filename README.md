# VOCABUKI EVENT CALENDAR

ボカロ専門ナイトクラブ **ボカブキ**（歌舞伎町 Gest32ビル 5F）のイベントカレンダー。
GitHub Pages で公開している静的サイトです。

🔗 https://vocabuki-io.github.io/eventcalendar/

## このリポジトリの中身

| パス | 役割 |
| --- | --- |
| `index.html` | 公開カレンダー。月／週／リスト表示、イベント詳細、About、イベント診断 |
| `admin.html` | 管理画面。ブラウザから `events.json` を編集して GitHub にコミットする |
| `events.json` | **唯一のデータ源**。イベント・タグ・出演者・休業日をまとめて持つ |
| `mcp/` | Claude から MCP 経由でカレンダーを編集するサーバー |
| `docs/OPERATIONS.md` | 運営ガイドと改善提案 |
| `scraper/`, `.github/workflows/scrape.yml` | X の告知ポストを取得する仕組み（→ [運営ガイド 4-2](docs/OPERATIONS.md#4-2-スクレイパーの扱いを決める優先度-中)） |

ビルド不要です。React と Babel を CDN から読み込み、ブラウザ上で JSX を変換して動きます。

## イベントを登録する

**Claude から**（詳細・画像・リンクまで一度に入ります）

```
9/5 に「ボカ戻せ」を追加して。DJ は @nono4e と @005_900、
OPEN 23:30 CLOSE 5:00、料金は 2000円（1D込）。
詳細に「今回はボカロ100%です」、予約フォームのリンクも付けて。
```

セットアップは [mcp/README.md](mcp/README.md) を参照してください。

**管理画面から**

`admin.html` を開いてログイン → 週を選んで編集 → カード内の「保存」→ **画面上部の「保存」**。

どちらも同じ `events.json` を編集します。同時に触っても、後から書いた方が先の変更を消すことはありません。

## 開発

```bash
# ローカルで開く
python3 -m http.server 8000     # → http://localhost:8000/index.html

# MCP サーバーのテスト（ネットワークにも本番リポジトリにも触れません）
node mcp/test/run-tests.mjs
```
