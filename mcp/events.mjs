// events.json のイベントを組み立て・検証するロジック。
// index.html / admin.html が読むスキーマと 1:1 で対応させること。

export class ValidationError extends Error {}

// update_event の clear で消せるフィールド（date/title/id は必須なので対象外）
export const CLEARABLE_FIELDS = [
  'openTime',
  'closeTime',
  'venue',
  'price',
  'description',
  'flyer',
  'images',
  'links',
  'xurl',
  'tags',
  'djs',
  'vjs',
];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;

export function assertDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw new ValidationError(`date は YYYY-MM-DD 形式で指定してください（受信値: ${JSON.stringify(date)}）。`);
  }
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ValidationError(`存在しない日付です: ${date}`);
  }
  return date;
}

function assertTime(value, field) {
  const v = String(value).trim();
  // 深夜営業なので 24:00 / 26:00 のような 24 時超え表記も許容する。
  if (!TIME_RE.test(v)) {
    throw new ValidationError(`${field} は "HH:MM" 形式で指定してください（受信値: ${JSON.stringify(value)}）。`);
  }
  const [h, mi] = v.split(':').map(Number);
  if (h > 29 || mi > 59) throw new ValidationError(`${field} の時刻が範囲外です: ${v}`);
  return `${h}:${String(mi).padStart(2, '0')}`;
}

/** 画面側の safeUrl と同じ判定。javascript: などを弾く。 */
export function assertUrl(value, field, { allowRelative = false } = {}) {
  const v = String(value == null ? '' : value).trim();
  if (!v) throw new ValidationError(`${field} が空です。`);
  if (/^https?:\/\//i.test(v)) return v;
  if (allowRelative && /^[\w.][\w./-]*$/.test(v) && !v.startsWith('//')) return v;
  throw new ValidationError(
    `${field} は http(s):// で始まる URL${allowRelative ? '、またはリポジトリ内の相対パス' : ''}を指定してください（受信値: ${JSON.stringify(value)}）。`,
  );
}

function cleanText(value, field) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} は文字列で指定してください。`);
  }
  return value.replace(/\r\n/g, '\n').trim();
}

function normalizeStringArray(value, field) {
  if (!Array.isArray(value)) throw new ValidationError(`${field} は配列で指定してください。`);
  const out = [];
  for (const item of value) {
    const v = typeof item === 'string' ? item.trim() : '';
    if (!v) throw new ValidationError(`${field} の要素は空でない文字列である必要があります。`);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 出演者の指定を people のキー（X の ID）に正規化する。
 * "005_900" / "@005_900" / {id:"005_900", name:"なぴ"} のいずれも受け付ける。
 * 未登録の人物は people に追加する（admin.html と同じ挙動）。
 */
export function normalizePerformers(value, field, people) {
  if (!Array.isArray(value)) throw new ValidationError(`${field} は配列で指定してください。`);
  const ids = [];
  for (const item of value) {
    let id;
    let name;
    if (typeof item === 'string') {
      id = item;
    } else if (item && typeof item === 'object') {
      id = item.id || item.x || item.handle;
      name = item.name;
    }
    id = String(id == null ? '' : id).trim().replace(/^@/, '');
    if (!id) throw new ValidationError(`${field} の要素に X の ID がありません。`);
    if (!/^\w{1,30}$/.test(id)) {
      throw new ValidationError(`${field} の X ID が不正です: ${JSON.stringify(id)}`);
    }
    if (!people[id]) people[id] = { name: (name && String(name).trim()) || id, x: '@' + id };
    else if (name && String(name).trim() && people[id].name === id) people[id].name = String(name).trim();
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function normalizeImages(value) {
  if (!Array.isArray(value)) throw new ValidationError('images は配列で指定してください。');
  return value.map((item, i) => {
    const raw = typeof item === 'string' ? { url: item } : item || {};
    const url = assertUrl(raw.url, `images[${i}].url`, { allowRelative: true });
    const caption = raw.caption == null ? '' : cleanText(raw.caption, `images[${i}].caption`);
    return caption ? { url, caption } : { url };
  });
}

function normalizeLinks(value) {
  if (!Array.isArray(value)) throw new ValidationError('links は配列で指定してください。');
  return value.map((item, i) => {
    const raw = typeof item === 'string' ? { url: item } : item || {};
    const url = assertUrl(raw.url, `links[${i}].url`);
    const label = raw.label == null ? '' : cleanText(raw.label, `links[${i}].label`);
    return { label: label || url, url };
  });
}

/**
 * ツール引数から events.json に書き込むフィールド群を作る。
 * 空文字・空配列は「未設定」として落とし、公開側では既定値にフォールバックさせる。
 */
export function buildEventFields(input, people, { partial = false } = {}) {
  const out = {};

  if (input.date !== undefined) out.date = assertDate(input.date);
  else if (!partial) throw new ValidationError('date は必須です。');

  if (input.title !== undefined) {
    const title = cleanText(input.title, 'title');
    if (!title) throw new ValidationError('title を空にはできません。');
    out.title = title;
  } else if (!partial) {
    throw new ValidationError('title は必須です。');
  }

  if (input.tags !== undefined) out.tags = normalizeStringArray(input.tags, 'tags');
  if (input.djs !== undefined) out.djs = normalizePerformers(input.djs, 'djs', people);
  if (input.vjs !== undefined) out.vjs = normalizePerformers(input.vjs, 'vjs', people);

  if (input.openTime !== undefined) out.openTime = assertTime(input.openTime, 'openTime');
  if (input.closeTime !== undefined) out.closeTime = assertTime(input.closeTime, 'closeTime');

  for (const field of ['venue', 'price', 'description']) {
    if (input[field] !== undefined) {
      const v = cleanText(input[field], field);
      if (v) out[field] = v;
      else delete out[field];
    }
  }

  if (input.flyer !== undefined && input.flyer !== null && input.flyer !== '') {
    out.flyer = assertUrl(input.flyer, 'flyer', { allowRelative: true });
  }
  if (input.xurl !== undefined && input.xurl !== null && input.xurl !== '') {
    out.xurl = assertUrl(input.xurl, 'xurl');
  }
  if (input.images !== undefined) {
    const imgs = normalizeImages(input.images);
    if (imgs.length) out.images = imgs;
  }
  if (input.links !== undefined) {
    const lnks = normalizeLinks(input.links);
    if (lnks.length) out.links = lnks;
  }
  if (input.comingSoon !== undefined) out.comingSoon = Boolean(input.comingSoon);

  return out;
}

export function newEventId(date, title) {
  const slug = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 12);
  const stamp = String(date || '').replace(/-/g, '');
  const rand = Math.random().toString(36).slice(2, 6);
  return ['ev', stamp, slug || 'event', rand].filter(Boolean).join('_');
}

export function eventKey(ev) {
  return ev.id || ev.date;
}

export function findEvent(data, id) {
  const idx = data.events.findIndex((e) => eventKey(e) === id);
  return { idx, event: idx === -1 ? null : data.events[idx] };
}

export function sortEvents(data) {
  data.events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

/** 同じ日に同じタイトルのイベントがあれば拒否する（admin.html の保存時チェックと同じ）。 */
export function assertNoDuplicate(data, date, title, ignoreId) {
  const clash = data.events.find(
    (e) => e.date === date && e.title === title && eventKey(e) !== ignoreId,
  );
  if (clash) {
    throw new ValidationError(
      `同じ日に同名のイベントが既にあります: "${title}" (${date}, id=${eventKey(clash)})。` +
        ' 更新なら update_event を使ってください。',
    );
  }
}

export function knownTagIds(data) {
  return (data.tags || []).map((t) => t.id);
}

export function summarizeEvent(ev) {
  return {
    id: eventKey(ev),
    date: ev.date,
    title: ev.title,
    tags: ev.tags || [],
    djs: (ev.djs || []).length,
    vjs: (ev.vjs || []).length,
    comingSoon: Boolean(ev.comingSoon),
    hasFlyer: Boolean(ev.flyer),
    images: (ev.images || []).length,
    links: (ev.links || []).length,
    hasDescription: Boolean(ev.description),
  };
}
