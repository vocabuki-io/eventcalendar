// Cloudflare Pages 用に、公開してよいものだけを dist/ に書き出す。
//   npm run site   （Cloudflare Pages のビルドコマンド。出力ディレクトリは dist）
//
// リポジトリ本体（private）には全データがあり、ここで絞り込んだものだけが公開される。
//   - draft: true のイベントは出さない
//   - COMING SOON のイベントは、出演者・フライヤー・画像・リンクを落とす（タイトルと日付だけ）
//   - people は公開イベントで使われている人（とスタッフ）だけ
//   - 画面が使わない内部用のキー（watchAccounts など）は出さない
import fs from 'node:fs';
import path from 'node:path';

const OUT = 'dist';
// 公開ページに置くファイル・ディレクトリ。これ以外（src/, mcp/, docs/ など）は出さない。
const COPY = ['index.html', 'admin.html', 'fabicon.png', 'js', 'images'];
const PUBLIC_KEYS = ['events', 'tags', 'dayBgMap', 'closedDays', 'people'];
const HIDDEN_WHEN_COMING_SOON = ['djs', 'vjs', 'flyer', 'images', 'links', 'xurl', 'description', 'price'];
// index.html の STAFF と揃える（詳細画面に常に出るスタッフ）
const STAFF = ['drag_on_3', 'rockstar_saihan', 'aym_pngn'];

export function publicData(data) {
  const events = (data.events || [])
    .filter((e) => !e.draft)
    .map((e) => {
      const { draft, ...ev } = e;
      if (ev.comingSoon) {
        for (const k of HIDDEN_WHEN_COMING_SOON) delete ev[k];
        ev.djs = [];
        ev.vjs = [];
      }
      return ev;
    });
  const used = new Set(STAFF);
  for (const e of events) {
    for (const p of [...(e.djs || []), ...(e.vjs || [])]) used.add(typeof p === 'string' ? p : p && p.id);
  }
  const people = {};
  for (const [id, p] of Object.entries(data.people || {})) if (used.has(id)) people[id] = p;

  const out = {};
  for (const k of PUBLIC_KEYS) if (data[k] !== undefined) out[k] = data[k];
  out.events = events;
  out.people = people;
  return out;
}

function copy(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) copy(path.join(src, f), path.join(dst, f));
  } else {
    fs.copyFileSync(src, dst);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT);
  for (const f of COPY) if (fs.existsSync(f)) copy(f, path.join(OUT, f));
  const data = JSON.parse(fs.readFileSync('events.json', 'utf8'));
  const pub = publicData(data);
  fs.writeFileSync(path.join(OUT, 'events.json'), JSON.stringify(pub) + '\n');
  // 画像はファイル名が変わらない限り中身も変わらないので長くキャッシュさせる
  fs.writeFileSync(path.join(OUT, '_headers'), '/images/*\n  Cache-Control: public, max-age=31536000, immutable\n');
  console.log(`dist/ に書き出しました: イベント ${pub.events.length}/${data.events.length} 件, 出演者 ${Object.keys(pub.people).length}/${Object.keys(data.people || {}).length} 人`);
}
