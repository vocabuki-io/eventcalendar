#!/usr/bin/env node
// VOCABUKI EVENT CALENDAR — MCP サーバー
//
// Claude から events.json に直接イベント（詳細テキスト・画像・URLリンク）を書き込む。
// 依存パッケージなし。Node 18 以上で動作する。
//
// 起動例:
//   GITHUB_TOKEN=github_pat_xxx node mcp/server.mjs
//
// 詳しい設定は mcp/README.md を参照。

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  loadConfig,
  readEvents,
  commitEvents,
  commitBinary,
  ConfigError,
  GitHubError,
} from './github-store.mjs';
import {
  ValidationError,
  CLEARABLE_FIELDS,
  assertDate,
  assertUrl,
  buildEventFields,
  newEventId,
  eventKey,
  findEvent,
  sortEvents,
  assertNoDuplicate,
  knownTagIds,
  summarizeEvent,
} from './events.mjs';

const SERVER_NAME = 'vocabuki-calendar';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------- 共通スキーマ

const detailProps = {
  openTime: { type: 'string', description: '開場時刻 "HH:MM"。深夜営業のため 24:00 や 26:00 も可。省略時は 24:00 扱い。' },
  closeTime: { type: 'string', description: '終了時刻 "HH:MM"。省略時は 5:00 扱い。' },
  venue: { type: 'string', description: '会場。省略時は「歌舞伎町 Gest32ビル 5F」扱い。' },
  price: { type: 'string', description: '料金の表示文字列。例: "¥2,000 (1D込)"' },
  description: {
    type: 'string',
    description: 'イベント詳細テキスト。改行はそのまま公開ページに表示される。',
  },
  flyer: {
    type: 'string',
    description:
      'フライヤー画像。http(s) URL か、upload_image が返すリポジトリ内の相対パス（例 "images/xxx.jpg"）。',
  },
  images: {
    type: 'array',
    description: 'ギャラリーに並べる追加画像。',
    items: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '画像 URL または upload_image が返す相対パス。' },
        caption: { type: 'string', description: '画像の説明（任意）。' },
      },
      required: ['url'],
    },
  },
  links: {
    type: 'array',
    description: '予約フォーム・チケット・特設ページなどの外部リンク。',
    items: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'ボタンに表示する名前。省略時は URL を表示。' },
        url: { type: 'string', description: 'http(s) の URL。' },
      },
      required: ['url'],
    },
  },
  xurl: { type: 'string', description: 'イベント告知ポスト（X）の URL。' },
  tags: {
    type: 'array',
    items: { type: 'string' },
    description: 'タグ ID の配列。1つ目の色付きタグがカレンダーの色になる。list_meta で一覧を確認できる。',
  },
  djs: {
    type: 'array',
    description: '出演 DJ。X の ID 文字列、または {id, name} オブジェクトの配列。未登録なら people に自動登録する。',
    items: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
          required: ['id'],
        },
      ],
    },
  },
  vjs: {
    type: 'array',
    description: '出演 VJ。指定方法は djs と同じ。',
    items: {
      oneOf: [
        { type: 'string' },
        {
          type: 'object',
          properties: { id: { type: 'string' }, name: { type: 'string' } },
          required: ['id'],
        },
      ],
    },
  },
  comingSoon: {
    type: 'boolean',
    description: 'true にすると公開ページでは「COMING SOON」表示になり、出演者などは伏せられる。',
  },
};

const TOOLS = [
  {
    name: 'list_events',
    description:
      'カレンダーに登録済みのイベントを一覧する。日付範囲やキーワードで絞り込める。イベントを更新・削除する前に id を調べる用途にも使う。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '開始日 YYYY-MM-DD（この日を含む）。' },
        to: { type: 'string', description: '終了日 YYYY-MM-DD（この日を含む）。' },
        query: { type: 'string', description: 'タイトル・タグ・詳細テキストの部分一致検索。' },
        limit: { type: 'integer', description: '返す最大件数（既定 50）。', minimum: 1, maximum: 500 },
      },
    },
  },
  {
    name: 'get_event',
    description: 'イベント 1 件を全フィールド付きで取得する。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'イベント ID。' } },
      required: ['id'],
    },
  },
  {
    name: 'create_event',
    description:
      'カレンダーに新しいイベントを追加し、events.json をコミットする。公開サイトには 1〜2 分で反映される。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '開催日 YYYY-MM-DD。' },
        title: { type: 'string', description: 'イベント名。' },
        ...detailProps,
      },
      required: ['date', 'title'],
    },
  },
  {
    name: 'update_event',
    description:
      '既存イベントを更新する。指定したフィールドだけが変わる。フィールドを消したいときは clear に名前を並べる。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '更新するイベントの ID。' },
        date: { type: 'string', description: '開催日を変更する場合のみ指定。' },
        title: { type: 'string', description: 'イベント名を変更する場合のみ指定。' },
        ...detailProps,
        appendImages: {
          type: 'array',
          description: 'images を置き換えず末尾に追加する。images と同時には指定できない。',
          items: detailProps.images.items,
        },
        appendLinks: {
          type: 'array',
          description: 'links を置き換えず末尾に追加する。links と同時には指定できない。',
          items: detailProps.links.items,
        },
        clear: {
          type: 'array',
          description: `空にするフィールド名の配列。指定できるのは: ${CLEARABLE_FIELDS.join(', ')}`,
          items: { type: 'string', enum: CLEARABLE_FIELDS },
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'delete_event',
    description: 'イベントを削除する。取り違え防止のため title の一致確認が必要。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '削除するイベントの ID。' },
        confirmTitle: {
          type: 'string',
          description: '削除対象のイベント名。登録されている title と完全一致しないと削除しない。',
        },
      },
      required: ['id', 'confirmTitle'],
    },
  },
  {
    name: 'upload_image',
    description:
      'フライヤーやギャラリー用の画像をリポジトリに保存し、イベントに設定できるパスを返す。ローカルファイル・リモート URL・base64 のいずれかを渡す。',
    inputSchema: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: '保存するファイル名（拡張子込み）。省略時は元のファイル名や URL から決める。',
        },
        sourcePath: { type: 'string', description: 'MCP サーバーが動いているマシン上の画像ファイルのパス。' },
        sourceUrl: { type: 'string', description: 'ダウンロード元の http(s) URL。' },
        base64: { type: 'string', description: '画像データの base64 文字列（data URI 形式も可）。filename が必要。' },
      },
    },
  },
  {
    name: 'list_meta',
    description:
      'タグ一覧・休業日・登録済みの出演者など、イベント作成時に必要なマスタ情報を返す。',
    inputSchema: {
      type: 'object',
      properties: {
        includePeople: { type: 'boolean', description: '登録済み出演者も全件返す（既定 false）。' },
      },
    },
  },
];

// ---------------------------------------------------------------- ツール実装

function pagesUrl(cfg, repoPath) {
  return `https://${cfg.owner}.github.io/${cfg.repo}/${repoPath}`;
}

const handlers = {
  async list_events(args, cfg) {
    const { data } = await readEvents(cfg);
    const from = args.from ? assertDate(args.from) : null;
    const to = args.to ? assertDate(args.to) : null;
    const q = (args.query || '').trim().toLowerCase();
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);

    let list = [...data.events];
    if (from) list = list.filter((e) => String(e.date) >= from);
    if (to) list = list.filter((e) => String(e.date) <= to);
    if (q) {
      list = list.filter((e) =>
        [e.title, e.description, ...(e.tags || [])]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(q),
      );
    }
    list.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const total = list.length;
    return {
      total,
      returned: Math.min(total, limit),
      events: list.slice(0, limit).map(summarizeEvent),
    };
  },

  async get_event(args, cfg) {
    const { data } = await readEvents(cfg);
    const { event } = findEvent(data, String(args.id || ''));
    if (!event) throw new ValidationError(`イベントが見つかりません: ${args.id}`);
    return event;
  },

  async create_event(args, cfg) {
    let created = null;
    let unknownTags = [];
    const { commit } = await commitEvents(cfg, (ev) => `Add event ${ev.date} ${ev.title}`, (data) => {
      const fields = buildEventFields(args, data.people, { partial: false });
      assertNoDuplicate(data, fields.date, fields.title, null);
      unknownTags = (fields.tags || []).filter((t) => !knownTagIds(data).includes(t));
      created = {
        id: newEventId(fields.date, fields.title),
        djs: [],
        vjs: [],
        flyer: null,
        comingSoon: false,
        ...fields,
      };
      data.events.push(created);
      sortEvents(data);
      return created;
    });
    return {
      created,
      commit,
      unknownTags,
      note: unknownTags.length
        ? `未登録のタグ ID があります: ${unknownTags.join(', ')}。色を付けたい場合は admin.html のタグ管理で追加してください。`
        : '公開サイトへの反映まで 1〜2 分かかります。',
    };
  },

  async update_event(args, cfg) {
    if (args.images && args.appendImages) {
      throw new ValidationError('images と appendImages は同時に指定できません。');
    }
    if (args.links && args.appendLinks) {
      throw new ValidationError('links と appendLinks は同時に指定できません。');
    }
    let updated = null;
    const { commit } = await commitEvents(cfg, (ev) => `Update event ${ev.date} ${ev.title}`, (data) => {
      const id = String(args.id || '');
      const { idx, event } = findEvent(data, id);
      if (!event) throw new ValidationError(`イベントが見つかりません: ${id}`);

      const merged = { ...event };
      const fields = buildEventFields(args, data.people, { partial: true });

      if (args.appendImages) {
        const extra = buildEventFields({ images: args.appendImages }, data.people, { partial: true });
        fields.images = [...(event.images || []), ...(extra.images || [])];
      }
      if (args.appendLinks) {
        const extra = buildEventFields({ links: args.appendLinks }, data.people, { partial: true });
        fields.links = [...(event.links || []), ...(extra.links || [])];
      }

      Object.assign(merged, fields);
      for (const field of args.clear || []) {
        if (!CLEARABLE_FIELDS.includes(field)) {
          throw new ValidationError(`clear に指定できないフィールドです: ${field}`);
        }
        delete merged[field];
      }
      assertNoDuplicate(data, merged.date, merged.title, eventKey(event));

      data.events[idx] = merged;
      sortEvents(data);
      updated = merged;
      return merged;
    });
    return { updated, commit, note: '公開サイトへの反映まで 1〜2 分かかります。' };
  },

  async delete_event(args, cfg) {
    let removed = null;
    const { commit } = await commitEvents(cfg, (ev) => `Delete event ${ev.date} ${ev.title}`, (data) => {
      const id = String(args.id || '');
      const { idx, event } = findEvent(data, id);
      if (!event) throw new ValidationError(`イベントが見つかりません: ${id}`);
      if (String(args.confirmTitle) !== String(event.title)) {
        throw new ValidationError(
          `confirmTitle が一致しません。登録されているイベント名は "${event.title}" です。`,
        );
      }
      removed = event;
      data.events.splice(idx, 1);
      return event;
    });
    return { deleted: summarizeEvent(removed), commit };
  },

  async upload_image(args, cfg) {
    const sources = ['sourcePath', 'sourceUrl', 'base64'].filter((k) => args[k]);
    if (sources.length !== 1) {
      throw new ValidationError('sourcePath / sourceUrl / base64 のいずれか 1 つだけを指定してください。');
    }

    let buffer;
    let inferredName = '';
    if (args.sourcePath) {
      buffer = await readFile(args.sourcePath);
      inferredName = path.basename(args.sourcePath);
    } else if (args.sourceUrl) {
      const url = assertUrl(args.sourceUrl, 'sourceUrl');
      const res = await fetch(url, { headers: { 'User-Agent': 'vocabuki-calendar-mcp' } });
      if (!res.ok) throw new ValidationError(`画像を取得できませんでした: ${res.status} ${res.statusText}`);
      buffer = Buffer.from(await res.arrayBuffer());
      inferredName = path.basename(new URL(url).pathname) || '';
    } else {
      const raw = String(args.base64).replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
      buffer = Buffer.from(raw, 'base64');
      if (!buffer.length) throw new ValidationError('base64 のデコード結果が空です。');
    }

    if (buffer.length > cfg.maxImageBytes) {
      throw new ValidationError(
        `画像が大きすぎます (${(buffer.length / 1024 / 1024).toFixed(1)}MB)。` +
          `上限は ${(cfg.maxImageBytes / 1024 / 1024).toFixed(0)}MB です（MAX_IMAGE_BYTES で変更可）。` +
          ' 来場者が毎回ダウンロードするので、圧縮してから登録してください。',
      );
    }

    const ext = detectExtension(buffer);
    if (!ext) {
      throw new ValidationError('対応していない画像形式です（JPEG / PNG / GIF / WebP のみ）。');
    }

    // パス要素を落としてから安全な文字だけに畳む。".." や先頭ドットも残さない。
    let name = path.basename(String(args.filename || inferredName || '').trim());
    name = name
      .replace(/[^\w.-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.\-]+|[.\-]+$/g, '');
    if (!name) name = `image-${Date.now()}`;
    if (!/\.[a-z0-9]+$/i.test(name)) name += ext;

    const repoPath = `${cfg.imagesDir}/${name}`;
    const res = await commitBinary(cfg, repoPath, buffer, `Add image ${repoPath}`);
    return {
      path: repoPath,
      bytes: buffer.length,
      replaced: res.replaced,
      commit: res.commit,
      publicUrl: pagesUrl(cfg, repoPath),
      note: `イベントに設定するときは flyer または images[].url に "${repoPath}" をそのまま渡してください。`,
    };
  },

  async list_meta(args, cfg) {
    const { data } = await readEvents(cfg);
    const out = {
      tags: data.tags || [],
      closedDays: data.closedDays || [],
      watchAccounts: data.watchAccounts || [],
      peopleCount: Object.keys(data.people || {}).length,
      eventCount: data.events.length,
      repo: `${cfg.owner}/${cfg.repo}@${cfg.branch}`,
      eventsPath: cfg.eventsPath,
      imagesDir: cfg.imagesDir,
      readOnly: cfg.readOnly,
    };
    if (args.includePeople) out.people = data.people || {};
    return out;
  },
};

// マジックナンバーから拡張子を判定する（拡張子偽装や拡張子なしの入力に備える）
function detectExtension(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return '.png';
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1').startsWith('GIF8')) return '.gif';
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return '.webp';
  return null;
}

// ---------------------------------------------------------------- MCP 配線

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(err) {
  const kind =
    err instanceof ValidationError
      ? '入力エラー'
      : err instanceof ConfigError
        ? '設定エラー'
        : err instanceof GitHubError
          ? 'GitHub エラー'
          : 'エラー';
  return { content: [{ type: 'text', text: `${kind}: ${err.message}` }], isError: true };
}

async function callTool(name, args, cfg) {
  const handler = handlers[name];
  if (!handler) throw new ValidationError(`未知のツールです: ${name}`);
  return handler(args || {}, cfg);
}

function respond(id, result) {
  write({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg, state) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize': {
      const wanted = params && params.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(wanted) ? wanted : SUPPORTED_PROTOCOLS[0];
      respond(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          'VOCABUKI のイベントカレンダー (events.json) を読み書きする。' +
          'イベント追加は create_event、詳細・画像・リンクの追記は update_event、' +
          '画像ファイルの登録は upload_image を使う。',
      });
      return;
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return;
    case 'ping':
      if (!isNotification) respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params && params.name;
      try {
        const cfg = state.getConfig();
        const value = await callTool(name, (params && params.arguments) || {}, cfg);
        respond(id, jsonResult(value));
      } catch (err) {
        respond(id, errorResult(err));
      }
      return;
    }
    default:
      if (!isNotification) respondError(id, -32601, `Method not found: ${method}`);
  }
}

function main() {
  let cachedConfig = null;
  const state = {
    getConfig() {
      if (!cachedConfig) cachedConfig = loadConfig();
      return cachedConfig;
    },
  };

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        respondError(null, -32700, 'Parse error');
        continue;
      }
      handleMessage(msg, state).catch((err) => {
        if (msg && msg.id !== undefined && msg.id !== null) {
          respondError(msg.id, -32603, String((err && err.message) || err));
        } else {
          process.stderr.write(`[${SERVER_NAME}] ${err && err.stack}\n`);
        }
      });
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write(`[${SERVER_NAME}] v${SERVER_VERSION} ready on stdio\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { TOOLS, handlers, handleMessage, detectExtension };
