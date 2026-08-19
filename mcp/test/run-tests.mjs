#!/usr/bin/env node
// MCP サーバーのテスト。GitHub API をインメモリのスタブに差し替えて実行するので
// ネットワークにも本物のリポジトリにも一切触れない。
//
//   node mcp/test/run-tests.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { handlers } from '../server.mjs';
import { loadConfig } from '../github-store.mjs';
import { buildEventFields, assertDate } from '../events.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'server.mjs');

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL ${name}\n       ${err && err.message}`);
  }
}

async function rejects(fn, match, message) {
  let threw = null;
  try {
    await fn();
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, message || 'エラーが発生しませんでした');
  if (match) assert.match(threw.message, match);
  return threw;
}

// ------------------------------------------------------------ GitHub スタブ

function makeStubGitHub(initialData) {
  const files = new Map();
  const commits = [];
  let shaCounter = 0;
  const nextSha = () => `sha${++shaCounter}`;

  files.set('events.json', {
    content: Buffer.from(JSON.stringify(initialData, null, 2), 'utf8'),
    sha: nextSha(),
  });

  const stub = async (url, opts = {}) => {
    const u = new URL(typeof url === 'string' ? url : url.toString());
    if (u.hostname !== 'api.github.com') {
      // upload_image の sourceUrl 取得。1x1 の PNG を返す。
      if (u.pathname.endsWith('.png')) {
        return new Response(PNG_1PX, { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }
    const m = u.pathname.match(/^\/repos\/[^/]+\/[^/]+\/contents\/(.+)$/);
    assert.ok(m, `想定外のパス: ${u.pathname}`);
    const filePath = decodeURIComponent(m[1]);
    const method = opts.method || 'GET';

    if (method === 'GET') {
      const f = files.get(filePath);
      if (!f) return jsonResponse({ message: 'Not Found' }, 404);
      return jsonResponse({ content: f.content.toString('base64'), sha: f.sha, path: filePath });
    }
    if (method === 'PUT') {
      const body = JSON.parse(opts.body);
      const existing = files.get(filePath);
      if (existing && body.sha !== existing.sha) {
        return jsonResponse({ message: 'does not match' }, 409);
      }
      if (!existing && body.sha) return jsonResponse({ message: 'sha given for new file' }, 422);
      const sha = nextSha();
      files.set(filePath, { content: Buffer.from(body.content, 'base64'), sha });
      commits.push({ path: filePath, message: body.message, branch: body.branch });
      return jsonResponse({ content: { path: filePath, sha }, commit: { html_url: `https://github.test/${sha}` } });
    }
    return jsonResponse({ message: 'unsupported' }, 400);
  };

  stub.files = files;
  stub.commits = commits;
  stub.readEvents = () => JSON.parse(files.get('events.json').content.toString('utf8'));
  return stub;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function baseData() {
  return {
    events: [
      {
        id: 'ev_20260109_doubleo',
        date: '2026-01-09',
        title: '00（ダブルオー）',
        tags: ['vocabuki'],
        djs: ['drag_on_3'],
        vjs: [],
        flyer: null,
        xurl: null,
        comingSoon: false,
      },
    ],
    tags: [
      { id: 'vocabuki', label: 'ボカブキ', color: '#F5E642' },
      { id: 'anime', label: 'アニメ', color: '#E63946' },
    ],
    dayBgMap: {},
    closedDays: [],
    people: { drag_on_3: { name: 'dragon3', x: '@drag_on_3' } },
  };
}

function makeCfg(overrides = {}) {
  return loadConfig({
    GITHUB_TOKEN: 'test-token',
    GITHUB_OWNER: 'vocabuki-io',
    GITHUB_REPO: 'eventcalendar',
    ...overrides,
  });
}

async function withStub(data, fn, cfgOverrides) {
  const stub = makeStubGitHub(data);
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn(stub, makeCfg(cfgOverrides));
  } finally {
    globalThis.fetch = real;
  }
}

// ------------------------------------------------------------ テスト本体

console.log('\nスキーマ検証');

await test('date は YYYY-MM-DD を要求する', async () => {
  assert.equal(assertDate('2026-09-05'), '2026-09-05');
  await rejects(async () => assertDate('2026/09/05'), /YYYY-MM-DD/);
  await rejects(async () => assertDate('2026-02-30'), /存在しない日付/);
});

await test('javascript: URL は拒否する', async () => {
  const people = {};
  await rejects(
    async () => buildEventFields({ date: '2026-09-05', title: 'x', links: [{ url: 'javascript:alert(1)' }] }, people),
    /http\(s\)/,
  );
  await rejects(
    async () => buildEventFields({ date: '2026-09-05', title: 'x', images: [{ url: 'javascript:alert(1)' }] }, people),
    /http\(s\)/,
  );
});

await test('upload_image が返す相対パスは flyer / images に使える', () => {
  const people = {};
  const f = buildEventFields(
    { date: '2026-09-05', title: 'x', flyer: 'images/a.jpg', images: [{ url: 'images/b.png' }] },
    people,
  );
  assert.equal(f.flyer, 'images/a.jpg');
  assert.deepEqual(f.images, [{ url: 'images/b.png' }]);
});

await test('空文字の任意フィールドは書き込まない', () => {
  const f = buildEventFields({ date: '2026-09-05', title: 'x', venue: '   ', price: '' }, {});
  assert.ok(!('venue' in f));
  assert.ok(!('price' in f));
});

await test('出演者は @ 付き / オブジェクトどちらでも受けて people に登録する', () => {
  const people = {};
  const f = buildEventFields(
    { date: '2026-09-05', title: 'x', djs: ['@nono4e', { id: 'aym_pngn', name: 'あゆむ' }, 'nono4e'] },
    people,
  );
  assert.deepEqual(f.djs, ['nono4e', 'aym_pngn']); // 重複は除去
  assert.deepEqual(people.nono4e, { name: 'nono4e', x: '@nono4e' });
  assert.deepEqual(people.aym_pngn, { name: 'あゆむ', x: '@aym_pngn' });
});

await test('時刻は 24 時超え表記を許す', () => {
  const f = buildEventFields({ date: '2026-09-05', title: 'x', openTime: '24:00', closeTime: '5:00' }, {});
  assert.equal(f.openTime, '24:00');
  assert.equal(f.closeTime, '5:00');
});

console.log('\nツール');

await test('list_events は日付とキーワードで絞り込む', async () => {
  const data = baseData();
  data.events.push({ id: 'ev_b', date: '2026-03-01', title: 'Shadow Night', tags: ['external'], djs: [], vjs: [] });
  await withStub(data, async (stub, cfg) => {
    const all = await handlers.list_events({}, cfg);
    assert.equal(all.total, 2);
    const filtered = await handlers.list_events({ from: '2026-02-01' }, cfg);
    assert.equal(filtered.total, 1);
    assert.equal(filtered.events[0].title, 'Shadow Night');
    const searched = await handlers.list_events({ query: 'shadow' }, cfg);
    assert.equal(searched.total, 1);
  });
});

await test('create_event が詳細・画像・リンクごと書き込む', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    const res = await handlers.create_event(
      {
        date: '2026-09-05',
        title: 'テストナイト',
        tags: ['vocabuki'],
        djs: ['nono4e'],
        openTime: '23:00',
        closeTime: '5:00',
        venue: 'テスト会場',
        price: '¥2,000 (1D込)',
        description: '1行目\n2行目',
        images: [{ url: 'https://example.com/a.jpg', caption: '会場' }],
        links: [{ label: '予約', url: 'https://example.com/r' }],
        xurl: 'https://x.com/vocabuki/status/1',
      },
      cfg,
    );
    assert.match(res.created.id, /^ev_20260905_/);
    const saved = stub.readEvents();
    const ev = saved.events.find((e) => e.title === 'テストナイト');
    assert.equal(ev.description, '1行目\n2行目');
    assert.equal(ev.images[0].caption, '会場');
    assert.equal(ev.links[0].label, '予約');
    assert.equal(ev.venue, 'テスト会場');
    assert.deepEqual(ev.djs, ['nono4e']);
    assert.equal(saved.people.nono4e.x, '@nono4e');
    // 日付順に並び替えて保存される
    assert.deepEqual(saved.events.map((e) => e.date), ['2026-01-09', '2026-09-05']);
    assert.match(stub.commits.at(-1).message, /Add event 2026-09-05/);
  });
});

await test('create_event は同日同名を拒否する', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    await rejects(
      () => handlers.create_event({ date: '2026-01-09', title: '00（ダブルオー）' }, cfg),
      /同名のイベント/,
    );
    assert.equal(stub.commits.length, 0, '拒否時はコミットしない');
  });
});

await test('create_event は未登録タグを警告として返す', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    const res = await handlers.create_event({ date: '2026-09-06', title: 'ｘ', tags: ['nosuchtag'] }, cfg);
    assert.deepEqual(res.unknownTags, ['nosuchtag']);
  });
});

await test('update_event は指定フィールドだけ変更する', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    await handlers.update_event({ id: 'ev_20260109_doubleo', description: '追記した詳細' }, cfg);
    const ev = stub.readEvents().events[0];
    assert.equal(ev.description, '追記した詳細');
    assert.equal(ev.title, '00（ダブルオー）', 'title は据え置き');
    assert.deepEqual(ev.djs, ['drag_on_3'], 'djs は据え置き');
  });
});

await test('update_event の appendImages / appendLinks は既存に追記する', async () => {
  const data = baseData();
  data.events[0].images = [{ url: 'https://example.com/1.jpg' }];
  await withStub(data, async (stub, cfg) => {
    await handlers.update_event(
      {
        id: 'ev_20260109_doubleo',
        appendImages: [{ url: 'https://example.com/2.jpg', caption: '2枚目' }],
        appendLinks: [{ label: 'チケット', url: 'https://example.com/t' }],
      },
      cfg,
    );
    const ev = stub.readEvents().events[0];
    assert.equal(ev.images.length, 2);
    assert.equal(ev.images[1].caption, '2枚目');
    assert.equal(ev.links.length, 1);
  });
});

await test('update_event の images と appendImages の同時指定は拒否する', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    await rejects(
      () =>
        handlers.update_event(
          { id: 'ev_20260109_doubleo', images: [{ url: 'https://e.test/a.jpg' }], appendImages: [{ url: 'https://e.test/b.jpg' }] },
          cfg,
        ),
      /同時に指定できません/,
    );
  });
});

await test('update_event の clear でフィールドを消せる', async () => {
  const data = baseData();
  data.events[0].description = '消される';
  data.events[0].links = [{ label: 'x', url: 'https://e.test' }];
  await withStub(data, async (stub, cfg) => {
    await handlers.update_event({ id: 'ev_20260109_doubleo', clear: ['description', 'links'] }, cfg);
    const ev = stub.readEvents().events[0];
    assert.ok(!('description' in ev));
    assert.ok(!('links' in ev));
  });
});

await test('update_event は未知のイベントを拒否する', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    await rejects(() => handlers.update_event({ id: 'ev_nope', title: 'x' }, cfg), /見つかりません/);
  });
});

await test('delete_event は confirmTitle 不一致なら消さない', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    await rejects(
      () => handlers.delete_event({ id: 'ev_20260109_doubleo', confirmTitle: '違う名前' }, cfg),
      /confirmTitle が一致しません/,
    );
    assert.equal(stub.readEvents().events.length, 1);
    await handlers.delete_event({ id: 'ev_20260109_doubleo', confirmTitle: '00（ダブルオー）' }, cfg);
    assert.equal(stub.readEvents().events.length, 0);
  });
});

await test('upload_image は base64 を保存して相対パスを返す', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    const res = await handlers.upload_image({ base64: PNG_1PX.toString('base64'), filename: 'flyer' }, cfg);
    assert.equal(res.path, 'images/flyer.png', '拡張子を実データから補う');
    assert.equal(res.replaced, false);
    assert.ok(stub.files.has('images/flyer.png'));
    assert.equal(res.publicUrl, 'https://vocabuki-io.github.io/eventcalendar/images/flyer.png');
  });
});

await test('upload_image は sourceUrl からも取り込む', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    const res = await handlers.upload_image({ sourceUrl: 'https://example.com/pic.png' }, cfg);
    assert.equal(res.path, 'images/pic.png');
  });
});

await test('upload_image は画像でないデータを拒否する', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    await rejects(
      () => handlers.upload_image({ base64: Buffer.from('not an image').toString('base64'), filename: 'x' }, cfg),
      /対応していない画像形式/,
    );
  });
});

await test('upload_image はサイズ上限を超えたら拒否する', async () => {
  await withStub(
    baseData(),
    async (stub, cfg) => {
      await rejects(
        () => handlers.upload_image({ base64: PNG_1PX.toString('base64'), filename: 'x' }, cfg),
        /大きすぎます/,
      );
    },
    { MAX_IMAGE_BYTES: '10' },
  );
});

await test('upload_image はファイル名をサニタイズする', async () => {
  await withStub(baseData(), async (stub, cfg) => {
    const res = await handlers.upload_image(
      { base64: PNG_1PX.toString('base64'), filename: '../../etc/passwd' },
      cfg,
    );
    assert.equal(res.path, 'images/passwd.png');
    assert.ok(!res.path.includes('..'), 'ディレクトリを遡れない');
    assert.ok(!res.path.includes('/etc/'), '絶対パスにならない');
  });
});

await test('VOCABUKI_READONLY のとき書き込みを拒否する', async () => {
  await withStub(
    baseData(),
    async (stub, cfg) => {
      await rejects(() => handlers.create_event({ date: '2026-09-09', title: 'x' }, cfg), /READONLY/);
      assert.equal(stub.commits.length, 0);
    },
    { VOCABUKI_READONLY: '1' },
  );
});

await test('書き込み競合 (409) は読み直して再試行する', async () => {
  const stub = makeStubGitHub(baseData());
  const real = globalThis.fetch;
  let firstPut = true;
  globalThis.fetch = async (url, opts = {}) => {
    if ((opts.method || 'GET') === 'PUT' && firstPut) {
      firstPut = false;
      // 別クライアントが先に書いた状況を作る
      const data = stub.readEvents();
      data.events.push({ id: 'ev_other', date: '2026-05-05', title: '他人の編集', djs: [], vjs: [] });
      stub.files.set('events.json', {
        content: Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
        sha: 'sha-moved',
      });
      return jsonResponse({ message: 'does not match' }, 409);
    }
    return stub(url, opts);
  };
  try {
    const cfg = makeCfg();
    await handlers.create_event({ date: '2026-09-05', title: 'あとから' }, cfg);
    const saved = stub.readEvents();
    const titles = saved.events.map((e) => e.title);
    assert.ok(titles.includes('他人の編集'), '先行編集を上書きしない');
    assert.ok(titles.includes('あとから'), '自分の追加も残る');
  } finally {
    globalThis.fetch = real;
  }
});

await test('GITHUB_TOKEN 未設定なら分かるエラーを出す', async () => {
  await rejects(async () => loadConfig({}), /GITHUB_TOKEN/);
});

console.log('\nMCP プロトコル (stdio)');

await test('initialize / tools/list / 未知メソッドに正しく応答する', async () => {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, GITHUB_TOKEN: 'test-token' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });

  const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'ping' });
  send({ jsonrpc: '2.0', id: 4, method: 'no/such/method' });

  await new Promise((r) => setTimeout(r, 700));
  child.stdin.end();
  child.kill();

  const init = responses.find((r) => r.id === 1);
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.equal(init.result.serverInfo.name, 'vocabuki-calendar');

  const list = responses.find((r) => r.id === 2);
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'create_event',
    'delete_event',
    'get_event',
    'list_events',
    'list_meta',
    'update_event',
    'upload_image',
  ]);
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} に inputSchema が要る`);
    assert.ok(tool.description, `${tool.name} に description が要る`);
  }

  assert.deepEqual(responses.find((r) => r.id === 3).result, {});
  assert.equal(responses.find((r) => r.id === 4).error.code, -32601);
  assert.ok(!responses.some((r) => r.id === undefined || r.id === null), '通知には応答しない');
});

await test('tools/call のエラーは isError 付きの結果で返す', async () => {
  const child = spawn(process.execPath, [serverPath], {
    // トークンなし = 設定エラーになるケース
    env: { ...process.env, GITHUB_TOKEN: '', VOCABUKI_GITHUB_TOKEN: '' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const responses = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    buf += c;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) responses.push(JSON.parse(line));
    }
  });
  child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_meta', arguments: {} } }) + '\n',
  );
  await new Promise((r) => setTimeout(r, 700));
  child.stdin.end();
  child.kill();

  const res = responses.find((r) => r.id === 1);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /GITHUB_TOKEN/);
});

// ------------------------------------------------------------ 結果

console.log(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  for (const f of failures) console.error(`FAIL ${f.name}\n${f.err && f.err.stack}\n`);
  process.exit(1);
}
