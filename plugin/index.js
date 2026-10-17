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
import { channelFor, deriveKey, deriveKeyPbkdf2, fingerprint, frameId, PROTOCOL_VERSION } from './host/crypto.js';

export const name = 'deep-connect';

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
  ping: 'ping',
};

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
    autoConnect: config?.autoConnect !== false,
    autoIndex: config?.autoIndex !== false,
    indexIntervalMs: Math.max(5000, Number(config?.indexIntervalMs ?? 15000)),
    historyLimitEvents: Math.max(200, Number(config?.historyLimitEvents ?? 20_000)),
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
    /** Which secret the current key came from: 'account' | 'passphrase' | undefined. */
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
    const configured = settings.secret.trim();
    if (configured !== '') {
      state.key = await deriveKeyPbkdf2(configured);
      state.keySource = 'passphrase';
      state.accountId = undefined;
      log('info', `已用口令派生密钥，指纹 ${fingerprint(state.key)}`);
      return { ok: true };
    }
    const accountId = await readAccountId();
    if (accountId === undefined) {
      state.key = undefined;
      state.keySource = undefined;
      return { ok: false, reason: 'signed-out' };
    }
    state.accountId = accountId;
    state.key = await deriveKeyPbkdf2(accountId);
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
      await sendTo('*', { kind: KIND.index, deviceId: identity.deviceId, deviceName: identity.name, at: now, entries: state.localIndex });
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
      entries: Array.isArray(payload.entries) ? payload.entries : [],
    };
    await store.setRemoteIndex(from, document);
    log('debug', `收到 ${document.deviceName} 的索引：${document.entries.length} 条`);
  }

  /** Answer a peer's request for one conversation body. */
  async function serveHistory(from, payload, requestId) {
    const sessionId = String(payload?.sessionId ?? '');
    if (sessionId === '') return;
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
        rows.push({
          ...entry,
          ownerId: peer.deviceId,
          ownerName: document.deviceName ?? peer.name ?? peer.deviceId.slice(0, 8),
          isRemote: true,
        });
      }
    }
    return rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
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
      },
      peers,
      sessions: rows,
      stats: {
        local: rows.filter((row) => row.isRemote !== true).length,
        remote: rows.filter((row) => row.isRemote === true).length,
        peers: peers.length,
        onlinePeers: peers.filter((peer) => peer.online).length,
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
      for (const key of ['autoConnect', 'autoIndex']) {
        if (typeof body[key] === 'boolean') patch[key] = body[key];
      }
      const merged = await store.setConfig(patch);
      Object.assign(settings, merged);
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
        secret: settings.secret,
        key: state.key,
        deviceName: settings.deviceName,
      });
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
      state.relay?.restart({ key: state.key, relayUrl: settings.relayUrl, token: settings.token, secret: settings.secret });
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
      if (peer !== undefined && peer.online === true && state.relay?.connected === true) {
        const reply = await askPeer(deviceId, { need: KIND.history, sessionId });
        if (reply !== undefined && reply.error === undefined) {
          await acceptIndexHistory(deviceId, reply);
        }
      }
      const cached = await store.getHistory(deviceId, sessionId);
      if (cached === undefined) {
        throw notFound(peer !== undefined && peer.online === true ? '对端没有应答，请稍后重试' : '对端设备离线，且本地没有这份对话的副本');
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
      settings.relayUrl = settings.relayUrl || persisted.relayUrl;
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
        secret: settings.secret !== '' ? settings.secret : (state.accountId ?? ''),
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
      ctx.interval(() => {
        void publishIndex();
      }, settings.indexIntervalMs);
    })().catch((error) => log('warn', `Deep Connect 启动失败：${error instanceof Error ? error.message : String(error)}`));
    return () => {
      state.started = false;
      state.relay?.stop();
      state.relay = undefined;
    };
  }, 'deep-connect: relay lifecycle');

  /* Exposed for the offline test harness: it drives a real plugin instance with
   * a stub context and asserts on these, which is the only way to test this
   * half without booting the whole Harness. */
  return { command, publishIndex, store, sessions, state, buildListView };
}
