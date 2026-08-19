// GitHub Contents API 経由で events.json と画像ファイルを読み書きする薄いラッパー。
// 依存パッケージなし（Node 18+ の fetch を使用）。

const API = 'https://api.github.com';

export class ConfigError extends Error {}
export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function loadConfig(env = process.env) {
  const token = (env.GITHUB_TOKEN || env.VOCABUKI_GITHUB_TOKEN || '').trim();
  if (!token) {
    throw new ConfigError(
      'GITHUB_TOKEN が設定されていません。events.json への書き込み権限 (Contents: Read and write) を持つ ' +
        'fine-grained personal access token を GITHUB_TOKEN に設定してください。',
    );
  }
  return {
    token,
    owner: env.GITHUB_OWNER || 'vocabuki-io',
    repo: env.GITHUB_REPO || 'eventcalendar',
    branch: env.GITHUB_BRANCH || 'main',
    eventsPath: env.EVENTS_PATH || 'events.json',
    imagesDir: (env.IMAGES_DIR || 'images').replace(/^\/+|\/+$/g, ''),
    readOnly: /^(1|true|yes)$/i.test(env.VOCABUKI_READONLY || ''),
    // 画像取り込み時に許容する最大サイズ。GitHub Contents API は 100MB まで受けるが、
    // 来場者が毎回ダウンロードするファイルなので既定は 8MB に絞っている。
    maxImageBytes: Number(env.MAX_IMAGE_BYTES || 8 * 1024 * 1024),
  };
}

async function ghRequest(cfg, path, { method = 'GET', body, query } = {}) {
  const url = new URL(`${API}/repos/${cfg.owner}/${cfg.repo}/contents/${path}`);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'vocabuki-calendar-mcp',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text.slice(0, 400) };
    }
  }
  if (!res.ok) {
    const detail = (payload && payload.message) || res.statusText;
    throw new GitHubError(`GitHub API ${method} ${path} -> ${res.status}: ${detail}`, res.status);
  }
  return payload;
}

/** events.json を取得する。戻り値の sha は書き戻し時の楽観ロックに使う。 */
export async function readEvents(cfg) {
  const file = await ghRequest(cfg, cfg.eventsPath, { query: { ref: cfg.branch } });
  if (!file.content) {
    throw new GitHubError(
      `${cfg.eventsPath} の内容を取得できませんでした（1MB を超えるファイルは Contents API では読めません）。`,
      422,
    );
  }
  const raw = Buffer.from(file.content, 'base64').toString('utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new GitHubError(`${cfg.eventsPath} が JSON として解析できません: ${e.message}`, 422);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GitHubError(`${cfg.eventsPath} のトップレベルはオブジェクトである必要があります。`, 422);
  }
  if (!Array.isArray(data.events)) data.events = [];
  if (!data.people || typeof data.people !== 'object') data.people = {};
  return { data, sha: file.sha };
}

async function putFile(cfg, path, contentBase64, message, sha) {
  return ghRequest(cfg, path, {
    method: 'PUT',
    body: {
      message,
      content: contentBase64,
      branch: cfg.branch,
      ...(sha ? { sha } : {}),
    },
  });
}

/**
 * events.json を read-modify-write する。
 * 他のクライアント（admin.html 等）と同時に書いた場合 GitHub が 409/422 を返すので、
 * 最新版を読み直して mutate をやり直す。
 *
 * message は文字列、または mutate の戻り値を受け取ってメッセージを返す関数。
 * （コミット文言が検証後の値に依存するケースがあるため後者を用意している）
 */
export async function commitEvents(cfg, message, mutate, { attempts = 4 } = {}) {
  if (cfg.readOnly) {
    throw new ConfigError('VOCABUKI_READONLY が有効なため書き込みはできません。');
  }
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    const { data, sha } = await readEvents(cfg);
    const result = mutate(data);
    const body = JSON.stringify(data, null, 2) + '\n';
    try {
      const res = await putFile(
        cfg,
        cfg.eventsPath,
        Buffer.from(body, 'utf8').toString('base64'),
        typeof message === 'function' ? message(result) : message,
        sha,
      );
      return { result, commit: res.commit && res.commit.html_url };
    } catch (e) {
      // 409 (sha 不一致) / 422 (fast-forward 不可) は競合。読み直して再試行する。
      if (e instanceof GitHubError && (e.status === 409 || e.status === 422) && i < attempts - 1) {
        lastError = e;
        await new Promise((r) => setTimeout(r, 250 * (i + 1)));
        continue;
      }
      throw e;
    }
  }
  throw lastError;
}

/** 画像などのバイナリをリポジトリに追加する。既存ファイルがあれば上書きする。 */
export async function commitBinary(cfg, path, buffer, message) {
  if (cfg.readOnly) {
    throw new ConfigError('VOCABUKI_READONLY が有効なため書き込みはできません。');
  }
  let sha;
  try {
    const existing = await ghRequest(cfg, path, { query: { ref: cfg.branch } });
    sha = existing.sha;
  } catch (e) {
    if (!(e instanceof GitHubError && e.status === 404)) throw e;
  }
  const res = await putFile(cfg, path, buffer.toString('base64'), message, sha);
  return {
    path,
    replaced: Boolean(sha),
    commit: res.commit && res.commit.html_url,
  };
}
