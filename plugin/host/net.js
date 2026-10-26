/**
 * Deep Connect — a tiny direct HTTPS client for the updater.
 *
 * `fetch` is the obvious tool and the wrong one here: when the host process runs
 * with `NODE_USE_ENV_PROXY=1`, Node routes fetch through the configured proxy,
 * and on real machines that proxy path resets TLS to api.github.com
 * (`ECONNRESET`). The update check then fails forever while curl works fine.
 *
 * `node:https` ignores proxy environment variables, connects directly, follows
 * redirects, and is enough for the two things the updater needs: read a small
 * JSON document and stream one tarball to disk. If the machine really needs a
 * proxy to reach GitHub, the caller falls back to curl, which honours it.
 *
 * @module dsh-deep-connect/net
 */
import { get } from 'node:https';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';

/** Follow at most this many redirects. */
const MAX_REDIRECTS = 5;

/**
 * One GET, direct, with redirects.
 *
 * @param {string} url - absolute https URL.
 * @param {{headers?: Record<string,string>, timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<{status: number, headers: Record<string,string>, body: Buffer}>}
 */
export function httpsGet(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 20_000);
  const maxBytes = Number(options.maxBytes ?? 4 * 1024 * 1024);
  const headers = { 'user-agent': 'dsh-deep-connect', accept: '*/*', ...(options.headers ?? {}) };

  const once = (target, redirects) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = get(target, { headers, timeout: timeoutMs }, (response) => {
      const status = Number(response.statusCode ?? 0);
      if (status >= 300 && status < 400 && typeof response.headers.location === 'string') {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          finish(reject, new Error(`too many redirects (${target})`));
          return;
        }
        const next = new URL(response.headers.location, target).toString();
        finish(resolve, once(next, redirects + 1));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(new Error(`response larger than ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finish(resolve, { status, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', (error) => finish(reject, error));
    });
    request.on('timeout', () => request.destroy(new Error('request timed out')));
    request.on('error', (error) => finish(reject, error));
  });

  return once(String(url), 0);
}

/**
 * GET a JSON document.
 * @param {string} url - absolute https URL.
 * @param {object} [options] - forwarded to {@link httpsGet}.
 * @returns {Promise<any>}
 */
export async function httpsGetJson(url, options = {}) {
  const response = await httpsGet(url, { accept: 'application/json', ...options });
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  return JSON.parse(response.body.toString('utf8'));
}

/**
 * Stream one URL to a file.
 * @param {string} url - absolute https URL.
 * @param {string} destination - file path.
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<number>} bytes written.
 */
export async function httpsDownload(url, destination, options = {}) {
  const timeoutMs = Number(options.timeoutMs ?? 180_000);
  const headers = { 'user-agent': 'dsh-deep-connect', accept: '*/*' };
  const follow = (target, redirects) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const request = get(target, { headers, timeout: timeoutMs }, (response) => {
      const status = Number(response.statusCode ?? 0);
      if (status >= 300 && status < 400 && typeof response.headers.location === 'string') {
        response.resume();
        if (redirects >= MAX_REDIRECTS) {
          finish(reject, new Error(`too many redirects (${target})`));
          return;
        }
        finish(resolve, follow(new URL(response.headers.location, target).toString(), redirects + 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        finish(reject, new Error(`HTTP ${status}`));
        return;
      }
      const out = createWriteStream(destination);
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
      });
      response.pipe(out);
      out.on('finish', () => out.close(() => finish(resolve, size)));
      out.on('error', (error) => finish(reject, error));
      response.on('error', (error) => finish(reject, error));
    });
    request.on('timeout', () => request.destroy(new Error('download timed out')));
    request.on('error', (error) => finish(reject, error));
  });
  try {
    return await follow(String(url), 0);
  } catch (error) {
    await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Shell out to curl. Last resort, because curl honours the proxy the host needs
 * while `node:https` deliberately does not.
 * @param {string} url - absolute URL.
 * @param {{proxy?: string, timeoutMs?: number, maxBytes?: number}} [options]
 * @returns {Promise<Buffer>}
 */
export async function curlGet(url, options = {}) {
  const { execFile } = await import('node:child_process');
  const timeoutMs = Number(options.timeoutMs ?? 20_000);
  const args = ['-fsSL', '--retry', '2', '--retry-all-errors', '--connect-timeout', '10', '--max-time', String(Math.ceil(timeoutMs / 1000)), url];
  if (typeof options.proxy === 'string' && options.proxy !== '') args.unshift('--proxy', options.proxy);
  return new Promise((resolve, reject) => {
    execFile('curl', args, { maxBuffer: Number(options.maxBytes ?? 4 * 1024 * 1024) }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`curl: ${String(stderr).trim().slice(0, 160) || error.message}`));
        return;
      }
      resolve(Buffer.from(stdout));
    });
  });
}
