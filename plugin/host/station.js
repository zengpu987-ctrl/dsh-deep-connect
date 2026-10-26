/**
 * Deep Connect — one-click relay stations.
 *
 * v3 replaces "type a relay URL on every machine" with an invitation link:
 *
 *   click 一键生成中继站  ->  this machine runs a relay and (when possible)
 *                              exposes it through a Cloudflare quick tunnel
 *   copy the link         ->  https://xxxx.trycloudflare.com#<invite token>
 *   paste it on machine B ->  B joins the same station, same room, same key
 *
 * The invite token lives in the URL *fragment*, which browsers and WebSocket
 * clients never transmit to the server. The relay therefore learns only the
 * hashed channel and ciphertext; the key is derived from the token on each
 * machine. Whoever holds the link can join — that is exactly what an invitation
 * is — so the link is a secret, not a public address.
 *
 * When `cloudflared` is not installed the station still works on the local
 * network: the link points at this machine's LAN address, and the panel says so
 * instead of pretending the station is reachable from anywhere.
 *
 * @module dsh-deep-connect/station
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_VERSION } from './version.js';

/** Protocol this station speaks. Old clients are refused below this. */
export const STATION_PROTOCOL = 3;
/** Where the relay implementation lives inside the repository. */
const RELAY_PATH = fileURLToPath(new URL('../../relay/relay.cjs', import.meta.url));

/** A fresh invite token: 32 random bytes, URL-safe. */
export function newInviteToken() {
  return randomBytes(32).toString('base64url');
}

/**
 * Parse an invitation link back into the two things needed to join.
 *
 * Accepts `https://host/#token`, `http://ip:port/#token`, and the same without
 * a scheme (pasted from a chat that stripped it).
 * @param {string} input - the pasted link.
 * @returns {{baseUrl: string, token: string}} the address and the invite token.
 */
export function parseStationLink(input) {
  let raw = String(input ?? '').trim();
  if (raw === '') throw new Error('请先粘贴中继站链接');
  // A link without a scheme is still a link a human pasted.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('这不是一条合法的链接');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error('链接必须是 http(s) 地址');
  }
  if (url.protocol === 'ws:') url.protocol = 'http:';
  if (url.protocol === 'wss:') url.protocol = 'https:';
  const token = url.hash.startsWith('#') ? url.hash.slice(1) : '';
  if (token.length < 16) throw new Error('链接里没有邀请令牌（# 后面的部分），请完整复制');
  url.hash = '';
  url.searchParams.delete('token');
  return { baseUrl: url.toString().replace(/\/$/, ''), token };
}

/** Build the invitation link from the station's address and token. */
export function stationLink(baseUrl, token) {
  return `${String(baseUrl).replace(/\/$/, '')}#${token}`;
}

/** This machine's first non-internal IPv4 address, if any. */
export function lanAddress() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && entry.internal !== true) return entry.address;
    }
  }
  return undefined;
}

/** Ask the OS for a free TCP port. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('没有可用的本地端口'))));
    });
  });
}

/** Locate `cloudflared`, or answer undefined. */
export async function findCloudflared() {
  const candidates = [];
  for (const directory of String(process.env.PATH ?? '').split(delimiter)) {
    if (directory !== '') candidates.push(join(directory, 'cloudflared'));
  }
  candidates.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared', join(process.env.HOME ?? '', 'bin/cloudflared'));
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* try the next one */
    }
  }
  return undefined;
}

/** Wait until the local relay answers its health check. */
async function waitForRelay(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** Where a station records itself so it can be adopted after a restart. */
const STATION_FILE = 'station.json';

/**
 * Adopt a station whose processes outlived the previous Harness process.
 *
 * That is what makes an in-place plugin update non-disruptive: the relay and the
 * quick tunnel are spawned detached, they keep serving while the app restarts,
 * and the new process reads this file instead of tearing everything down.
 *
 * @param {{root: string, log?: Function}} options - state directory and logger.
 * @returns {Promise<RelayStation|undefined>} a live station, or undefined.
 */
export async function adoptStation({ root, log = () => {} }) {
  const path = join(String(root ?? 'deep-connect'), 'station', STATION_FILE);
  let record;
  try {
    record = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
  if (record === null || typeof record !== 'object' || typeof record.token !== 'string' || typeof record.localUrl !== 'string') return undefined;
  const health = async (url) => {
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(3_000) });
      return response.ok;
    } catch {
      return false;
    }
  };
  if (!(await health(record.localUrl))) {
    await rm(path, { force: true }).catch(() => undefined);
    return undefined;
  }
  if (record.public === true && typeof record.baseUrl === 'string') {
    // The tunnel is cloudflared's child; if it is gone the station is LAN-only.
    const publicOk = await health(record.baseUrl);
    if (!publicOk) {
      record.public = false;
      record.baseUrl = record.lanUrl !== '' ? record.lanUrl : record.localUrl;
    }
  }
  const station = new RelayStation({ root, log });
  station.adopted = true;
  station.token = record.token;
  station.localUrl = record.localUrl;
  station.baseUrl = record.baseUrl;
  station.lanUrl = record.lanUrl ?? '';
  station.public = record.public === true;
  station.relayPid = Number(record.relayPid ?? 0);
  station.tunnelPid = Number(record.tunnelPid ?? 0);
  station.startedAt = Number(record.startedAt ?? Date.now());
  log('info', `已接续上次的中继站：${station.baseUrl}`);
  return station;
}

/**
 * Open a Cloudflare quick tunnel in front of any local URL.
 *
 * Used both by a station (in front of its relay) and by the phone gateway (in
 * front of the panel's mobile page). Best-effort by design: quick tunnels are
 * rate limited and explicitly "not guaranteed".
 *
 * @param {string} targetUrl - local URL to expose.
 * @param {{binary?: string, log?: Function, timeoutMs?: number}} [options]
 * @returns {Promise<{publicUrl: string, close: () => void}|undefined>}
 */
export async function openTunnel(targetUrl, options = {}) {
  const binary = options.binary ?? (await findCloudflared());
  const log = options.log ?? (() => {});
  if (binary === undefined) return undefined;
  return new Promise((resolve) => {
    const child = spawn(binary, ['tunnel', '--url', targetUrl, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let buffer = '';
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (value === undefined) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), Number(options.timeoutMs ?? 25_000));
    const onData = (chunk) => {
      const text = String(chunk);
      buffer += text;
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match !== null) {
        const publicUrl = match[0].replace(/\/$/, '');
        finish({ publicUrl, close: () => { try { child.kill('SIGTERM'); } catch { /* gone */ } } });
      }
      if (/\b(ERR|failed|error)\b/i.test(text)) log('warn', `cloudflared: ${text.trim().split('\n').slice(-1)[0]}`);
      if (buffer.length > 200_000) buffer = buffer.slice(-100_000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', () => finish(undefined));
    child.on('error', () => finish(undefined));
  });
}

/** One running station: a relay child plus, when public, a tunnel child. */
export class RelayStation {
  /**
   * @param {object} options - `{ root, log }`.
   */
  constructor(options = {}) {
    this.root = String(options.root ?? 'deep-connect');
    this.log = options.log ?? (() => {});
    /** @type {import('node:child_process').ChildProcess|undefined} */
    this.relay = undefined;
    /** @type {import('node:child_process').ChildProcess|undefined} */
    this.tunnel = undefined;
    this.baseUrl = '';
    this.localUrl = '';
    this.token = '';
    this.public = false;
    this.lanUrl = '';
    this.error = '';
    this.startedAt = 0;
    /** PIDs survive when this instance adopts a station it did not spawn. */
    this.relayPid = 0;
    this.tunnelPid = 0;
    this.adopted = false;
  }

  /** The panel's read-only view of this station. */
  describe() {
    return {
      running: this.relay !== undefined && this.baseUrl !== '',
      baseUrl: this.baseUrl,
      localUrl: this.localUrl,
      token: this.token,
      public: this.public === true,
      lanUrl: this.lanUrl,
      error: this.error,
      startedAt: this.startedAt,
    };
  }

  /**
   * Start the relay and, when cloudflared exists, a public tunnel in front of it.
   * @param {{ preferPublic?: boolean }} [options] - disable the tunnel to force LAN.
   * @returns {Promise<{baseUrl: string, token: string, public: boolean, lanUrl: string, error: string}>}
   */
  async start(options = {}) {
    await this.stop();
    this.error = '';
    const port = await freePort();
    const token = newInviteToken();
    const statePath = join(this.root, 'station', 'relay-state.json');
    // Detached on purpose: the station must outlive this Harness process, or a
    // plugin update would drop every peer mid-session. It is re-adopted on the
    // next start from station.json.
    this.relay = spawn(process.execPath, [
      RELAY_PATH,
      '--host', '0.0.0.0',
      '--port', String(port),
      '--state', statePath,
      '--token', token,
      '--require-proto', String(STATION_PROTOCOL),
      '--require-version', MIN_VERSION,
    ], { detached: true, stdio: 'ignore' });
    this.relayPid = this.relay.pid ?? 0;
    this.relay.unref();
    this.relay.on('exit', (code) => {
      if (this.relay !== undefined) this.log('warn', `中继站进程退出（code ${code}）`);
    });

    const loopback = `http://127.0.0.1:${port}`;
    if (!(await waitForRelay(loopback, 10_000))) {
      this.error = '中继站没有在本地起来（端口被占用或 Node 版本过低）';
      this.log('warn', this.error);
      await this.stop();
      throw new Error(this.error);
    }

    this.token = token;
    // The hosting device dials loopback (no hairpin, no proxy); everyone else
    // uses the shareable address.
    this.localUrl = loopback;
    this.lanUrl = lanAddress() === undefined ? '' : `http://${lanAddress()}:${port}`;
    this.baseUrl = this.lanUrl !== '' ? this.lanUrl : loopback;
    this.public = false;

    if (options.preferPublic !== false) {
      const binary = await findCloudflared();
      if (binary !== undefined) {
        const publicUrl = await this.#startTunnel(binary, port);
        if (publicUrl !== undefined) {
          this.baseUrl = publicUrl;
          this.public = true;
        }
      } else {
        this.error = '没有找到 cloudflared：这个中继站只在同一局域网内可加入';
      }
    } else {
      this.error = '已按要求只开局域网中继站';
    }

    this.startedAt = Date.now();
    await this.#persist();
    return this.describe();
  }

  /** Spawn cloudflared and read the quick-tunnel hostname out of its log. */
  async #startTunnel(binary, port) {
    return new Promise((resolve) => {
      const child = spawn(binary, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.tunnel = child;
      this.tunnelPid = child.pid ?? 0;
      let settled = false;
      let buffer = '';
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value === undefined) {
          // A tunnel that never produced a URL is useless; do not keep it.
          try {
            child.kill('SIGTERM');
          } catch {
            /* already gone */
          }
          this.tunnel = undefined;
        }
        resolve(value);
      };
      const timer = setTimeout(() => finish(undefined), 25_000);
      const onData = (chunk) => {
        const text = String(chunk);
        buffer += text;
        const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (match !== null) finish(match[0].replace(/\/$/, ''));
        if (/\b(ERR|failed|error)\b/i.test(text)) this.log('warn', `cloudflared: ${text.trim().split('\n').slice(-1)[0]}`);
        if (buffer.length > 200_000) buffer = buffer.slice(-100_000);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.on('exit', () => finish(undefined));
      child.on('error', () => finish(undefined));
    });
  }

  /** Record the station so the next process can adopt it. */
  async #persist() {
    const path = join(this.root, 'station', STATION_FILE);
    try {
      await mkdir(join(this.root, 'station'), { recursive: true });
      await writeFile(path, JSON.stringify({
        version: 1,
        baseUrl: this.baseUrl,
        localUrl: this.localUrl,
        token: this.token,
        public: this.public === true,
        lanUrl: this.lanUrl,
        relayPid: this.relayPid,
        tunnelPid: this.tunnelPid,
        startedAt: this.startedAt,
      }, null, 2), { mode: 0o600 });
    } catch (error) {
      this.log('warn', `中继站状态写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Stop the tunnel and the relay. Safe to call repeatedly. */
  async stop() {
    // An adopted station has no child handles, only pids, so both are killed.
    for (const pid of [this.tunnelPid, this.relayPid]) {
      if (!Number.isFinite(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    this.tunnelPid = 0;
    this.relayPid = 0;
    await rm(join(this.root, 'station', STATION_FILE), { force: true }).catch(() => undefined);
    const children = [this.tunnel, this.relay].filter((child) => child !== undefined);
    for (const child of children) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    await Promise.all(children.map((child) => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      const timer = setTimeout(resolve, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    })));
    this.tunnel = undefined;
    this.relay = undefined;
    this.baseUrl = '';
    this.localUrl = '';
    this.token = '';
    this.public = false;
    this.lanUrl = '';
    this.startedAt = 0;
  }
}
