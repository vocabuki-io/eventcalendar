// src/*.jsx を変換して js/*.js に書き出し、HTML の <script src="js/*.js?v=..."> を更新する。
//   npm run build          … 変換して書き出す
//   npm run build -- --check … 書き出し済みのファイルが最新かだけ確かめる（CI 用）
import fs from 'node:fs';
import crypto from 'node:crypto';
import { transform } from 'esbuild';

const PAGES = ['index', 'admin'];
// 古めの iPhone でも動くように。
const TARGET = ['es2019', 'safari13'];
const check = process.argv.includes('--check');
let stale = [];

for (const page of PAGES) {
  const src = fs.readFileSync(`src/${page}.jsx`, 'utf8');
  const { code } = await transform(src, {
    loader: 'jsx',
    jsx: 'transform',
    target: TARGET,
    minify: true,
    legalComments: 'none',
    sourcefile: `src/${page}.jsx`,
  });
  const out = `js/${page}.js`;
  // ファイル名は変えずに ?v= で内容のハッシュを付け、ブラウザのキャッシュを確実に切り替える。
  const hash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 10);
  const htmlPath = `${page}.html`;
  const html = fs.readFileSync(htmlPath, 'utf8');
  const tagRe = new RegExp(`<script src="js/${page}\\.js(\\?v=[0-9a-f]+)?"></script>`);
  if (!tagRe.test(html)) throw new Error(`${htmlPath} に <script src="js/${page}.js"> が見つかりません`);
  const newHtml = html.replace(tagRe, `<script src="js/${page}.js?v=${hash}"></script>`);

  if (check) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
    if (current !== code) stale.push(out);
    if (newHtml !== html) stale.push(htmlPath);
  } else {
    fs.mkdirSync('js', { recursive: true });
    fs.writeFileSync(out, code);
    fs.writeFileSync(htmlPath, newHtml);
    console.log(`${out}  ${(code.length / 1024).toFixed(1)} KB  (v=${hash})`);
  }
}

if (check && stale.length) {
  console.error(`ビルド結果が古くなっています: ${stale.join(', ')}\nnpm run build を実行してコミットしてください。`);
  process.exit(1);
}
