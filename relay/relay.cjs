#!/usr/bin/env node
'use strict';
/*
 * dsh-connect-relay — the cloud half of Deep Connect.
 *
 * It is deliberately dumb. It knows three things: a `channel` (an opaque
 * 64-hex string that stands for "one DeepSeek account"), a `deviceId` (the
 * sender/recipient stamped on an envelope), and a `body` (opaque ciphertext).
 * It cannot read a conversation, and it cannot derive a key: the encryption key
 * comes from the signed-in account and never leaves the two DSH installs.
 *
 * Zero dependencies, on purpose — it must run on a VPS, in a container, on a
 * NAS, or under `node relay.cjs` on a laptop, with nothing to install.
 *
 *   node relay.cjs [--port 8790] [--host 0.0.0.0] [--state ./relay-state.json]
 *                  [--token <shared-secret>] [--mailbox 512] [--ttl-days 7]
 *
 * Transport: WebSocket (upgrades at any path, or `/ws`) for DSH installs behind
 * a proxy, plus a plain HTTP mailbox (`POST /v1/send`, `GET /v1/recv`,
 * `POST /v1/ack`, `GET /v1/devices`, `GET /healthz`) for anything that cannot
 * hold a socket open.
 *
 * SECURITY: a channel is a bearer credential — presenting it lets a device
 * join that account's room and mail its peers. It is SHA-256 of the account id,
 * so it is not guessable, but it is not a password either. Add `--token` to
 * require an additional shared secret on every request when the relay sits on
 * the public internet.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** WebSocket handshake constant from RFC 6455 §1.3. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Largest single frame we accept, in bytes. One history chunk is ≤ 4 MiB. */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** Longest a `GET /v1/recv` call waits for mail before answering empty. */
const MAX_WAIT_MS = 25_000;
/** How long a device's room membership survives a dropped socket for presence. */
const PRESENCE_GRACE_MS = 2_000;

/** Monotonic-ish id generator for envelope bookkeeping. */
let idCounter = 0;
function nextId(prefix) {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** One line of structured logging; the deployment reads these, not a log lib. */
function log(event, fields) {
  const body = fields === undefined ? '' : ` ${JSON.stringify(fields)}`;
  process.stdout.write(`${new Date().toISOString()} [relay] ${event}${body}\n`);
}

/* ------------------------------------------------------------------ */
/* WebSocket                                                          */
/* ------------------------------------------------------------------ */

/**
 * Encode one unmasked server-to-client frame.
 * @param {Buffer|string} payload - frame body.
 * @param {number} opcode - 0x1 text, 0x2 binary, 0x8 close, 0x9 ping, 0xA pong.
 * @returns {Buffer} the wire bytes.
 */
function encodeFrame(payload, opcode) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/**
 * Pull every complete frame out of an accumulating buffer.
 *
 * A TCP read is not a message boundary: one `data` event can carry half a
 * frame, three frames, or a frame and a half. Unparsed bytes stay in `state`.
 * @param {{buf: Buffer}} state - carry-over buffer between reads.
 * @param {Buffer} chunk - newly arrived bytes.
 * @returns {Array<{opcode: number, payload: Buffer, fin: boolean}>} complete frames.
 */
function takeFrames(state, chunk) {
  state.buf = state.buf.length === 0 ? chunk : Buffer.concat([state.buf, chunk]);
  const frames = [];
  for (;;) {
    const buf = state.buf;
    if (buf.length < 2) break;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) break;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) break;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME_BYTES)) throw new Error(`frame too large: ${big}`);
      length = Number(big);
      offset = 10;
    }
    if (length > MAX_FRAME_BYTES) throw new Error(`frame too large: ${length}`);
    const maskBytes = masked ? 4 : 0;
    if (buf.length < offset + maskBytes + length) break;
    let payload = buf.subarray(offset + maskBytes, offset + maskBytes + length);
    if (masked) {
      const mask = buf.subarray(offset, offset + 4);
      const copy = Buffer.allocUnsafe(length);
      for (let i = 0; i < length; i += 1) copy[i] = payload[i] ^ mask[i & 3];
      payload = copy;
    }
    state.buf = buf.subarray(offset + maskBytes + length);
    frames.push({ opcode, payload, fin });
  }
  return frames;
}

/* ------------------------------------------------------------------ */
/* Relay state                                                        */
/* ------------------------------------------------------------------ */

/**
 * Build the relay. Returned as a factory (not a side effect on import) so the
 * smoke test can start one in-process and drive it for real.
 * @param {object} [options] - deployment knobs; see the header for the CLI flags.
 * @returns {{ server: import('node:http').Server, start: () => Promise<number>, stop: () => Promise<void>, state: object }}
 */
function createRelay(options = {}) {
  const host = options.host ?? '0.0.0.0';
  const port = Number(options.port ?? 8790);
  const statePath = options.statePath ?? '';
  const requiredToken = options.token ?? '';
  /** Reject any client that does not speak at least this Deep Connect protocol. */
  const requireProto = Math.max(0, Number(options.requireProto ?? 0));
  /** Reject clients older than this release (semver string), when set. */
  const requireVersion = String(options.requireVersion ?? '').trim();

  /** Numeric semver comparison; returns <0, 0, >0 exactly like a sort comparator. */
  function compareVersion(a, b) {
    const parse = (value) => String(value).replace(/^v/i, '').split(/[-+.]/).map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));
    const left = parse(a);
    const right = parse(b);
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      const diff = (left[index] ?? 0) - (right[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  /** Is this client old enough to be sealed out? */
  function versionRefused(req, url) {
    if (requireVersion === '') return false;
    const reported = String(url.searchParams.get('ver') ?? req.headers['x-dsh-connect-version'] ?? '');
    // A client that reports nothing predates this rule by definition.
    return reported === '' || compareVersion(reported, requireVersion) < 0;
  }
  const mailboxLimit = Math.max(1, Number(options.mailboxLimit ?? 512));
  const ttlMs = Math.max(1000, Number(options.ttlMs ?? 7 * 24 * 3600 * 1000));

  /**
   * channel -> deviceId -> { id, name, sockets:Set, mailbox:Envelope[], seq, lastSeen }
   * @type {Map<string, Map<string, object>>}
   */
  const rooms = new Map();

  function room(channel) {
    let devices = rooms.get(channel);
    if (devices === undefined) {
      devices = new Map();
      rooms.set(channel, devices);
    }
    return devices;
  }

  /** Find or create one device record inside a channel. */
  function deviceOf(channel, deviceId, name) {
    const devices = room(channel);
    let device = devices.get(deviceId);
    if (device === undefined) {
      device = { id: deviceId, name: name || deviceId.slice(0, 8), sockets: new Set(), mailbox: [], seq: 0, lastSeen: Date.now() };
      devices.set(deviceId, device);
      log('device/joined', { channel: channel.slice(0, 12), device: device.id, name: device.name });
    }
    if (name) device.name = name;
    device.lastSeen = Date.now();
    return device;
  }

  /** The channel's public roster, without mailboxes. */
  function roster(channel) {
    return [...room(channel).values()].map((d) => ({
      id: d.id,
      name: d.name,
      online: d.sockets.size > 0,
      lastSeen: d.lastSeen,
      pending: d.mailbox.length,
    }));
  }

  /** Push a server frame to every socket a device holds. */
  function send(device, frame) {
    const text = JSON.stringify(frame);
    for (const socket of device.sockets) {
      try {
        socket.write(encodeFrame(text, 0x1));
      } catch {
        /* a dead socket is reaped by its own close handler */
      }
    }
  }

  /** Tell every peer in the channel who is online right now. */
  function broadcastPresence(channel) {
    const frame = { type: 'presence', devices: roster(channel) };
    for (const device of room(channel).values()) {
      if (device.sockets.size > 0) send(device, frame);
    }
  }

  /**
   * Route one envelope. Online recipients get it immediately; offline ones keep
   * it in their mailbox until they connect, bounded by count and by age.
   * @returns {{delivered: string[], queued: string[], queuedFor: string[]}}
   */
  function route(channel, envelope) {
    const devices = room(channel);
    const targets = envelope.to === '*' ? [...devices.values()].filter((d) => d.id !== envelope.from) : [devices.get(envelope.to)].filter(Boolean);
    const delivered = [];
    const queuedFor = [];
    for (const target of targets) {
      if (target.sockets.size > 0) {
        target.seq += 1;
        send(target, { type: 'message', envelope: { ...envelope, seq: target.seq } });
        delivered.push(target.id);
        continue;
      }
      target.mailbox.push({ ...envelope, seq: ++target.seq, expiresAt: Date.now() + ttlMs });
      while (target.mailbox.length > mailboxLimit) target.mailbox.shift();
      queuedFor.push(target.id);
    }
    return { delivered, queued: queuedFor, queuedFor };
  }

  /** Drop mailbox entries past their TTL; called before every mailbox read. */
  function pruneMailbox(device) {
    const now = Date.now();
    device.mailbox = device.mailbox.filter((e) => (e.expiresAt ?? 0) > now);
  }

  /** One WebSocket client attached to a channel. */
  function acceptSocket(socket, channel, head) {
    const state = { buf: Buffer.alloc(0) };
    /** @type {object|undefined} */
    let device;
    /** Remove this socket from the room exactly once. */
    let detached = false;
    const detach = () => {
      if (detached) return;
      detached = true;
      if (device === undefined) return;
      device.sockets.delete(socket);
      if (device.sockets.size === 0) {
        // Announce the departure immediately. A grace period here would mean
        // peers keep believing a dead device is online for its whole duration,
        // and a sender that trusts the roster then hands an envelope to a
        // mailbox while expecting a live answer. The cost is one extra frame
        // per reconnect, which is nothing next to a wrong "online".
        broadcastPresence(channel);
        // And once more after the grace window, in case this was a flap. It is
        // a no-op when the device already came back.
        setTimeout(() => {
          if (device.sockets.size === 0) broadcastPresence(channel);
        }, PRESENCE_GRACE_MS).unref?.();
      }
    };
    socket.on('error', () => {
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      detach();
    });
    socket.on('close', detach);
    // A clean client shutdown sends FIN, which arrives as `end`. Node does not
    // guarantee a following `close` for an upgraded socket, and a socket left in
    // that half-open state used to keep the device "online" for ever: presence
    // never updated and envelopes written to it were lost instead of queued.
    // Treat `end` as departure, then finish the socket.
    socket.on('end', () => {
      detach();
      try {
        socket.end();
      } catch {
        /* write side already closed */
      }
    });
    const onFrames = (frames) => {
      for (const frame of frames) {
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(Buffer.alloc(0), 0x8));
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(frame.payload, 0xa));
          continue;
        }
        if (frame.opcode !== 0x1 && frame.opcode !== 0x2) continue;
        let msg;
        try {
          msg = JSON.parse(frame.payload.toString('utf8'));
        } catch {
          socket.write(encodeFrame(JSON.stringify({ type: 'error', code: 'bad-json' }), 0x1));
          continue;
        }
        if (msg.type === 'hello') {
          const deviceId = String(msg.deviceId ?? '').slice(0, 128);
          if (deviceId === '') {
            socket.write(encodeFrame(JSON.stringify({ type: 'error', code: 'missing-device-id' }), 0x1));
            continue;
          }
          if (device !== undefined) device.sockets.delete(socket);
          device = deviceOf(channel, deviceId, String(msg.name ?? '').slice(0, 120));
          device.sockets.add(socket);
          // Deliver what arrived while this device was away. Without this, mail
          // queued for an offline WebSocket client was never handed over: only
          // the HTTP mailbox path drained, so a device that reconnected over
          // the socket silently lost every update it missed. `splice` keeps the
          // drain one-shot when several sockets register at once.
          pruneMailbox(device);
          const pending = device.mailbox.splice(0, device.mailbox.length);
          send(device, { type: 'welcome', deviceId: device.id, seq: device.seq, pending: pending.length });
          for (const envelope of pending) send(device, { type: 'message', envelope });
          broadcastPresence(channel);
          continue;
        }
        if (msg.type === 'send' && msg.envelope) {
          if (device === undefined) {
            socket.write(encodeFrame(JSON.stringify({ type: 'error', code: 'hello-required' }), 0x1));
            continue;
          }
          const envelope = {
            id: String(msg.envelope.id ?? nextId('m')).slice(0, 128),
            from: device.id,
            to: String(msg.envelope.to ?? '').slice(0, 128),
            at: Number(msg.envelope.at ?? Date.now()),
            ttlMs: Math.min(ttlMs, Math.max(1000, Number(msg.envelope.ttlMs ?? ttlMs))),
            body: String(msg.envelope.body ?? ''),
          };
          const result = route(channel, envelope);
          send(device, { type: 'sent', id: envelope.id, delivered: result.delivered, queuedFor: result.queuedFor });
          continue;
        }
        if (msg.type === 'ping') {
          socket.write(encodeFrame(JSON.stringify({ type: 'pong', at: Date.now() }), 0x1));
          continue;
        }
      }
    };
    socket.on('data', (chunk) => {
      let frames;
      try {
        frames = takeFrames(state, chunk);
      } catch (error) {
        log('ws/frame-error', { message: String(error.message) });
        socket.destroy();
        return;
      }
      onFrames(frames);
    });
    socket.write(encodeFrame(JSON.stringify({ type: 'open', at: Date.now() }), 0x1));
  }

  /* ------------------------------ HTTP ------------------------------ */

  /** Read a JSON request body, bounded. */
  function readJson(req, limit = 32 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve({});
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (error) {
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  function sendJson(res, status, value) {
    const body = JSON.stringify(value);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    res.end(body);
  }

  /**
   * Resolve the caller's channel, or answer 401.
   * @returns {string|undefined} the channel when admitted.
   */
  function admit(req, res, url) {
    const channel = String(req.headers['x-dsh-connect-channel'] ?? url.searchParams.get('channel') ?? '');
    const token = String(req.headers['x-dsh-connect-token'] ?? url.searchParams.get('token') ?? '');
    if (!/^[0-9a-f]{32,128}$/.test(channel)) {
      sendJson(res, 401, { error: 'channel-required' });
      return undefined;
    }
    if (requiredToken !== '' && token !== requiredToken) {
      sendJson(res, 401, { error: 'token-required' });
      return undefined;
    }
    if (requireProto > 0 && Number(url.searchParams.get('proto') ?? req.headers['x-dsh-connect-proto'] ?? 0) < requireProto) {
      // A v2 client has no idea what a station is; refuse it loudly instead of
      // letting it join a room it cannot decode.
      sendJson(res, 426, { error: 'upgrade-required', minProto: requireProto });
      return undefined;
    }
    if (versionRefused(req, url)) {
      sendJson(res, 426, { error: 'version-refused', minVersion: requireVersion });
      return undefined;
    }
    return channel;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'relay'}`);
    if (url.pathname === '/healthz') {
      let devices = 0;
      let online = 0;
      for (const roomDevices of rooms.values()) {
        devices += roomDevices.size;
        for (const d of roomDevices.values()) if (d.sockets.size > 0) online += 1;
      }
      sendJson(res, 200, { ok: true, channels: rooms.size, devices, online, uptimeMs: Math.round(process.uptime() * 1000) });
      return;
    }
    if (!url.pathname.startsWith('/v1/')) {
      sendJson(res, 404, { error: 'not-found' });
      return;
    }
    const channel = admit(req, res, url);
    if (channel === undefined) return;

    if (url.pathname === '/v1/devices' && req.method === 'GET') {
      sendJson(res, 200, { devices: roster(channel) });
      return;
    }

    if (url.pathname === '/v1/send' && req.method === 'POST') {
      let body;
      try {
        body = await readJson(req);
      } catch {
        sendJson(res, 400, { error: 'bad-json' });
        return;
      }
      const from = String(body.deviceId ?? '');
      if (from === '') {
        sendJson(res, 400, { error: 'deviceId-required' });
        return;
      }
      deviceOf(channel, from, body.name);
      const envelope = {
        id: String(body.id ?? nextId('m')).slice(0, 128),
        from,
        to: String(body.to ?? '').slice(0, 128),
        at: Number(body.at ?? Date.now()),
        ttlMs: Math.min(ttlMs, Math.max(1000, Number(body.ttlMs ?? ttlMs))),
        body: String(body.body ?? ''),
      };
      if (envelope.to === '') {
        sendJson(res, 400, { error: 'to-required' });
        return;
      }
      const result = route(channel, envelope);
      // A queued envelope is the one thing worth making durable before we
      // answer: the sender is about to treat it as accepted. Without the flush
      // it would sit in memory until the periodic save, and a relay restart in
      // that window would silently drop the caller's message.
      if (result.queuedFor.length > 0) save();
      sendJson(res, 200, { id: envelope.id, delivered: result.delivered, queuedFor: result.queuedFor });
      return;
    }

    if (url.pathname === '/v1/recv' && (req.method === 'GET' || req.method === 'POST')) {
      const query = url.searchParams;
      const body = req.method === 'POST' ? await readJson(req).catch(() => ({})) : {};
      const deviceId = String(body.deviceId ?? query.get('deviceId') ?? '');
      if (deviceId === '') {
        sendJson(res, 400, { error: 'deviceId-required' });
        return;
      }
      const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(body.waitMs ?? query.get('waitMs') ?? 0)));
      const device = deviceOf(channel, deviceId, body.name);
      pruneMailbox(device);
      const deadline = Date.now() + waitMs;
      while (device.mailbox.length === 0 && Date.now() < deadline) {
        // Long-poll: the sleeping request IS how a socket-less device stays
        // current, so it must not spin, and it must not outlive the deadline.
        const slice = Math.min(250, Math.max(1, deadline - Date.now()));
        await new Promise((resolve) => setTimeout(resolve, slice));
        pruneMailbox(device);
      }
      const messages = device.mailbox.splice(0, device.mailbox.length);
      sendJson(res, 200, { messages, devices: roster(channel) });
      return;
    }

    if (url.pathname === '/v1/ack' && req.method === 'POST') {
      const body = await readJson(req).catch(() => ({}));
      sendJson(res, 200, { acked: body.ids ?? [] });
      return;
    }

    sendJson(res, 404, { error: 'not-found' });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'relay'}`);
    const channel = String(req.headers['x-dsh-connect-channel'] ?? url.searchParams.get('channel') ?? '');
    const token = String(req.headers['x-dsh-connect-token'] ?? url.searchParams.get('token') ?? '');
    const key = req.headers['sec-websocket-key'];
    if (requiredToken !== '' && token !== requiredToken) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    if (requireProto > 0 && Number(url.searchParams.get('proto') ?? req.headers['x-dsh-connect-proto'] ?? 0) < requireProto) {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nX-DC-Min-Proto: ' + requireProto + '\r\n\r\n');
      return;
    }
    if (versionRefused(req, url)) {
      socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nX-DC-Min-Version: ' + requireVersion + '\r\n\r\n');
      return;
    }
    if (!/^[0-9a-f]{32,128}$/.test(channel) || typeof key !== 'string') {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);
    acceptSocket(socket, channel, head);
  });

  /* --------------------------- persistence --------------------------- */

  /**
   * Offline mailboxes must survive a relay restart, or a device that was away
   * for a week silently loses every index update. Sockets never survive.
   */
  function save() {
    if (statePath === '') return;
    const dump = {};
    for (const [channel, devices] of rooms) {
      dump[channel] = [...devices.values()]
        .filter((d) => d.mailbox.length > 0)
        .map((d) => ({ id: d.id, name: d.name, seq: d.seq, lastSeen: d.lastSeen, mailbox: d.mailbox }));
    }
    const tmp = `${statePath}.tmp`;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(dump));
    fs.renameSync(tmp, statePath);
  }

  function load() {
    if (statePath === '' || !fs.existsSync(statePath)) return;
    try {
      const dump = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      for (const [channel, devices] of Object.entries(dump)) {
        for (const record of devices) {
          const device = deviceOf(channel, record.id, record.name);
          device.seq = Number(record.seq ?? 0);
          device.mailbox = Array.isArray(record.mailbox) ? record.mailbox : [];
          pruneMailbox(device);
        }
      }
      log('state/loaded', { channels: Object.keys(dump).length });
    } catch (error) {
      log('state/load-failed', { message: String(error.message) });
    }
  }

  let saveTimer;
  if (statePath !== '') {
    saveTimer = setInterval(save, 10_000);
    saveTimer.unref?.();
  }

  return {
    server,
    state: rooms,
    roster,
    route,
    /**
     * Bind and resolve the actual port (useful when `port` is 0 in tests).
     * @returns {Promise<number>} the listening port.
     */
    start() {
      load();
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          const address = server.address();
          const bound = typeof address === 'object' && address !== null ? address.port : port;
          log('listening', { url: `http://${host}:${bound}`, token: requiredToken === '' ? 'none' : 'required' });
          resolve(bound);
        });
      });
    },
    /** Close every socket and the listener, flushing state first. */
    async stop() {
      if (saveTimer !== undefined) clearInterval(saveTimer);
      save();
      for (const devices of rooms.values()) {
        for (const device of devices.values()) {
          for (const socket of device.sockets) socket.destroy();
          device.sockets.clear();
        }
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                */
/* ------------------------------------------------------------------ */

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--port') options.port = Number(next());
    else if (arg === '--host') options.host = next();
    else if (arg === '--state') options.statePath = path.resolve(next());
    else if (arg === '--token') options.token = next();
    else if (arg === '--require-proto') options.requireProto = Number(next());
    else if (arg === '--require-version') options.requireVersion = next();
    else if (arg === '--mailbox') options.mailboxLimit = Number(next());
    else if (arg === '--ttl-days') options.ttlMs = Number(next()) * 24 * 3600 * 1000;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'dsh-connect-relay [--port 8790] [--host 0.0.0.0] [--state ./relay-state.json]\n' +
          '                  [--token <shared-secret>] [--require-proto 3] [--require-version 4.0.2] [--mailbox 512] [--ttl-days 7]\n',
      );
      process.exit(0);
    }
  }
  return options;
}

if (require.main === module) {
  const relay = createRelay(parseArgs(process.argv.slice(2)));
  relay
    .start()
    .then((bound) => {
      // Discovery aid only; the relay never prints a channel because it never
      // knows one until a device shows up.
      process.stdout.write(`[relay] ready on port ${bound}\n`);
    })
    .catch((error) => {
      process.stderr.write(`[relay] failed: ${error.stack ?? error}\n`);
      process.exit(1);
    });
  const shutdown = () => {
    relay.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = { createRelay, encodeFrame, takeFrames, MAX_FRAME_BYTES };
