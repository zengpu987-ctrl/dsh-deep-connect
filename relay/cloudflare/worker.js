/**
 * Deep Connect relay — Cloudflare Workers + Durable Objects.
 *
 * One Durable Object instance per channel, addressed by the channel hash that
 * stands for one DeepSeek account. The object is a dumb router and mailbox: it
 * moves opaque ciphertext between devices and remembers what it could not
 * deliver. A WebSocket hibernation means an idle-but-connected device is not
 * billed for duration, which is what makes the free plan comfortable for a
 * handful of desktops.
 *
 * NOT VERIFIED ON THIS MACHINE. `workers.dev` is DNS-poisoned from mainland
 * China, and there was no Cloudflare account to deploy against, so this file is
 * written to the documented API but has never been run. Treat the first
 * `wrangler deploy` as the real test. The self-hosted `relay.cjs` is the tested
 * implementation and speaks the same protocol.
 *
 * Deploy:
 *   cd relay/cloudflare
 *   npx wrangler deploy
 *   # then attach a CUSTOM DOMAIN. Never hand out a *.workers.dev hostname from
 *   # mainland China: it does not resolve there.
 *
 * Wire protocol (identical to relay.cjs):
 *   client -> server  {type:'hello', deviceId, name}
 *                     {type:'send', envelope}
 *                     {type:'ping'}
 *   server -> client  {type:'open'|'welcome'|'presence'|'message'|'sent'|'pong'|'error'}
 *   HTTP              GET  /healthz, /v1/devices
 *                     POST /v1/send, /v1/recv, /v1/ack
 *   header            x-dsh-connect-channel: <64 hex>
 *
 * @typedef {{id: string, from: string, to: string, at: number, ttlMs: number, body: string, seq?: number, expiresAt?: number}} Envelope
 */

const MAX_MAILBOX = 512;
const MAX_BODY_BYTES = 24 * 1024 * 1024;

export default {
  /**
   * Route one request to the channel's Durable Object.
   * @param {Request} request - the inbound request.
   * @param {{RELAY_OBJECT: DurableObjectNamespace}} env - bindings.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return json({ ok: true, relay: 'cloudflare-durable-object' });
    }
    const channel = request.headers.get('x-dsh-connect-channel') ?? url.searchParams.get('channel') ?? '';
    if (!/^[0-9a-f]{32,128}$/.test(channel)) {
      return json({ error: 'channel-required' }, 401);
    }
    // The channel itself selects the object. One object per account keeps every
    // account isolated by construction rather than by a check inside the object.
    const id = env.RELAY_OBJECT.idFromName(channel);
    return env.RELAY_OBJECT.get(id).fetch(request);
  },
};

/** One JSON response. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** Read the caller's channel, which the Worker already validated. */
function channelOf(request) {
  const url = new URL(request.url);
  return request.headers.get('x-dsh-connect-channel') ?? url.searchParams.get('channel') ?? '';
}

export class RelayObject {
  /**
   * @param {DurableObjectState} state - the object's storage and socket registry.
   */
  constructor(state) {
    this.state = state;
    /** deviceId -> {id, name, seq, lastSeen}. Persisted so a restart keeps the roster. */
    this.devices = new Map();
    this.ready = this.#load();
  }

  /** Load the persisted roster into memory. */
  async #load() {
    for (const [deviceId, record] of await this.state.storage.list({ prefix: 'device:' })) {
      this.devices.set(String(deviceId).slice('device:'.length), record);
    }
  }

  /** Persist one device record's metadata (never its mail, which has its own keys). */
  async #saveDevice(device) {
    await this.state.storage.put(`device:${device.id}`, { id: device.id, name: device.name, seq: device.seq, lastSeen: device.lastSeen });
  }

  /** A device record, created on first sight. */
  #device(deviceId, name) {
    let device = this.devices.get(deviceId);
    if (device === undefined) {
      device = { id: deviceId, name: name || deviceId.slice(0, 8), seq: 0, lastSeen: Date.now() };
      this.devices.set(deviceId, device);
    }
    if (name) device.name = name;
    device.lastSeen = Date.now();
    return device;
  }

  /** How many live sockets a device holds, across hibernated and active ones. */
  #socketCount(deviceId) {
    let count = 0;
    for (const socket of this.state.getWebSockets(deviceId)) {
      if (socket.readyState === 1) count += 1;
    }
    return count;
  }

  /** The channel's public roster. */
  #roster() {
    return [...this.devices.values()].map((device) => ({
      id: device.id,
      name: device.name,
      online: this.#socketCount(device.id) > 0,
      lastSeen: device.lastSeen,
      pending: 0,
    }));
  }

  /** Send one JSON frame to every live socket a device holds. */
  #sendTo(deviceId, frame) {
    const text = JSON.stringify(frame);
    for (const socket of this.state.getWebSockets(deviceId)) {
      try {
        socket.send(text);
      } catch {
        /* a dying socket is reaped by the runtime */
      }
    }
  }

  /** Tell everyone who is online. */
  #broadcastPresence() {
    const frame = JSON.stringify({ type: 'presence', devices: this.#roster() });
    for (const device of this.devices.values()) {
      for (const socket of this.state.getWebSockets(device.id)) {
        try {
          socket.send(frame);
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Deliver to online sockets, or park the envelope in the recipient's mailbox.
   * @returns {{delivered: string[], queuedFor: string[]}}
   */
  async #route(envelope) {
    const delivered = [];
    const queuedFor = [];
    const targets = envelope.to === '*'
      ? [...this.devices.values()].filter((device) => device.id !== envelope.from).map((device) => device.id)
      : [envelope.to];
    for (const targetId of targets) {
      const device = this.devices.get(targetId);
      // Refuse to invent a mailbox for a device this channel has never seen:
      // otherwise anyone holding the channel could allocate unbounded storage.
      if (device === undefined) continue;
      if (this.#socketCount(targetId) > 0) {
        device.seq += 1;
        this.#sendTo(targetId, { type: 'message', envelope: { ...envelope, seq: device.seq } });
        await this.#saveDevice(device);
        delivered.push(targetId);
        continue;
      }
      device.seq += 1;
      const parked = { ...envelope, seq: device.seq, expiresAt: Date.now() + envelope.ttlMs };
      await this.state.storage.put(`mail:${targetId}:${String(device.seq).padStart(12, '0')}`, parked);
      await this.#saveDevice(device);
      await this.#trimMailbox(targetId);
      queuedFor.push(targetId);
    }
    return { delivered, queuedFor };
  }

  /** Keep one mailbox bounded, dropping the OLDEST entries. */
  async #trimMailbox(deviceId) {
    const entries = await this.state.storage.list({ prefix: `mail:${deviceId}:`, limit: MAX_MAILBOX + 50 });
    const keys = [...entries.keys()];
    if (keys.length <= MAX_MAILBOX) return;
    const excess = keys.slice(0, keys.length - MAX_MAILBOX);
    await this.state.storage.delete(excess);
  }

  /** Drop expired mail. */
  async #pruneMailbox(deviceId) {
    const entries = await this.state.storage.list({ prefix: `mail:${deviceId}:` });
    const now = Date.now();
    const dead = [];
    for (const [key, value] of entries) {
      if ((value.expiresAt ?? 0) <= now) dead.push(key);
    }
    if (dead.length > 0) await this.state.storage.delete(dead);
  }

  /**
   * One request: a WebSocket upgrade or one mailbox operation.
   * @param {Request} request - the routed request.
   */
  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const channel = channelOf(request);

    if (url.pathname === '/v1/devices') {
      return json({ devices: this.#roster() });
    }

    if (url.pathname === '/v1/send' && request.method === 'POST') {
      const body = await request.json().catch(() => undefined);
      if (body === undefined) return json({ error: 'bad-json' }, 400);
      const from = String(body.deviceId ?? '');
      if (from === '') return json({ error: 'deviceId-required' }, 400);
      this.#device(from, body.name);
      const envelope = {
        id: String(body.id ?? `m-${crypto.randomUUID()}`).slice(0, 128),
        from,
        to: String(body.to ?? '').slice(0, 128),
        at: Number(body.at ?? Date.now()),
        ttlMs: Math.min(7 * 24 * 3600 * 1000, Math.max(1000, Number(body.ttlMs ?? 7 * 24 * 3600 * 1000))),
        body: String(body.body ?? ''),
      };
      if (envelope.body.length > MAX_BODY_BYTES) return json({ error: 'body-too-large' }, 413);
      const result = await this.#route(envelope);
      return json({ id: envelope.id, delivered: result.delivered, queuedFor: result.queuedFor });
    }

    if (url.pathname === '/v1/recv' && (request.method === 'GET' || request.method === 'POST')) {
      const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
      const deviceId = String(body.deviceId ?? url.searchParams.get('deviceId') ?? '');
      if (deviceId === '') return json({ error: 'deviceId-required' }, 400);
      this.#device(deviceId, body.name);
      await this.#pruneMailbox(deviceId);
      const entries = await this.state.storage.list({ prefix: `mail:${deviceId}:`, limit: MAX_MAILBOX });
      const messages = [...entries.values()];
      if (messages.length > 0) await this.state.storage.delete([...entries.keys()]);
      return json({ messages, devices: this.#roster() });
    }

    if (url.pathname === '/v1/ack' && request.method === 'POST') {
      return json({ acked: [] });
    }

    if (request.headers.get('upgrade') !== 'websocket') {
      return json({ error: 'not-found' }, 404);
    }

    // Hibernation: the runtime keeps the socket, we get an event when something
    // arrives, and an idle device costs nothing.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'open', at: Date.now() }));
    void channel;
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * One inbound WebSocket frame.
   * @param {WebSocket} socket - the socket the frame arrived on.
   * @param {string|ArrayBuffer} message - the frame payload.
   */
  async webSocketMessage(socket, message) {
    await this.ready;
    let frame;
    try {
      frame = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message));
    } catch {
      socket.send(JSON.stringify({ type: 'error', code: 'bad-json' }));
      return;
    }
    if (frame.type === 'hello') {
      const deviceId = String(frame.deviceId ?? '').slice(0, 128);
      if (deviceId === '') {
        socket.send(JSON.stringify({ type: 'error', code: 'missing-device-id' }));
        return;
      }
      // Tag the socket with its device so `getWebSockets(deviceId)` can find it.
      this.state.acceptWebSocket(socket, [deviceId]);
      const device = this.#device(deviceId, String(frame.name ?? '').slice(0, 120));
      await this.#saveDevice(device);
      this.#sendTo(deviceId, { type: 'welcome', deviceId, seq: device.seq, pending: 0 });
      this.#broadcastPresence();
      return;
    }
    if (frame.type === 'send' && frame.envelope) {
      const tags = this.state.getTags(socket);
      const from = tags[0];
      if (from === undefined) {
        socket.send(JSON.stringify({ type: 'error', code: 'hello-required' }));
        return;
      }
      const envelope = {
        id: String(frame.envelope.id ?? `m-${crypto.randomUUID()}`).slice(0, 128),
        from,
        to: String(frame.envelope.to ?? '').slice(0, 128),
        at: Number(frame.envelope.at ?? Date.now()),
        ttlMs: Math.min(7 * 24 * 3600 * 1000, Math.max(1000, Number(frame.envelope.ttlMs ?? 7 * 24 * 3600 * 1000))),
        body: String(frame.envelope.body ?? ''),
      };
      const result = await this.#route(envelope);
      this.#sendTo(from, { type: 'sent', id: envelope.id, delivered: result.delivered, queuedFor: result.queuedFor });
      return;
    }
    if (frame.type === 'ping') {
      socket.send(JSON.stringify({ type: 'pong', at: Date.now() }));
    }
  }

  /** A socket closed: tell the others. */
  async webSocketClose(socket) {
    await this.ready;
    this.#broadcastPresence();
  }

  /** A socket errored: treat it like a close. */
  async webSocketError(socket) {
    await this.ready;
    this.#broadcastPresence();
  }
}
