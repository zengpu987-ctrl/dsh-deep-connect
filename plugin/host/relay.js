/**
 * Deep Connect — this device's connection to the cloud relay.
 *
 * One outbound WebSocket, nothing inbound. That is the whole reason this design
 * needs no port forwarding, no public IP and no inbound firewall rule: the
 * relay is just a meeting point both sides dial out to.
 *
 * The relay is treated as hostile-but-useful. It routes envelopes, and it may
 * drop, duplicate, reorder or hold them; it cannot read them. Every failure
 * mode here is therefore a *delivery* problem, never a trust problem:
 *
 *   - offline  -> envelopes queue in the store's outbox and drain on reconnect
 *   - flapping -> exponential backoff with jitter, capped
 *   - duplicate -> a bounded seen-id set drops the second copy
 *
 * When a deployment forbids outbound WebSocket (a locked-down corporate proxy,
 * say), `httpMode` switches to the relay's mailbox API: POST to send, long-poll
 * to receive. Same envelopes, worse latency, no socket.
 *
 * @module dsh-deep-connect/relay
 */
import { channelFor, open as openFrame, seal, frameId, PROTOCOL_VERSION } from './crypto.js';

/** Reconnect backoff bounds, in milliseconds. */
const BACKOFF_MIN_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
/** How long one request/response exchange waits before giving up. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** Bounded memory of recently handled envelope ids, so duplicates are cheap to drop. */
const SEEN_LIMIT = 2000;
/** Default liveness probe cadence. The relay answers every `ping` with a `pong`. */
const DEFAULT_HEARTBEAT_MS = 20_000;

/** Add `channel`, `token` and the wire protocol to a relay URL as query parameters. */
export function relayUrlWithChannel(baseUrl, channel, token) {
  const url = new URL(baseUrl);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  url.searchParams.set('channel', channel);
  url.searchParams.set('proto', String(PROTOCOL_VERSION));
  if (token !== '') url.searchParams.set('token', token);
  return url.toString();
}

/**
 * The relay link for one device.
 *
 * `onFrame` is called with `{ from, payload }` for every envelope that
 * authenticates; `onRoster` with the relay's device list whenever it changes.
 */
export class RelayClient {
  /**
   * @param {object} options - see the constructor call in index.js.
   */
  constructor(options) {
    this.store = options.store;
    this.secret = options.secret;
    this.token = String(options.token ?? '');
    this.relayUrl = String(options.relayUrl ?? '');
    this.deviceName = String(options.deviceName ?? '');
    this.log = options.log ?? (() => {});
    this.onFrame = options.onFrame ?? (() => {});
    this.onRoster = options.onRoster ?? (() => {});
    this.onState = options.onState ?? (() => {});
    this.httpMode = options.httpMode === true;

    this.channel = channelFor(this.secret);
    this.key = options.key;
    this.deviceId = options.deviceId;
    /** @type {WebSocket|undefined} */
    this.socket = undefined;
    this.connected = false;
    this.state = 'idle';
    /** lastError is surfaced verbatim in the panel; a silent reconnect loop is a bad experience. */
    this.lastError = '';
    this.lastConnectedAt = 0;
    /** envelopeId -> { resolve, reject, timer } for request/response exchanges. */
    this.pending = new Map();
    this.seen = new Set();
    this.backoff = BACKOFF_MIN_MS;
    this.retryTimer = undefined;
    this.pollerAbort = new AbortController();
    this.closed = false;
    this.draining = false;
    /** Set by any inbound frame; the heartbeat clears it before each probe. */
    this.sawTraffic = false;
    this.heartbeat = undefined;
    this.heartbeatTicks = 0;
    this.heartbeatMs = Math.max(1000, Number(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS));
    /** When the relay last answered a liveness probe; the round-trip proof. */
    this.lastPongAt = 0;
  }

  /** The relay-visible connection facts, for the panel. */
  describe() {
    return {
      connected: this.connected,
      state: this.state,
      relayUrl: this.relayUrl,
      channelShort: `${this.channel.slice(0, 12)}…`,
      lastError: this.lastError,
      lastConnectedAt: this.lastConnectedAt,
      outbox: this.store?.outboxSize?.() ?? 0,
      httpMode: this.httpMode,
    };
  }

  /**
   * Prove the link works RIGHT NOW, by completing a ping/pong round trip.
   *
   * A time-based "the socket looks old enough" check cannot tell a good socket
   * from a half-open one left over from before a relay restart: both report
   * `connected` and `readyState === 1`, and writes into the dead one vanish
   * silently. A completed round trip is positive evidence, and it is the only
   * thing worth waiting for before a request/response exchange.
   * @param {number} timeoutMs - how long to keep probing before giving up.
   * @returns {Promise<boolean>} whether a pong came back.
   */
  async waitForLiveness(timeoutMs = 8000) {
    if (this.httpMode) {
      // The mailbox path has no ping frame; a successful read is its own proof.
      return this.connected;
    }
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.socket !== undefined && this.socket.readyState === 1) {
        const sentAt = Date.now();
        if (this.#sendRaw({ type: 'ping' })) {
          const waitUntil = Math.min(deadline, sentAt + 1500);
          while (Date.now() < waitUntil) {
            if (this.lastPongAt >= sentAt) return true;
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, 50);
              timer.unref?.();
            });
          }
        }
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 200);
        timer.unref?.();
      });
    }
  }

  /** Move to a new state and tell the panel. */
  #setState(state, error) {
    this.state = state;
    if (error !== undefined) this.lastError = error;
    this.onState(this.describe());
  }

  /** Begin connecting, or reconnect if the endpoint changed. */
  start() {
    this.closed = false;
    if (this.relayUrl === '') {
      this.#setState('unconfigured', '');
      return;
    }
    if (this.httpMode) {
      void this.#pollLoop();
      return;
    }
    this.#connect();
  }

  /** Drop the current socket and start over with fresh settings. */
  restart({ relayUrl, token, secret, key, deviceName } = {}) {
    this.stop();
    if (relayUrl !== undefined) this.relayUrl = String(relayUrl);
    if (token !== undefined) this.token = String(token);
    if (secret !== undefined) {
      this.secret = String(secret);
      this.channel = channelFor(this.secret);
    }
    if (key !== undefined) this.key = key;
    if (deviceName !== undefined) this.deviceName = String(deviceName);
    this.closed = false;
    this.pollerAbort = new AbortController();
    this.start();
  }

  /** Close the socket, cancel timers, and reject anything still waiting. */
  stop() {
    this.closed = true;
    this.#stopHeartbeat();
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.pollerAbort.abort();
    if (this.socket !== undefined) {
      try {
        this.socket.close(1000, 'reconfigured');
      } catch {
        /* already closing */
      }
      this.socket = undefined;
    }
    this.connected = false;
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(this.lastError === '' ? 'relay disconnected' : this.lastError));
    }
    this.pending.clear();
  }

  /* ------------------------------ connecting ------------------------------ */

  #connect() {
    if (this.closed) return;
    if (typeof globalThis.WebSocket !== 'function') {
      // Node >= 22 ships a global WebSocket; a deployment without it must use
      // the mailbox path rather than silently never connecting.
      this.httpMode = true;
      this.#setState('connecting', '此运行时没有全局 WebSocket，已切换到中继邮箱模式');
      void this.#pollLoop();
      return;
    }
    let socket;
    try {
      socket = new WebSocket(relayUrlWithChannel(this.relayUrl, this.channel, this.token));
    } catch (error) {
      this.#setState('error', `中继地址无效：${error instanceof Error ? error.message : String(error)}`);
      this.#scheduleRetry();
      return;
    }
    this.socket = socket;
    this.#setState('connecting', '');
    socket.addEventListener('open', () => {
      this.connected = true;
      this.backoff = BACKOFF_MIN_MS;
      this.lastConnectedAt = Date.now();
      this.lastError = '';
      this.#setState('connected', '');
      this.#sendRaw({ type: 'hello', deviceId: this.deviceId, name: this.deviceName });
      void this.#drainOutbox();
      this.#startHeartbeat();
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      this.sawTraffic = true;
      this.#handle(message);
    });
    socket.addEventListener('error', () => {
      // The error event carries no useful detail in most runtimes; the close
      // event that follows is what we act on.
    });
    socket.addEventListener('close', () => {
      this.connected = false;
      this.#stopHeartbeat();
      if (this.closed) return;
      this.#setState('disconnected', this.lastError === '' ? '与中继的连接已断开' : this.lastError);
      this.#scheduleRetry();
    });
  }

  /**
   * Start the liveness probe.
   *
   * A TCP connection to a relay that has gone away does not necessarily report
   * itself as closed: the socket stays "open" locally and `send()` keeps
   * accepting bytes into the kernel buffer that will never arrive. Without a
   * probe, every frame written into that hole is lost silently and a
   * request/response exchange just times out with no explanation.
   *
   * So: `ping` every `heartbeatMs`, and if nothing at all has come back within
   * the window, tear the socket down and let the reconnect path run.
   * It is cheap — one tiny frame — and it bounds the silent-loss window to one
   * heartbeat instead of leaving it open forever.
   */
  #startHeartbeat() {
    this.#stopHeartbeat();
    let awaitingPong = false;
    this.heartbeatTicks = 0;
    this.heartbeat = setInterval(() => {
      this.heartbeatTicks += 1;
      if (this.socket === undefined) return;
      if (this.socket.readyState !== 1) {
        // Already closing or closed: make sure the reconnect path actually runs
        // rather than waiting on a close handshake that will never complete.
        this.#abandonSocket('socket left the open state');
        return;
      }
      if (awaitingPong && !this.sawTraffic) {
        this.#abandonSocket('与中继的连接已失去响应（心跳超时）');
        return;
      }
      // Probe first, judge on the NEXT tick: a ping that has not been answered
      // yet is not evidence of failure, but a ping the relay never answers is.
      this.sawTraffic = false;
      awaitingPong = true;
      this.#sendRaw({ type: 'ping' });
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  /**
   * Tear down the current socket so the reconnect path runs.
   *
   * `WebSocket.close()` on a connection whose peer is already gone starts a
   * closing handshake that never completes, and the `close` event — which is
   * what schedules the retry — never fires. So close politely, then destroy the
   * socket underneath it. Without that, a device whose relay restarted stays
   * wedged with `connected === true` and a socket that silently eats writes.
   * @param {string} reason - wording surfaced to the panel.
   */
  #abandonSocket(reason) {
    const socket = this.socket;
    if (socket === undefined) return;
    this.lastError = reason;
    this.connected = false;
    this.socket = undefined;
    this.#stopHeartbeat();
    try {
      socket.close(4000, 'liveness');
    } catch {
      /* already closing */
    }
    const terminate = () => {
      try {
        socket.terminate?.();
      } catch {
        /* ignore */
      }
    };
    // Node's global WebSocket has no `terminate`; dropping the last reference
    // plus the close call is what we have. Give the handshake a beat, then stop
    // depending on it.
    setTimeout(terminate, 500).unref?.();
    this.#setState('disconnected', reason);
    this.#scheduleRetry();
  }

  /** Stop the liveness probe. */
  #stopHeartbeat() {
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  /** Exponential backoff with full jitter, so N devices do not reconnect in lockstep. */
  #scheduleRetry() {
    if (this.closed || this.retryTimer !== undefined) return;
    const delay = Math.round(BACKOFF_MIN_MS + Math.random() * (this.backoff - BACKOFF_MIN_MS));
    this.backoff = Math.min(BACKOFF_MAX_MS, this.backoff * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.#connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** Handle one relay frame. */
  #handle(message) {
    switch (message?.type) {
      case 'welcome':
        this.#setState('connected', '');
        break;
      case 'pong':
        this.lastPongAt = Date.now();
        break;
      case 'presence':
        if (Array.isArray(message.devices)) this.onRoster(message.devices);
        break;
      case 'message': {
        const envelope = message.envelope;
        if (envelope === undefined) return;
        if (this.seen.has(envelope.id)) return;
        this.seen.add(envelope.id);
        if (this.seen.size > SEEN_LIMIT) {
          const oldest = this.seen.values().next().value;
          this.seen.delete(oldest);
        }
        const payload = openFrame(this.key, envelope, envelope.body);
        if (payload === undefined) {
          // A frame that will not open is either for a different key generation
          // or was altered in transit. Both are worth saying out loud.
          this.log('warn', `丢弃无法解密的信封 ${String(envelope.id)}（来自 ${String(envelope.from)}）`);
          return;
        }
        const waiter = this.pending.get(envelope.id);
        if (waiter !== undefined) {
          clearTimeout(waiter.timer);
          this.pending.delete(envelope.id);
          waiter.resolve({ from: String(envelope.from ?? ''), payload });
          return;
        }
        try {
          this.onFrame({ from: String(envelope.from ?? ''), payload });
        } catch (error) {
          this.log('warn', `处理信封失败：${error instanceof Error ? error.message : String(error)}`);
        }
        break;
      }
      case 'sent':
        break;
      case 'error':
        this.log('warn', `中继拒绝了一条帧：${String(message.code)}`);
        break;
      default:
        break;
    }
  }

  /* -------------------------------- sending -------------------------------- */

  /** Write one already-built relay frame. */
  #sendRaw(frame) {
    if (this.socket === undefined || !this.connected) return false;
    try {
      this.socket.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Seal one payload into an envelope and hand it to the relay, queueing it
   * when the relay is unreachable.
   * @param {string} to - the target device id, or `'*'` to broadcast.
   * @param {object} payload - any JSON-serializable value.
   * @param {{ id?: string, waitForReply?: boolean, timeoutMs?: number }} [options]
   * @returns {Promise<{delivered: boolean, reply?: object}>}
   */
  async send(to, payload, options = {}) {
    const id = options.id ?? frameId('e');
    const envelope = {
      id,
      from: this.deviceId,
      to,
      at: Date.now(),
      ttlMs: 7 * 24 * 3600 * 1000,
    };
    envelope.body = seal(this.key, envelope, payload);

    if (this.httpMode) {
      const ok = await this.#httpSend(envelope);
      this.#remember(id);
      if (!ok && this.store !== undefined) await this.store.queueOutbox(envelope);
      return { delivered: ok };
    }

    if (!this.#sendRaw({ type: 'send', envelope })) {
      // Queue first, resolve optimistically: the caller cares that the payload
      // is durable, not that a socket was writable this instant.
      if (this.store !== undefined) await this.store.queueOutbox(envelope);
      return { delivered: false };
    }
    if (options.waitForReply !== true) return { delivered: true };
    const reply = await this.#awaitReply(id, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    return { delivered: true, reply };
  }

  /** Remember an id we generated, so our own broadcast echo is dropped. */
  #remember(id) {
    this.seen.add(id);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      this.seen.delete(oldest);
    }
  }

  /** Await one correlated reply. */
  #awaitReply(id, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject: () => resolve(undefined), timer });
    });
  }

  /**
   * Answer a request by replying to its envelope id. The correlation id is the
   * request's own id, so the sender needs no extra bookkeeping and a duplicate
   * answer is harmless.
   * @param {string} to - the asking device.
   * @param {string} requestId - the envelope id to answer.
   * @param {object} payload - the answer payload.
   */
  async reply(to, requestId, payload) {
    return this.send(to, payload, { id: requestId });
  }

  /** Push everything the outbox held while the relay was away. */
  async #drainOutbox() {
    if (this.draining || this.store === undefined) return;
    this.draining = true;
    try {
      const queued = await this.store.takeOutbox();
      for (const envelope of queued) {
        const sent = this.#sendRaw({ type: 'send', envelope });
        if (!sent) {
          // The link dropped mid-drain: put this one back and stop, or we lose it.
          await this.store.queueOutbox(envelope);
          break;
        }
      }
    } finally {
      this.draining = false;
    }
  }

  /* ------------------------------ mailbox mode ------------------------------ */

  /** POST one envelope to the mailbox API. */
  async #httpSend(envelope) {
    try {
      const response = await fetch(new URL('/v1/send', this.relayUrl).toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dsh-connect-channel': this.channel,
          ...(this.token === '' ? {} : { 'x-dsh-connect-token': this.token }),
        },
        body: JSON.stringify({ deviceId: this.deviceId, name: this.deviceName, ...envelope }),
      });
      return response.ok;
    } catch (error) {
      this.#setState('disconnected', `中继不可达：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** Long-poll the mailbox, forever, until stopped. */
  async #pollLoop() {
    const signal = this.pollerAbort.signal;
    // Drain anything queued while the previous generation was down.
    if (this.store !== undefined) {
      for (const envelope of await this.store.takeOutbox()) await this.#httpSend(envelope);
    }
    while (!this.closed && !signal.aborted) {
      try {
        const response = await fetch(new URL('/v1/recv', this.relayUrl).toString(), {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-dsh-connect-channel': this.channel,
            ...(this.token === '' ? {} : { 'x-dsh-connect-token': this.token }),
          },
          body: JSON.stringify({ deviceId: this.deviceId, name: this.deviceName, waitMs: 20_000 }),
        });
        if (!response.ok) {
          this.connected = false;
          this.#setState('error', `中继返回 ${response.status}`);
          await delay(3000, signal);
          continue;
        }
        const body = await response.json();
        this.connected = true;
        this.lastError = '';
        // Only the transition into "connected" resets the clock; steady-state
        // polling must not, or the settle window would never elapse.
        if (!this.connected) {
          this.connected = true;
          this.lastConnectedAt = Date.now();
          this.lastError = '';
          this.#setState('connected', '');
        }
        if (Array.isArray(body.devices)) this.onRoster(body.devices);
        for (const envelope of body.messages ?? []) {
          if (this.seen.has(envelope.id)) continue;
          this.seen.add(envelope.id);
          const payload = openFrame(this.key, envelope, envelope.body);
          if (payload === undefined) continue;
          const waiter = this.pending.get(envelope.id);
          if (waiter !== undefined) {
            clearTimeout(waiter.timer);
            this.pending.delete(envelope.id);
            waiter.resolve({ from: String(envelope.from ?? ''), payload });
            continue;
          }
          try {
            this.onFrame({ from: String(envelope.from ?? ''), payload });
          } catch (error) {
            this.log('warn', `处理信封失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } catch (error) {
        if (signal.aborted || this.closed) return;
        this.connected = false;
        this.#setState('error', `中继不可达：${error instanceof Error ? error.message : String(error)}`);
        await delay(3000, signal);
      }
    }
  }
}

/** Sleep, abortable. */
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
