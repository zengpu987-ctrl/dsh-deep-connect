/**
 * Deep Connect — Host half.
 *
 * One plugin, two jobs:
 *
 *   1. Advertise this machine's conversations to the cloud relay and keep the
 *      index current, so every other DSH install signed in to the same DeepSeek
 *      account can see what exists here.
 *   2. Serve the browser half over one same-origin route, and answer a peer's
 *      requests for a conversation body or for a prompt to be run.
 *
 * Self-contained on purpose: no dependency beyond `node:` builtins and the
 * services `ctx` already provides. The plugin is symlinked into a profile and
 * Node resolves its realpath, so a bare `import` of any DSH package would fail
 * (`ws`, `dsh-atomic-write`, everything). The two ways in are `ctx.<service>`
 * and `globalThis.WebSocket`, and this file uses exactly those.
 *
 * The account is what binds two machines together, and it is read here, on the
 * Host, because the browser is never allowed to see it:
 *   - `ctx.deepseekAccount.getProfile()` gives the account's stable user id.
 *   - `channelFor(userId)` hashes it into the bucket the relay routes on.
 *   - `deriveKey(userId)` (or the user's own passphrase) gives the frame key.
 * The relay therefore learns a hash and nothing else; the raw id, the token and
 * every conversation byte stay on the machines.
 *
 * @module @local/dsh-deep-connect
 */
import { RelayClient } from './host/relay.js';
import { DeepConnectStore } from './host/store.js';
import { SessionAdapter } from './host/sessions.js';
import { createInheritedSession } from './host/inherit.js';
import { RelayStation, adoptStation, openTunnel, parseStationLink, stationLink, findCloudflared, lanAddress } from './host/station.js';
import { MobileGateway } from './host/mobile.js';
import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelFor, deriveKey, deriveKeyPbkdf2, fingerprint, frameId, PROTOCOL_VERSION } from './host/crypto.js';

export const name = 'deep-connect';

/** The version shown in the panel and compared against GitHub releases. */
export const PLUGIN_VERSION = '4.0.0';
/** GitHub repository the updater asks about. */
const UPDATE_REPO = 'zengpu987-ctrl/dsh-deep-connect';
/** Check at most this often unless the user asks explicitly. */
const UPDATE_INTERVAL_MS = 6 * 3600 * 1000;

/**
 * Every service this plugin reads directly. `sessionQuery` and
 * `sessionPersistence` are deliberately NOT declared: `sessionQuery` is the
 * preferred reader but a deployment may compose only the persistence backend,
 * and a required dependency that is absent would leave the whole plugin
 * PENDING forever. The adapter probes both through `ctx.get` and reports which
 * one it found.
 */
export const inject = ['deepseekAccount'];

/** Route the browser half calls. Must stay below `/api` and match client.js. */
const API_PATH = '/api/deep-connect/api';
/** How long a browser-issued prompt waits for the owning device to accept it. */
const PROMPT_TIMEOUT_MS = 25_000;
/** Payload kinds carried inside an encrypted envelope. */
const KIND = {
  index: 'index',
  history: 'history',
  prompt: 'prompt',
  export: 'export',
  task: 'task',
  ping: 'ping',
};

/** Largest raw event export one envelope may carry, comfortably below the relay's 16 MB frame cap. */
const MAX_EXPORT_BYTES = 12 * 1024 * 1024;

/** Numeric segment comparison; `3.0.1` > `3.0.0`, `v` prefixes are ignored. */
export function compareVersion(a, b) {
  const parse = (value) => String(value).replace(/^v/i, '').split(/[-+.]/).map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));
  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** The highest semver tag in a GitHub tags payload, or ''. */
export function pickLatestVersion(tags) {
  const versions = Array.isArray(tags)
    ? tags
        .map((tag) => String(tag?.name ?? '').replace(/^v/i, ''))
        .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
    : [];
  versions.sort((left, right) => compareVersion(right, left));
  return versions[0] ?? '';
}

/**
 * @param {object} ctx - the Host plugin context.
 * @param {object} config - the Loader row's config.
 */
export function apply(ctx, config) {
  const root = String(config?.root ?? 'deep-connect');
  const settings = {
    relayUrl: String(config?.relayUrl ?? ''),
    token: String(config?.token ?? ''),
    secret: String(config?.secret ?? ''),
    deviceName: String(config?.deviceName ?? ''),
    // v3 station mode: an invite link is the only thing a human copies.
    stationUrl: String(config?.stationUrl ?? ''),
    stationToken: String(config?.stationToken ?? ''),
    stationRole: config?.stationRole === 'host' ? 'host' : config?.stationRole === 'join' ? 'join' : '',
    // v3.0.2: whether this machine shares conversation bodies (and allows
    // inheritance) with the station. The index stays visible either way.
    shareMemory: config?.shareMemory !== false,
    // v4: phone access over a QR code, and one-click self-update.
    mobileEnabled: config?.mobileEnabled === true,
    mobileToken: String(config?.mobileToken ?? ''),
    // A tunnel for the phone page costs one more cloudflared; tests turn it off.
    mobileTunnel: config?.mobileTunnel !== false,
    autoConnect: config?.autoConnect !== false,
    autoIndex: config?.autoIndex !== false,
    indexIntervalMs: Math.max(5000, Number(config?.indexIntervalMs ?? 15000)),
    historyLimitEvents: Math.max(200, Number(config?.historyLimitEvents ?? 20_000)),
    // Auto-pull every peer conversation body the moment a peer appears, instead
    // of waiting for a human to click each row. On by default: the point of the
    // plugin is that the other machine's work is already here.
    autoSyncHistory: config?.autoSyncHistory !== false,
    maxSyncSessions: Math.max(1, Number(config?.maxSyncSessions ?? 300)),
    syncDelayMs: Math.max(0, Number(config?.syncDelayMs ?? 40)),
    // Not a user-facing setting: it exists so a test can shorten the liveness
    // probe without shipping a different code path.
    heartbeatMs: Math.max(1000, Number(config?.heartbeatMs ?? 20_000)),
  };

  const log = (level, message) => {
    const method = typeof ctx.logger?.[level] === 'function' ? ctx.logger[level].bind(ctx.logger) : ctx.logger?.info?.bind(ctx.logger);
    method?.(`[deep-connect] ${message}`);
  };

  const store = new DeepConnectStore(root, { log, defaultName: settings.deviceName });
  const sessions = new SessionAdapter(ctx, { log });

  /** In-memory runtime state; nothing here is secret enough to need encryption at rest beyond the key itself. */
  const state = {
    key: undefined,
    /** The exact string the current key was derived from (station token, passphrase or account id). */
    keySecret: '',
    /** Which secret the current key came from: 'station' | 'account' | 'passphrase' | undefined. */
    keySource: undefined,
    /** The account id the current key was derived from, so a sign-out is noticed. */
    accountId: undefined,
    accountName: '',
    /** @type {RelayClient|undefined} */
    relay: undefined,
    /** This machine's own last-built index rows. */
    localIndex: [],
    lastIndexAt: 0,
    lastIndexError: '',
    /** Pending peer-conversation pulls; serialized so a burst cannot swamp the relay. */
    syncQueue: [],
    /** `"deviceId\u0000sessionId"` for pulls already queued or running. */
    syncPending: new Set(),
    syncRunning: false,
    /** Per-session sync bookkeeping for the panel: key -> {at, ok, error}. */
    syncState: new Map(),
    syncedAt: 0,
    /** A station this machine is currently hosting (v3). */
    station: undefined,
    stationError: '',
    stationAdopted: false,
    /** Phone gateway: `{ gateway, tunnel, url, error }`. */
    mobile: undefined,
    /** deviceId -> whether that peer shares conversation bodies. */
    peerShareMemory: new Map(),
    updateInfo: undefined,
    updateCheckedAt: 0,
    started: false,
  };

  /* --------------------------- identity and key --------------------------- */

  /**
   * Read the signed-in account id.
   *
   * `getProfile` is the only call that returns it and it always performs a
   * request, so it is called once per start and on every sign-out signal, never
   * in a loop. The union is narrowed because a transport failure surfaces as
   * `{status:'failed'}` rather than as a rejection.
   * @returns {Promise<string|undefined>}
   */
  async function readAccountId() {
    try {
      const account = ctx.get?.('deepseekAccount');
      if (account === undefined) return undefined;
      const outcome = await account.getProfile({
        version: '0.1.0',
        locale: 'zh-CN',
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      });
      if (outcome !== null && outcome !== undefined && outcome.status === 'ready') {
        const id = outcome.value?.id;
        state.accountName = typeof outcome.value?.name === 'string' ? outcome.value.name : '';
        return typeof id === 'string' && id !== '' ? id : undefined;
      }
      return undefined;
    } catch (error) {
      log('warn', `读取账号信息失败：${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Establish the frame key.
   *
   * A configured passphrase wins over the account id, because a user who typed
   * one has made an explicit choice about what the shared secret is. The key is
   * derived once and cached; PBKDF2 is deliberately slow and must never run per
   * frame.
   * @returns {Promise<{ok: boolean, reason?: string}>}
   */
  async function establishKey() {
    // v3: a station invite token is the primary secret. Every machine that
    // pasted the same link derives the same key, and a machine that never saw
    // the link cannot join even if it guesses the URL.
    const stationToken = settings.stationToken.trim();
    if (stationToken !== '') {
      state.key = await deriveKeyPbkdf2(stationToken);
      state.keySecret = stationToken;
      state.keySource = 'station';
      state.accountId = undefined;
      log('info', `已用中继站邀请令牌派生密钥，指纹 ${fingerprint(state.key)}`);
      return { ok: true };
    }
    const configured = settings.secret.trim();
    if (configured !== '') {
      state.key = await deriveKeyPbkdf2(configured);
      state.keySecret = configured;
      state.keySource = 'passphrase';
      state.accountId = undefined;
      log('info', `已用口令派生密钥，指纹 ${fingerprint(state.key)}`);
      return { ok: true };
    }
    const accountId = await readAccountId();
    if (accountId === undefined) {
      state.key = undefined;
      state.keySource = undefined;
      state.keySecret = '';
      return { ok: false, reason: 'signed-out' };
    }
    state.accountId = accountId;
    state.key = await deriveKeyPbkdf2(accountId);
    state.keySecret = accountId;
    state.keySource = 'account';
    log('info', `已用账号身份派生密钥，指纹 ${fingerprint(state.key)}`);
    return { ok: true };
  }

  /* ------------------------------ outgoing ------------------------------ */

  /** Seal and send one payload to a peer, or to the whole channel. */
  async function sendTo(to, payload) {
    const relay = state.relay;
    if (relay === undefined || state.key === undefined) return { delivered: false, reason: 'not-ready' };
    return relay.send(to, payload);
  }

  /** Ask one peer for something and wait for the correlated answer. */
  async function askPeer(deviceId, payload, timeoutMs = PROMPT_TIMEOUT_MS) {
    const relay = state.relay;
    if (relay === undefined || state.key === undefined) return undefined;
    // A request/response exchange is worth nothing on a dead link, so prove the
    // link works before spending the caller's timeout on it.
    if (!(await relay.waitForLiveness(Math.min(8000, timeoutMs)))) {
      return undefined;
    }
    const id = frameId('q');
    // The envelope id doubles as the correlation id, and it travels INSIDE the
    // encrypted payload so the answering side can address its reply without
    // having to trust (or even see) anything the relay added.
    const result = await relay.send(deviceId, { ...payload, requestId: id }, { id, waitForReply: true, timeoutMs });
    // `reply` is the relay's envelope shape `{ from, payload }`; callers want the
    // decrypted payload, and conflating the two is exactly how a peer answer
    // silently becomes an empty cache entry.
    return result.reply?.payload;
  }

  /* ------------------------------- the index ------------------------------- */

  /** Strip an index row down to what actually crosses the wire. */
  function toWireEntry(entry, ownerId, ownerName) {
    const row = {
      ownerId,
      ownerName,
      sessionId: entry.sessionId,
      title: entry.title,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      eventCount: entry.eventCount,
      userPrompts: entry.userPrompts,
      tasks: entry.tasks,
      live: entry.live === true,
      isRemote: ownerId !== store.getIdentity().deviceId,
    };
    if (typeof entry.cwd === 'string' && entry.cwd !== '') row.cwd = entry.cwd;
    return row;
  }

  /**
   * Rebuild this machine's index and broadcast it.
   * @param {{ force?: boolean }} [options] - `force` skips the throttle.
   */
  async function publishIndex(options = {}) {
    if (!sessions.available) {
      state.lastIndexError = '这个部署没有挂载会话存储（sessionQuery / sessionPersistence 都不可用）';
      return;
    }
    const now = Date.now();
    if (options.force !== true && now - state.lastIndexAt < settings.indexIntervalMs) return;
    state.lastIndexAt = now;
    try {
      const entries = await sessions.buildIndex({ limit: 300 });
      const identity = store.getIdentity();
      state.localIndex = entries.map((entry) => toWireEntry(entry, identity.deviceId, identity.name));
      state.lastIndexError = '';
      log('debug', `索引已更新：${state.localIndex.length} 条会话`);
      await sendTo('*', { kind: KIND.index, deviceId: identity.deviceId, deviceName: identity.name, at: now, shareMemory: settings.shareMemory === true, entries: state.localIndex });
    } catch (error) {
      state.lastIndexError = error instanceof Error ? error.message : String(error);
      log('warn', `建立索引失败：${state.lastIndexError}`);
    }
  }

  /* --------------------------- incoming frames --------------------------- */

  /** Record a peer index and refresh the roster view. */
  async function acceptIndex(from, payload) {
    const document = {
      version: PROTOCOL_VERSION,
      deviceId: from,
      deviceName: typeof payload.deviceName === 'string' ? payload.deviceName : from.slice(0, 8),
      at: Number(payload.at ?? Date.now()),
      shareMemory: payload.shareMemory !== false,
      entries: Array.isArray(payload.entries) ? payload.entries : [],
    };
    await store.setRemoteIndex(from, document);
    state.peerShareMemory.set(from, document.shareMemory !== false);
    log('debug', `收到 ${document.deviceName} 的索引：${document.entries.length} 条`);
    queuePeerSync(from, document.entries);
  }

  /* --------------------------- full-history sync --------------------------- */

  /** One queue key per (device, session) pair. */
  function syncKey(deviceId, sessionId) {
    return `${deviceId}\u0000${sessionId}`;
  }

  /**
   * Queue every conversation in a peer index that we do not already hold.
   *
   * This is what makes "两端出现彼此设备以后立即同步所有任务对话" true: the index
   * says what exists, and this pulls every body — not just the ones a human
   * happened to click. A cached copy whose (eventCount, updatedAt) still match
   * the index row is skipped, so a healthy corpus costs no traffic.
   */
  function queuePeerSync(deviceId, entries) {
    if (!settings.autoSyncHistory) return;
    let queued = 0;
    for (const entry of entries.slice(0, settings.maxSyncSessions)) {
      const sessionId = String(entry?.sessionId ?? '');
      if (sessionId === '') continue;
      const key = syncKey(deviceId, sessionId);
      if (state.syncPending.has(key)) continue;
      state.syncPending.add(key);
      state.syncQueue.push({
        key,
        deviceId,
        sessionId,
        eventCount: Number(entry.eventCount ?? 0),
        updatedAt: Number(entry.updatedAt ?? 0),
      });
      queued += 1;
    }
    if (queued > 0) {
      log('debug', `排队拉取 ${deviceId.slice(0, 12)} 的 ${queued} 条会话正文`);
      void runSyncQueue();
    }
  }

  /** Drain the sync queue one conversation at a time. */
  async function runSyncQueue() {
    if (state.syncRunning) return;
    state.syncRunning = true;
    try {
      while (state.syncQueue.length > 0) {
        if (!state.started || state.relay?.connected !== true) break;
        const job = state.syncQueue.shift();
        try {
          const cached = await store.getHistory(job.deviceId, job.sessionId);
          const fresh =
            cached !== undefined &&
            Number(cached.eventCount ?? 0) === job.eventCount &&
            Number(cached.updatedAt ?? 0) === job.updatedAt;
          if (fresh) {
            state.syncState.set(job.key, { at: Date.now(), ok: true, cached: true });
            continue;
          }
          const reply = await askPeer(job.deviceId, { need: KIND.history, sessionId: job.sessionId }, 30_000);
          if (reply === undefined || reply.error !== undefined) {
            state.syncState.set(job.key, { at: Date.now(), ok: false, error: reply?.error ?? 'no-answer' });
            continue;
          }
          await acceptIndexHistory(job.deviceId, reply);
          state.syncState.set(job.key, { at: Date.now(), ok: true });
        } catch (error) {
          state.syncState.set(job.key, {
            at: Date.now(),
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          state.syncPending.delete(job.key);
        }
        if (settings.syncDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, settings.syncDelayMs));
      }
    } finally {
      state.syncRunning = false;
      state.syncedAt = Date.now();
    }
  }

  /**
   * Pull everything missing from the indices already on disk.
   *
   * The roster event only fires on a change, so a restart (or a fresh panel
   * mount) needs this pass to re-queue the conversations a previous run had not
   * finished copying.
   */
  async function syncFromCachedIndices() {
    const identity = store.getIdentity();
    for (const peer of store.getPeers()) {
      if (peer.deviceId === identity.deviceId || peer.online !== true) continue;
      const document = await store.getRemoteIndex(peer.deviceId).catch(() => undefined);
      if (document !== undefined) {
        state.peerShareMemory.set(peer.deviceId, document.shareMemory !== false);
        queuePeerSync(peer.deviceId, document.entries ?? []);
      }
    }
  }

  /** Answer a peer's request for one conversation body. */
  async function serveHistory(from, payload, requestId) {
    const sessionId = String(payload?.sessionId ?? '');
    if (sessionId === '') return;
    if (!settings.shareMemory) {
      await state.relay?.reply(from, requestId, { kind: KIND.history, sessionId, error: 'memory-sharing-off' });
      return;
    }
    const exported = await sessions.exportTranscript(sessionId);
    if (exported === undefined) {
      await state.relay?.reply(from, requestId, { kind: KIND.history, sessionId, error: 'not-found' });
      return;
    }
    await state.relay?.reply(from, requestId, {
      kind: KIND.history,
      sessionId,
      deviceId: store.getIdentity().deviceId,
      title: exported.title,
      eventCount: exported.eventCount,
      truncated: exported.truncated,
      tasks: exported.tasks,
      transcript: exported.transcript,
      updatedAt: exported.updatedAt,
      fetchedAt: Date.now(),
    });
  }

  /**
   * Answer a peer's request for one session's RAW event log.
   *
   * This is the payload "继承" needs: a transcript is for reading, but a local
   * copy that can be resumed has to carry the events themselves.
   */
  async function serveExport(from, payload, requestId) {
    const sessionId = String(payload?.sessionId ?? '');
    if (sessionId === '') return;
    if (!settings.shareMemory) {
      await state.relay?.reply(from, requestId, { kind: KIND.export, sessionId, error: 'memory-sharing-off' });
      return;
    }
    const read = await sessions.readEvents(sessionId);
    if (read === undefined) {
      await state.relay?.reply(from, requestId, { kind: KIND.export, sessionId, error: 'not-found' });
      return;
    }
    const events = read.events.map((event) => {
      /** @type {Record<string, unknown>} */
      const row = { type: event.type, seq: event.seq, time: event.time, data: event.data };
      if (event.ignorable === true) row.ignorable = true;
      if (event.surfaceOp !== undefined) row.surfaceOp = event.surfaceOp;
      if (Array.isArray(event.sourceEventSeqs)) row.sourceEventSeqs = event.sourceEventSeqs;
      return row;
    });
    const bytes = Buffer.byteLength(JSON.stringify(events), 'utf8');
    if (bytes > MAX_EXPORT_BYTES) {
      await state.relay?.reply(from, requestId, {
        kind: KIND.export,
        sessionId,
        error: 'too-large',
        bytes,
        limit: MAX_EXPORT_BYTES,
      });
      return;
    }
    await state.relay?.reply(from, requestId, {
      kind: KIND.export,
      sessionId,
      deviceId: store.getIdentity().deviceId,
      title: read.title,
      eventCount: events.length,
      inheritedEventCount: read.inheritedEventCount,
      header: read.header,
      events,
      fetchedAt: Date.now(),
    });
  }

  /**
   * Run a prompt locally, on behalf of a peer.
   *
   * This is what "continue the conversation from the other machine" means here,
   * and it is deliberately the *only* way it happens: the device that owns a
   * session remains its single writer, so the append-only log never forks. The
   * peer sends text, this machine admits it through the same path the local UI
   * uses (`ctx.sessionController.prompt`), and the peer sees the result when it
   * next reads the history.
   */
  async function servePrompt(from, payload, requestId) {
    const sessionId = String(payload?.sessionId ?? '');
    const text = String(payload?.text ?? '').trim();
    if (sessionId === '' || text === '') {
      await state.relay?.reply(from, requestId, { kind: KIND.prompt, sessionId, accepted: false, reason: 'bad-request' });
      return;
    }
    const controller = ctx.get?.('sessionController');
    if (controller === undefined || typeof controller.prompt !== 'function') {
      await state.relay?.reply(from, requestId, { kind: KIND.prompt, sessionId, accepted: false, reason: 'controller-unavailable' });
      return;
    }
    try {
      await controller.prompt({
        requestId: `dc-${frameId('r')}`,
        sessionId,
        mode: payload?.mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text }],
      });
      log('info', `已接受来自 ${from.slice(0, 12)} 的消息，写入会话 ${sessionId}`);
      await state.relay?.reply(from, requestId, { kind: KIND.prompt, sessionId, accepted: true });
      // The prompt changed this machine's index; broadcast it soon so the peer's
      // list view reflects the new activity without waiting a full interval.
      state.lastIndexAt = 0;
      setTimeout(() => void publishIndex(), 500).unref?.();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('warn', `执行对端消息失败：${message}`);
      await state.relay?.reply(from, requestId, { kind: KIND.prompt, sessionId, accepted: false, reason: message });
    }
  }

  /**
   * Run a command on this machine on behalf of a peer.
   *
   * Unlike the per-session prompt, this may start a NEW session: "发命令给另一台
   * 的 DSH，在另一台上做" is a request to work here, not to continue a specific
   * conversation.
   */
  async function serveTask(from, payload, requestId) {
    const text = String(payload?.text ?? '').trim();
    const controller = ctx.get?.('sessionController');
    const makeSession = controller?.create;
    const prompt = controller?.prompt;
    if (text === '' || typeof prompt !== 'function') {
      await state.relay?.reply(from, requestId, { kind: KIND.task, accepted: false, reason: 'controller-unavailable' });
      return;
    }
    try {
      let sessionId = String(payload?.sessionId ?? '');
      if (sessionId === '') {
        if (typeof makeSession !== 'function') {
          await state.relay?.reply(from, requestId, { kind: KIND.task, accepted: false, reason: 'create-unavailable' });
          return;
        }
        const created = await makeSession.call(controller, {});
        sessionId = String(created?.sessionId ?? '');
      }
      if (sessionId === '') {
        await state.relay?.reply(from, requestId, { kind: KIND.task, accepted: false, reason: 'create-failed' });
        return;
      }
      await prompt.call(controller, {
        requestId: `dc-${frameId('r')}`,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      });
      log('info', `已接受来自 ${from.slice(0, 12)} 的任务，写入会话 ${sessionId}`);
      state.lastIndexAt = 0;
      setTimeout(() => void publishIndex(), 500).unref?.();
      await state.relay?.reply(from, requestId, { kind: KIND.task, sessionId, accepted: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log('warn', `执行对端任务失败：${message}`);
      await state.relay?.reply(from, requestId, { kind: KIND.task, accepted: false, reason: message });
    }
  }

  /** Dispatch one decrypted envelope. */
  async function onFrame({ from, payload }) {
    const kind = payload?.kind;
    if (kind === KIND.index) {
      await acceptIndex(from, payload);
      return;
    }
    if (kind === KIND.history) {
      await acceptIndexHistory(from, payload);
      return;
    }
    // A request carries the envelope id in `payload.requestId`; answers are
    // correlated by the relay client, so a request is the only case that needs
    // an explicit reply here.
    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : undefined;
    if (requestId === undefined) return;
    if (payload?.need === KIND.history) await serveHistory(from, payload, requestId);
    else if (payload?.need === KIND.export) await serveExport(from, payload, requestId);
    else if (payload?.need === KIND.task) await serveTask(from, payload, requestId);
    else if (payload?.need === KIND.prompt) await servePrompt(from, payload, requestId);
  }

  /** A peer pushed a conversation body; keep the copy for offline reading. */
  async function acceptIndexHistory(from, payload) {
    const sessionId = String(payload?.sessionId ?? '');
    if (sessionId === '') return;
    await store.putHistory(from, sessionId, {
      version: PROTOCOL_VERSION,
      deviceId: from,
      sessionId,
      title: payload.title ?? '',
      eventCount: Number(payload.eventCount ?? 0),
      truncated: payload.truncated === true,
      tasks: payload.tasks,
      transcript: Array.isArray(payload.transcript) ? payload.transcript : [],
      // The peer's own activity time, so the sync queue can tell "unchanged" from
      // "grew" without moving the body again.
      updatedAt: Number(payload.updatedAt ?? 0),
      fetchedAt: Number(payload.fetchedAt ?? Date.now()),
    });
    log('debug', `已缓存 ${from.slice(0, 12)} 的会话 ${sessionId}`);
  }

  /* ------------------------------- browser API ------------------------------- */

  /** Merge this machine's rows with every peer's cached rows. */
  async function allRows() {
    const identity = store.getIdentity();
    const rows = state.localIndex.map((entry) => ({ ...entry, ownerId: identity.deviceId, ownerName: identity.name, isRemote: false }));
    const peers = store.getPeers();
    for (const peer of peers) {
      if (peer.deviceId === identity.deviceId) continue;
      const document = await store.getRemoteIndex(peer.deviceId);
      if (document === undefined) continue;
      for (const entry of document.entries ?? []) {
        const sessionId = String(entry.sessionId ?? '');
        rows.push({
          ...entry,
          ownerId: peer.deviceId,
          ownerName: document.deviceName ?? peer.name ?? peer.deviceId.slice(0, 8),
          isRemote: true,
          // Whether the full body is already on this disk: the panel shows it,
          // and it is the honest answer to "已同步了吗".
          hasCopy: sessionId === '' ? false : await store.hasHistory(peer.deviceId, sessionId),
        });
      }
    }
    return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /* ------------------------------ stations (v3) ------------------------------ */

  /** The panel's view of the station this machine is hosting or joined. */
  function stationView() {
    const live = state.station?.describe();
    const url = settings.stationUrl;
    const token = settings.stationToken;
    return {
      role: settings.stationRole,
      url,
      token,
      link: url !== '' && token !== '' ? stationLink(url, token) : '',
      running: live?.running === true,
      adopted: live?.adopted === true,
      public: live?.public === true,
      lanUrl: live?.lanUrl ?? '',
      startedAt: Number(live?.startedAt ?? 0),
      error: state.stationError !== '' ? state.stationError : (live?.error ?? ''),
    };
  }

  /** Re-derive the key and restart the relay link after a station change. */
  async function applyStationConfig() {
    await establishKey();
    state.relay?.restart({
      key: state.key,
      relayUrl: settings.relayUrl,
      token: settings.token,
      secret: state.keySecret,
      deviceName: settings.deviceName,
    });
  }

  /** Generate a station on this machine and join it. */
  async function createStation(preferPublic) {
    const cloudflared = await findCloudflared();
    if (cloudflared === undefined) {
      state.stationError = '没有找到 cloudflared：中继站只会在同一局域网内可加入';
    } else {
      state.stationError = '';
    }
    if (state.station === undefined) state.station = new RelayStation({ root, log });
    const result = await state.station.start({ preferPublic: preferPublic && cloudflared !== undefined });
    settings.stationUrl = result.baseUrl;
    settings.stationToken = result.token;
    settings.stationRole = 'host';
    // The host dials its own relay over loopback; `stationUrl` (the link) keeps
    // the shareable address for everyone else.
    settings.relayUrl = result.localUrl !== '' ? result.localUrl : result.baseUrl;
    settings.token = result.token;
    await store.setConfig({
      stationUrl: settings.stationUrl,
      stationToken: settings.stationToken,
      stationRole: 'host',
      relayUrl: settings.relayUrl,
      token: settings.token,
    });
    await applyStationConfig();
    log('info', `中继站已建立（${result.public ? '公网' : '局域网'}）：${result.baseUrl}`);
    return { ...result, link: stationLink(result.baseUrl, result.token) };
  }

  /** Join a station another machine generated. */
  async function joinStation(linkText) {
    const parsed = parseStationLink(linkText);
    await state.station?.stop().catch(() => undefined);
    state.station = undefined;
    state.stationError = '';
    settings.stationUrl = parsed.baseUrl;
    settings.stationToken = parsed.token;
    settings.stationRole = 'join';
    settings.relayUrl = parsed.baseUrl;
    settings.token = parsed.token;
    await store.setConfig({
      stationUrl: settings.stationUrl,
      stationToken: settings.stationToken,
      stationRole: 'join',
      relayUrl: settings.relayUrl,
      token: settings.token,
    });
    await applyStationConfig();
    log('info', `已加入中继站：${parsed.baseUrl}`);
    return { baseUrl: parsed.baseUrl, role: 'join' };
  }

  /** Stop hosting and forget the station. */
  async function stopStation() {
    await state.station?.stop().catch(() => undefined);
    state.station = undefined;
    state.stationError = '';
    settings.stationUrl = '';
    settings.stationToken = '';
    settings.stationRole = '';
    settings.relayUrl = '';
    settings.token = '';
    await store.setConfig({ stationUrl: '', stationToken: '', stationRole: '', relayUrl: '', token: '' });
    await applyStationConfig();
  }

  /* ------------------------------ self-update ------------------------------ */

  /* compareVersion lives at module scope so the update logic is testable. */

  /** Ask GitHub for the latest release. Never throws: the panel answers "unknown". */
  async function checkUpdate(force) {
    const persisted = store.getConfig();
    const last = Math.max(state.updateCheckedAt, Number(persisted.lastUpdateCheckAt ?? 0));
    if (!force && state.updateInfo !== undefined && Date.now() - last < UPDATE_INTERVAL_MS) return state.updateInfo;
    const info = {
      current: PLUGIN_VERSION,
      latest: '',
      outdated: false,
      url: '',
      command: '',
      checkedAt: Date.now(),
      error: '',
    };
    try {
      // Tags, not `releases/latest`: a release page is an optional nicety, but
      // every shipped version gets a tag, so tags are the authoritative list.
      const response = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/tags?per_page=50`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': `dsh-deep-connect/${PLUGIN_VERSION}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
      const body = await response.json();
      const latest = pickLatestVersion(body);
      info.latest = latest;
      info.url = latest === '' ? '' : `https://github.com/${UPDATE_REPO}/releases/tag/v${latest}`;
      info.outdated = latest !== '' && compareVersion(latest, PLUGIN_VERSION) > 0;
      info.command = latest === ''
        ? ''
        : `curl -fsSL https://cdn.jsdelivr.net/gh/${UPDATE_REPO}@v${latest}/install.sh | bash`;
    } catch (error) {
      info.error = error instanceof Error ? error.message : String(error);
    }
    state.updateInfo = info;
    state.updateCheckedAt = info.checkedAt;
    await store.setConfig({ lastUpdateCheckAt: info.checkedAt, latestVersion: info.latest }).catch(() => undefined);
    return info;
  }

  /* ------------------------------ phone gateway ------------------------------ */

  /** Ensure a stable token for the phone page (persisted, so the QR survives). */
  async function mobileToken() {
    if (settings.mobileToken === '') {
      settings.mobileToken = Buffer.from(await cryptoRandomBytes(24)).toString('base64url');
      await store.setConfig({ mobileToken: settings.mobileToken }).catch(() => undefined);
    }
    return settings.mobileToken;
  }

  /** Start the phone page, with a public tunnel when cloudflared exists. */
  async function enableMobile() {
    if (state.mobile?.gateway !== undefined) return mobileView();
    const token = await mobileToken();
    const gateway = new MobileGateway({
      token,
      log,
      onList: async () => {
        const view = await buildListView();
        return {
          self: { deviceId: view.self.deviceId, name: view.self.name },
          devices: [
            { deviceId: view.self.deviceId, name: view.self.name, online: true, isSelf: true, sessionCount: view.stats.local, shareMemory: view.self.shareMemory },
            ...view.peers.map((peer) => ({ deviceId: peer.deviceId, name: peer.name, online: peer.online, isSelf: false, sessionCount: peer.sessionCount, shareMemory: peer.shareMemory })),
          ],
          sessions: view.sessions.slice(0, 40).map((row) => ({
            sessionId: row.sessionId,
            ownerId: row.ownerId,
            ownerName: row.ownerName,
            title: row.title,
            eventCount: row.eventCount,
            live: row.live === true,
            tasks: row.tasks,
          })),
        };
      },
      onCommand: async (body) => {
        try {
          const action = String(body?.action ?? '');
          if (action === 'task') {
            const deviceId = String(body.deviceId ?? '');
            const text = String(body.text ?? '').trim();
            if (!deviceId || !text) return { ok: false, error: 'deviceId and text are required' };
            const reply = await command({ action: 'task-run', deviceId, text });
            return { ok: true, sessionId: reply.sessionId };
          }
          if (action === 'prompt') {
            const deviceId = String(body.deviceId ?? '');
            const sessionId = String(body.sessionId ?? '');
            const text = String(body.text ?? '').trim();
            const reply = await command({ action: 'prompt', deviceId, sessionId, text, mode: 'queue' });
            return { ok: true, deliveredTo: reply.deliveredTo };
          }
          return { ok: false, error: 'unknown action' };
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      },
    });
    await gateway.start();
    let tunnel;
    if (settings.mobileTunnel) {
      try {
        tunnel = await openTunnel(gateway.origin, { log });
      } catch {
        tunnel = undefined;
      }
    }
    if (tunnel !== undefined) gateway.expose(tunnel.publicUrl);
    state.mobile = { gateway, tunnel, error: '' };
    settings.mobileEnabled = true;
    await store.setConfig({ mobileEnabled: true, mobileToken: token }).catch(() => undefined);
    return mobileView();
  }

  /** Stop the phone page. */
  async function disableMobile() {
    const current = state.mobile;
    state.mobile = undefined;
    settings.mobileEnabled = false;
    await store.setConfig({ mobileEnabled: false }).catch(() => undefined);
    try {
      current?.tunnel?.close?.();
    } catch {
      /* gone */
    }
    await current?.gateway?.stop().catch(() => undefined);
    return mobileView();
  }

  /** The panel's view of phone access. */
  function mobileView() {
    const gateway = state.mobile?.gateway;
    const lan = lanAddress();
    const url = gateway === undefined || gateway.port === 0
      ? ''
      : gateway.link(lan === undefined ? '' : `http://${lan}:${gateway.port}`);
    return {
      enabled: settings.mobileEnabled === true && gateway !== undefined,
      url,
      public: gateway?.publicUrl !== undefined && gateway.publicUrl !== '',
      lan: lan === undefined ? '' : `http://${lan}:${gateway?.port ?? 0}`,
      error: state.mobile?.error ?? '',
    };
  }

  /** A tiny random-bytes helper that does not import the whole crypto module twice. */
  async function cryptoRandomBytes(size) {
    const { randomBytes } = await import('node:crypto');
    return randomBytes(size);
  }

  /**
   * Download and install the latest release in place.
   *
   * This is the "check and update" button: no copy-paste, no terminal. Files are
   * replaced under the running plugin; Node keeps the already-imported modules,
   * so the NEW code takes effect after Harness restarts, which the panel states.
   */
  async function applyUpdate() {
    const info = await checkUpdate(true);
    if (info.error !== '') throw badRequest(`检查更新失败：${info.error}`);
    if (info.latest === '' || compareVersion(info.latest, PLUGIN_VERSION) <= 0) {
      return { updated: false, version: PLUGIN_VERSION, latest: info.latest, restartRequired: false };
    }
    const response = await fetch(`https://codeload.github.com/${UPDATE_REPO}/tar.gz/refs/tags/v${info.latest}`, {
      headers: { 'user-agent': `dsh-deep-connect/${PLUGIN_VERSION}` },
      signal: AbortSignal.timeout(180_000),
    });
    if (!response.ok) throw badRequest(`下载 v${info.latest} 失败（HTTP ${response.status}）`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const work = join(root, 'update');
    await rm(work, { recursive: true, force: true });
    await mkdir(work, { recursive: true });
    const archive = join(work, 'repo.tgz');
    await writeFile(archive, bytes);
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xzf', archive, '-C', work], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar 退出码 ${code}`))));
    });
    const entries = await readdir(work, { withFileTypes: true });
    const extracted = entries.find((entry) => entry.isDirectory() && entry.name.startsWith('dsh-deep-connect-'));
    if (extracted === undefined) throw badRequest('更新包内容不完整（没有找到 dsh-deep-connect-*）');
    const source = join(work, extracted.name);
    const pluginDir = dirname(fileURLToPath(import.meta.url));
    const repoRoot = dirname(pluginDir);
    await cp(join(source, 'plugin'), pluginDir, { recursive: true, force: true });
    await cp(join(source, 'relay'), join(repoRoot, 'relay'), { recursive: true, force: true }).catch(() => undefined);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    log('info', `已更新到 v${info.latest}，重启 Harness 后生效`);
    return { updated: true, version: info.latest, restartRequired: true };
  }

  /** The panel's read model. */
  async function buildListView() {
    const identity = store.getIdentity();
    const relay = state.relay?.describe() ?? { connected: false, state: 'idle', relayUrl: '', channelShort: '', httpMode: false };
    const rows = await allRows();
    const peers = store.getPeers()
      .filter((peer) => peer.deviceId !== identity.deviceId)
      .map((peer) => ({
        deviceId: peer.deviceId,
        name: peer.name ?? peer.deviceId.slice(0, 8),
        online: peer.online === true,
        lastSeen: Number(peer.lastSeen ?? 0),
        fingerprint: '',
        sessionCount: rows.filter((row) => row.ownerId === peer.deviceId).length,
        shareMemory: state.peerShareMemory.get(peer.deviceId) !== false,
      }));
    return {
      self: {
        deviceId: identity.deviceId,
        name: identity.name !== '' ? identity.name : `未命名设备 ${identity.deviceId.slice(4, 10)}`,
        fingerprint: state.key === undefined ? '' : fingerprint(state.key),
        channelShort: relay.channelShort,
        relayUrl: relay.relayUrl,
        connected: relay.connected,
        state: relay.state,
        lastError: relay.lastError ?? '',
        keySource: state.keySource,
        accountName: state.accountName,
        outbox: relay.outbox ?? 0,
        httpMode: relay.httpMode === true,
        shareMemory: settings.shareMemory === true,
      },
      peers,
      sessions: rows,
      version: PLUGIN_VERSION,
      protocol: PROTOCOL_VERSION,
      edition: 'Pro',
      station: stationView(),
      mobile: mobileView(),
      update: state.updateInfo ?? {
        current: PLUGIN_VERSION,
        latest: '',
        outdated: false,
        url: '',
        command: '',
        checkedAt: Number(store.getConfig().lastUpdateCheckAt ?? 0),
        error: '',
      },
      stats: {
        local: rows.filter((row) => row.isRemote !== true).length,
        remote: rows.filter((row) => row.isRemote === true).length,
        peers: peers.length,
        onlinePeers: peers.filter((peer) => peer.online).length,
        // Auto-sync progress, so the panel can state it instead of implying it.
        remoteWithCopy: rows.filter((row) => row.isRemote === true && row.hasCopy === true).length,
        syncQueued: state.syncQueue.length,
        syncRunning: state.syncRunning === true,
        syncedAt: state.syncedAt,
      },
      sessionsAvailable: sessions.available,
      degraded: sessions.degraded,
      lastIndexAt: state.lastIndexAt,
      lastIndexError: state.lastIndexError,
    };
  }

  /**
   * One browser action.
   * @param {object} body - the decoded request body.
   */
  async function command(body) {
    const action = String(body?.action ?? '');
    if (action === 'list') return buildListView();

    if (action === 'configure') {
      const patch = {};
      for (const key of ['relayUrl', 'token', 'secret', 'deviceName']) {
        if (typeof body[key] === 'string') patch[key] = body[key];
      }
      for (const key of ['autoConnect', 'autoIndex', 'shareMemory']) {
        if (typeof body[key] === 'boolean') patch[key] = body[key];
      }
      const merged = await store.setConfig(patch);
      // `merged` is the PERSISTED config; a Loader-provided relayUrl (the normal
      // deployment) is not persisted, so copying it wholesale would erase the
      // live connection. Only take a value that is actually set.
      for (const key of ['relayUrl', 'token', 'secret', 'stationUrl', 'stationToken', 'stationRole', 'deviceName']) {
        // An explicit patch (even '') wins; otherwise only a non-empty persisted
        // value is adopted, so a Loader-provided relayUrl survives.
        if (typeof patch[key] === 'string') settings[key] = patch[key];
        else if (typeof merged[key] === 'string' && merged[key] !== '') settings[key] = merged[key];
      }
      settings.autoConnect = merged.autoConnect;
      settings.autoIndex = merged.autoIndex;
      settings.indexIntervalMs = merged.indexIntervalMs;
      settings.historyLimitEvents = merged.historyLimitEvents;
      settings.shareMemory = merged.shareMemory;
      if (patch.deviceName !== undefined) {
        settings.deviceName = patch.deviceName;
      }
      // A new passphrase changes the key, so it has to be re-derived before the
      // socket is restarted; otherwise the next frame would go out under the
      // old key and every peer would fail to open it.
      const established = await establishKey();
      state.relay?.restart({
        relayUrl: settings.relayUrl,
        token: settings.token,
        secret: state.keySecret,
        key: state.key,
        deviceName: settings.deviceName,
      });
      // A memory-sharing change must reach peers promptly: they gate their
      // inherit/body requests on the flag carried by the index.
      state.lastIndexAt = 0;
      void publishIndex({ force: true }).catch(() => undefined);
      if (!established.ok && established.reason === 'signed-out') {
        log('warn', '尚未登录 DeepSeek 账号，且没有设置口令，无法派生密钥');
      }
      return buildListView();
    }

    if (action === 'reconnect') {
      const established = await establishKey();
      if (!established.ok && established.reason === 'signed-out') {
        return { ok: true, warning: 'signed-out' };
      }
      state.relay?.restart({ key: state.key, relayUrl: settings.relayUrl, token: settings.token, secret: state.keySecret });
      return { ok: true };
    }

    if (action === 'history') {
      const deviceId = String(body.deviceId ?? '');
      const sessionId = String(body.sessionId ?? '');
      if (deviceId === '' || sessionId === '') throw badRequest('deviceId and sessionId are required');
      const local = store.getIdentity().deviceId;
      if (deviceId === local) {
        const exported = await sessions.exportTranscript(sessionId);
        if (exported === undefined) throw notFound(`session ${sessionId} is not readable on this machine`);
        return {
          sessionId,
          deviceId,
          title: exported.title,
          transcript: exported.transcript,
          eventCount: exported.eventCount,
          tasks: exported.tasks,
          fetchedAt: Date.now(),
          fromCache: false,
        };
      }
      const peer = store.getPeers().find((entry) => entry.deviceId === deviceId);
      const online = peer !== undefined && peer.online === true && state.relay?.connected === true;
      let cached = await store.getHistory(deviceId, sessionId);
      if (online) {
        // Cache first: the background sync already pulled every body, so opening
        // one must not depend on a live round trip. A copy is only re-fetched
        // when its (eventCount, updatedAt) no longer match the peer's index row.
        const document = await store.getRemoteIndex(deviceId);
        const row = (document?.entries ?? []).find((entry) => String(entry.sessionId) === sessionId);
        const fresh =
          cached !== undefined &&
          row !== undefined &&
          Number(cached.eventCount ?? 0) === Number(row.eventCount ?? 0) &&
          Number(cached.updatedAt ?? 0) === Number(row.updatedAt ?? 0);
        if (!fresh) {
          const reply = await askPeer(deviceId, { need: KIND.history, sessionId });
          if (reply !== undefined && reply.error === undefined) {
            await acceptIndexHistory(deviceId, reply);
            cached = await store.getHistory(deviceId, sessionId);
          }
        }
      }
      if (cached === undefined) {
        throw notFound(online ? '对端没有应答，请稍后重试' : '对端设备离线，且本地没有这份对话的副本');
      }
      return {
        sessionId,
        deviceId,
        title: cached.title ?? '',
        transcript: Array.isArray(cached.transcript) ? cached.transcript : [],
        eventCount: Number(cached.eventCount ?? 0),
        tasks: cached.tasks,
        fetchedAt: Number(cached.fetchedAt ?? 0),
        fromCache: true,
      };
    }

    if (action === 'prompt') {
      const deviceId = String(body.deviceId ?? '');
      const sessionId = String(body.sessionId ?? '');
      const text = String(body.text ?? '').trim();
      const mode = body.mode === 'steer' ? 'steer' : 'queue';
      if (deviceId === '' || sessionId === '' || text === '') throw badRequest('deviceId, sessionId and text are required');
      const local = store.getIdentity().deviceId;
      if (deviceId === local) throw badRequest('请在本机 DSH 界面里直接继续这条对话；Deep Connect 只替代远端输入');
      const peer = store.getPeers().find((entry) => entry.deviceId === deviceId);
      if (peer === undefined || peer.online !== true || state.relay?.connected !== true) {
        throw notFound('对端设备当前不在线，无法继续这条对话');
      }
      const reply = await askPeer(deviceId, { need: KIND.prompt, sessionId, text, mode });
      if (reply === undefined) throw notFound('对端没有在超时时间内确认，请稍后重试');
      if (reply.accepted !== true) throw badRequest(`对端拒绝执行：${String(reply.reason ?? 'unknown')}`);
      return { accepted: true, deliveredTo: deviceId };
    }

    if (action === 'inherit') {
      const deviceId = String(body.deviceId ?? '');
      const sessionId = String(body.sessionId ?? '');
      if (deviceId === '' || sessionId === '') throw badRequest('deviceId and sessionId are required');
      const local = store.getIdentity().deviceId;
      if (deviceId === local) throw badRequest('这条会话已经在本机，不需要继承');
      const peer = store.getPeers().find((entry) => entry.deviceId === deviceId);
      if (peer === undefined || peer.online !== true || state.relay?.connected !== true) {
        throw notFound('对端设备当前不在线，无法继承这条会话；等它上线后再试');
      }
      const persistence = ctx.get?.('sessionPersistence');
      if (persistence === undefined) {
        throw badRequest('这个部署没有挂载可写的会话存储（sessionPersistence），无法在本机落地继承的会话');
      }
      const reply = await askPeer(deviceId, { need: KIND.export, sessionId }, 90_000);
      if (reply === undefined) throw notFound('对端没有在超时时间内返回会话事件，请稍后重试');
      if (reply.error === 'too-large') {
        throw badRequest(`这条会话的原始事件有 ${Number(reply.bytes ?? 0)} 字节，超过单次传输上限 ${MAX_EXPORT_BYTES} 字节`);
      }
      if (reply.error !== undefined) throw notFound(`对端无法导出这条会话：${String(reply.error)}`);
      const created = await createInheritedSession({ persistence, ctx, payload: reply, log });
      // The new session is local, so the panel's merged view must be rebuilt for
      // it to show up without waiting for the next index tick.
      state.lastIndexAt = 0;
      setTimeout(() => void publishIndex({ force: true }), 300).unref?.();
      return {
        sessionId: created.sessionId,
        sourceSessionId: sessionId,
        sourceDeviceId: deviceId,
        title: typeof reply.title === 'string' ? reply.title : '',
        eventCount: created.eventCount,
        cwd: created.cwd,
      };
    }

    if (action === 'task-run') {
      const deviceId = String(body.deviceId ?? '');
      const text = String(body.text ?? '').trim();
      if (deviceId === '' || text === '') throw badRequest('deviceId and text are required');
      if (deviceId === store.getIdentity().deviceId) throw badRequest('这台就是本机，请直接在 DSH 里执行');
      const peer = store.getPeers().find((entry) => entry.deviceId === deviceId);
      if (peer === undefined || peer.online !== true || state.relay?.connected !== true) {
        throw notFound('对端设备当前不在线，无法下发任务');
      }
      const reply = await askPeer(deviceId, { need: KIND.task, text }, 60_000);
      if (reply === undefined) throw notFound('对端没有在超时时间内确认，请稍后重试');
      if (reply.accepted !== true) throw badRequest(`对端拒绝执行：${String(reply.reason ?? 'unknown')}`);
      return { accepted: true, sessionId: String(reply.sessionId ?? ''), deviceId };
    }

    if (action === 'station-create') {
      const station = await createStation(body.public !== false);
      return { station, view: await buildListView() };
    }

    if (action === 'station-join') {
      const station = await joinStation(String(body.link ?? ''));
      return { station, view: await buildListView() };
    }

    if (action === 'station-stop') {
      await stopStation();
      return buildListView();
    }

    if (action === 'mobile-enable') {
      const mobile = await enableMobile();
      return { mobile, view: await buildListView() };
    }

    if (action === 'mobile-disable') {
      const mobile = await disableMobile();
      return { mobile, view: await buildListView() };
    }

    if (action === 'update-check') {
      return checkUpdate(body.force === true);
    }

    if (action === 'update-install') {
      return applyUpdate();
    }

    if (action === 'forget-peer') {
      const deviceId = String(body.deviceId ?? '');
      if (deviceId === '') throw badRequest('deviceId is required');
      await store.dropPeerHistory(deviceId);
      return buildListView();
    }

    throw badRequest(`unknown action "${action}"`);
  }

  /** Build the error shapes the browser half already knows how to render. */
  function badRequest(message) {
    const error = new Error(message);
    error.code = 'bad-request';
    return error;
  }
  function notFound(message) {
    const error = new Error(message);
    error.code = 'not-found';
    return error;
  }

  /* -------------------------------- lifecycle -------------------------------- */

  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(
      () =>
        connectionCtx.connection.fetch.register({
          path: API_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: async (request) => {
            let body;
            try {
              body = await request.json();
            } catch {
              return Response.json({ ok: false, error: { code: 'bad-request', message: 'body is not JSON' } }, { status: 400 });
            }
            try {
              return Response.json({ ok: true, value: await command(body) });
            } catch (error) {
              const code = error?.code ?? 'internal';
              const status = code === 'bad-request' ? 400 : code === 'not-found' ? 404 : 500;
              const message = error instanceof Error ? error.message : String(error);
              log('warn', `处理浏览器请求失败：${message}`);
              return Response.json({ ok: false, error: { code, message } }, { status });
            }
          },
        }),
      'deep-connect: browser API route',
    );
  });

  /* Index on every committed append, throttled. This is the only hook that sees
   * a conversation change the moment it happens; `publishIndex` decides whether
   * enough time has passed to be worth a broadcast. */
  ctx.inject(['sessions'], (sessionCtx) => {
    sessionCtx.effect(
      () =>
        sessionCtx.on('session/event', () => {
          if (!state.started || !settings.autoIndex) return;
          // A listener must never throw into the session append path, and must
          // never do its work inline.
          void publishIndex().catch((error) => log('warn', `索引更新失败：${error instanceof Error ? error.message : String(error)}`));
        }),
      'deep-connect: session append trigger',
    );
  });

  ctx.effect(() => {
    void (async () => {
      await store.load().catch((e) => { throw new Error("store.load: " + e.message); });
      const persisted = store.getConfig();
      // v3: a station is the only normal way in. The legacy `relayUrl`/`secret`
      // pair still works when a deployment passes it explicitly (tests, a VPS
      // operator editing the Loader row); the panel no longer offers it.
      settings.stationUrl = settings.stationUrl || persisted.stationUrl;
      settings.stationToken = settings.stationToken || persisted.stationToken;
      settings.stationRole = settings.stationRole || persisted.stationRole;
      if (settings.stationRole === 'host') {
        // The station processes are detached, so an in-place update keeps the
        // link alive. Adopt them when they still answer; only ask for a fresh
        // station when they are really gone.
        const adopted = await adoptStation({ root, log }).catch(() => undefined);
        if (adopted !== undefined) {
          state.station = adopted;
          state.stationAdopted = true;
          settings.stationUrl = adopted.baseUrl;
          settings.stationToken = adopted.token;
          settings.relayUrl = adopted.localUrl;
          settings.token = adopted.token;
        } else {
          settings.stationUrl = '';
          settings.stationToken = '';
          settings.stationRole = '';
          settings.relayUrl = '';
          settings.token = '';
          state.stationError = '本机上次生成的中继站已经不在了：请重新生成，并把新链接发给其他设备';
          await store.setConfig({ stationUrl: '', stationToken: '', stationRole: '', relayUrl: '', token: '' }).catch(() => undefined);
        }
      } else if (settings.stationToken !== '') {
        settings.relayUrl = settings.stationUrl;
        settings.token = settings.stationToken;
      } else if (String(config?.relayUrl ?? '').trim() === '') {
        // No station, no explicit relay: stay offline and let the panel show the
        // two station buttons instead of silently dialing a stale legacy URL.
        settings.relayUrl = '';
        settings.token = '';
      }
      // No relayUrl fallback: under v3 a missing station must stay offline, not
      // resurrect the pre-v3 address that no v3 peer can talk to.
      settings.token = settings.token || persisted.token;
      settings.secret = settings.secret || persisted.secret;
      settings.deviceName = settings.deviceName || persisted.deviceName || '';
      settings.autoConnect = persisted.autoConnect;
      settings.autoIndex = persisted.autoIndex;
      settings.indexIntervalMs = persisted.indexIntervalMs;
      settings.historyLimitEvents = persisted.historyLimitEvents;
      const established = await establishKey();
      if (!established.ok && established.reason === 'signed-out') {
        log('warn', '未登录 DeepSeek 账号且未设置口令：Deep Connect 已就绪，但不会连接中继，直到登录或设置口令');
      }
      const relay = new RelayClient({
        store,
        key: state.key,
        heartbeatMs: settings.heartbeatMs,
        secret: state.keySecret,
        token: settings.token,
        relayUrl: settings.relayUrl,
        deviceName: settings.deviceName,
        deviceId: store.getIdentity().deviceId,
        log,
        onFrame,
        onRoster: async (devices) => {
          const identity = store.getIdentity();
          await store.setPeers(
            devices
              .filter((device) => device.id !== identity.deviceId)
              .map((device) => ({
                deviceId: String(device.id),
                name: typeof device.name === 'string' && device.name !== '' ? device.name : String(device.id).slice(0, 8),
                online: device.online === true,
                lastSeen: Number(device.lastSeen ?? Date.now()),
              })),
          );
          // A peer that just came online may already have a cached index from
          // before it went away; pull whatever is missing without waiting for
          // its next broadcast.
          for (const device of devices) {
            if (device.id === identity.deviceId || device.online !== true) continue;
            const document = await store.getRemoteIndex(String(device.id)).catch(() => undefined);
            if (document !== undefined) {
              state.peerShareMemory.set(String(device.id), document.shareMemory !== false);
              queuePeerSync(String(device.id), document.entries ?? []);
            }
          }
        },
        onState: () => {
          /* The panel polls `list`, so connection state needs no separate push. */
        },
      });
      state.relay = relay;
      state.started = true;
      // A device that just joined has no idea who else is here; say hello with
      // the current index so the newcomer sees this machine immediately.
      relay.start();
      if (settings.autoIndex && sessions.available) {
        await publishIndex({ force: true });
      }
      // Give the roster a moment to arrive, then drain whatever the previous
      // run left unfinished.
      setTimeout(() => {
        void syncFromCachedIndices().catch((error) =>
          log('warn', `补同步失败：${error instanceof Error ? error.message : String(error)}`),
        );
      }, 1_500).unref?.();
      ctx.interval(() => {
        void publishIndex();
      }, settings.indexIntervalMs);
      // v3: ask GitHub once in the background. A failure is silent here; the
      // panel still shows the checked timestamp and "无法检查更新" when asked.
      setTimeout(() => {
        void checkUpdate(false).catch(() => undefined);
      }, 5_000).unref?.();
      if (settings.mobileEnabled) {
        setTimeout(() => {
          void enableMobile().catch((error) => log('warn', `手机管理页启动失败：${error instanceof Error ? error.message : String(error)}`));
        }, 4_000).unref?.();
      }
    })().catch((error) => log('warn', `Deep Connect 启动失败：${error instanceof Error ? error.message : String(error)}`));
    return () => {
      state.started = false;
      state.relay?.stop();
      state.relay = undefined;
      void state.station?.stop().catch(() => undefined);
      state.station = undefined;
      try {
        state.mobile?.tunnel?.close?.();
      } catch {
        /* gone */
      }
      void state.mobile?.gateway?.stop().catch(() => undefined);
      state.mobile = undefined;
    };
  }, 'deep-connect: relay lifecycle');

  /* Exposed for the offline test harness: it drives a real plugin instance with
   * a stub context and asserts on these, which is the only way to test this
   * half without booting the whole Harness. */
  return { command, publishIndex, store, sessions, state, buildListView, queuePeerSync, runSyncQueue, serveExport, compareVersion, checkUpdate, applyUpdate, enableMobile, disableMobile };
}
