#!/usr/bin/env node
/**
 * Deep Connect — relay end-to-end smoke test.
 *
 * Starts a REAL relay on an ephemeral port and drives it over a REAL WebSocket
 * (hand-rolled client framing, so the server's masking/fragmentation/length
 * handling is genuinely exercised, not stubbed) plus the HTTP mailbox. Also
 * checks the offline-mailbox, presence, and authentication paths.
 *
 * Usage: node tools/relay-smoke.mjs
 */
import { createRequire } from 'node:module';
import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createRelay, encodeFrame, takeFrames } = require('../relay/relay.cjs');

const failures = [];
const check = (condition, label) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
};
const section = (title) => console.log(`\n${title}`);
/**
 * `fetch` with a retry.
 *
 * Stopping a listener and rebinding the same port races the kernel's teardown,
 * and a request that lands in that window dies with ECONNRESET. That is an
 * artifact of the test restarting a server in-process, not relay behaviour, so
 * absorb it here rather than masking it in the relay.
 */
const fetchRetry = async (url, options, attempts = 6) => {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fetch(url, options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw lastError;
};

/* ---------------- a minimal WebSocket client, on purpose ---------------- */
/** Client frames MUST be masked; the server rejects surprises loudly. */
function encodeClientFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const mask = randomBytes(4);
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode; // FIN set
  const masked = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i += 1) masked[i] = data[i] ^ mask[i & 3];
  return Buffer.concat([header, mask, masked]);
}

/**
 * Decode unmasked server-to-client frames out of an accumulating buffer.
 * Length is read through the same three encodings the server writes, and a
 * partial frame simply waits for more bytes.
 * @param {{buf: Buffer}} state - carry-over buffer between reads.
 * @param {Buffer} chunk - newly arrived bytes.
 * @returns {Array<{opcode: number, payload: Buffer}>} complete frames.
 */
function parseServerFrames(state, chunk) {
  state.buf = state.buf.length === 0 ? chunk : Buffer.concat([state.buf, chunk]);
  const frames = [];
  for (;;) {
    const buf = state.buf;
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) break;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) break;
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (buf.length < offset + length) break;
    frames.push({ opcode, payload: buf.subarray(offset, offset + length) });
    state.buf = buf.subarray(offset + length);
  }
  return frames;
}

/**
 * Open one WebSocket to the relay, complete the HTTP upgrade by hand.
 * @returns {Promise<{send: (obj: object) => void, close: () => void, frames: object[], waitFor: (pred: (f: object) => boolean, ms?: number) => Promise<object>}>}
 */
function connect(url, headers) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(target.port), target.hostname, () => {
      const key = randomBytes(16).toString('base64');
      const lines = [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        ...Object.entries(headers ?? {}).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });
    socket.on('error', (error) => {
      if (!resolved) reject(error);
    });
    const state = { buf: Buffer.alloc(0) };
    let upgraded = false;
    let resolved = false;
    const frames = [];
    const waiters = [];
    const deliver = (frame) => {
      frames.push(frame);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (waiters[i].pred(frame)) {
          waiters[i].resolve(frame);
          waiters.splice(i, 1);
        }
      }
    };
    socket.on('data', (chunk) => {
      if (!upgraded) {
        // Pre-handshake: bytes accumulate until the header terminator shows up,
        // then whatever follows it in the SAME chunk is already in `state.buf`.
        state.buf = Buffer.concat([state.buf, chunk]);
        const end = state.buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const headText = state.buf.subarray(0, end).toString('latin1');
        if (!headText.startsWith('HTTP/1.1 101')) {
          reject(new Error(`upgrade refused: ${headText.split('\r\n')[0]}`));
          socket.destroy();
          return;
        }
        state.buf = state.buf.subarray(end + 4);
        upgraded = true;
        // The handshake bytes are consumed; the remainder stays buffered and is
        // parsed by the call below with an empty chunk.
        for (const frame of parseServerFrames(state, Buffer.alloc(0))) {
          if (frame.opcode === 0x1) {
            try {
              deliver(JSON.parse(frame.payload.toString('utf8')));
            } catch {
              /* ignore */
            }
          }
        }
      } else {
        for (const frame of parseServerFrames(state, chunk)) {
          if (frame.opcode === 0x1) {
            try {
              deliver(JSON.parse(frame.payload.toString('utf8')));
            } catch {
              /* ignore */
            }
          } else if (frame.opcode === 0x8) {
            socket.destroy();
          }
        }
      }
      if (upgraded && !resolved) {
        resolved = true;
        resolve({
          send: (obj) => socket.write(encodeClientFrame(JSON.stringify(obj))),
          close: () => socket.destroy(),
          frames,
          waitFor: (pred, ms = 3000) =>
            new Promise((res, rej) => {
              const hit = frames.find(pred);
              if (hit !== undefined) return res(hit);
              const timer = setTimeout(() => rej(new Error(`timeout waiting for frame (${ms}ms)`)), ms);
              waiters.push({
                pred,
                resolve: (f) => {
                  clearTimeout(timer);
                  res(f);
                },
              });
            }),
        });
      }
    });
    socket.on('close', () => reject(new Error('closed before upgrade')));
  });
}

/* ---------------------------- crypto, as the plugin does it ---------------------------- */
const ACCOUNT_ID = 'acct-7f3a91';
const channel = createHash('sha256').update(`dsh-deep-connect/channel/v1|${ACCOUNT_ID}`).digest('hex');
/** The plugin derives this with PBKDF2; a fast digest keeps the test quick. */
const key = createHash('sha256').update(`dsh-deep-connect/key/v1|${ACCOUNT_ID}`).digest();
function seal(plain) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ct]).toString('base64');
}
function open(body) {
  const raw = Buffer.from(body, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
}

/* --------------------------------- run --------------------------------- */
const dir = mkdtempSync(join(tmpdir(), 'dsh-connect-relay-'));
const statePath = join(dir, 'relay-state.json');
const relay = createRelay({ host: '127.0.0.1', port: 0, statePath, mailboxLimit: 4, ttlMs: 60_000 });
const port = await relay.start();
const base = `http://127.0.0.1:${port}`;
const wsBase = `ws://127.0.0.1:${port}`;
console.log(`relay on ${base}`);

try {
  section('authentication');
  const health = await fetch(`${base}/healthz`).then((r) => r.json());
  check(health.ok === true, 'healthz answers without a channel');
  const noChannel = await fetch(`${base}/v1/devices`);
  check(noChannel.status === 401, 'a request without a channel is refused (401)');
  const badChannel = await fetch(`${base}/v1/devices`, { headers: { 'x-dsh-connect-channel': 'not-hex' } });
  check(badChannel.status === 401, 'a malformed channel is refused (401)');
  let upgradeRefused = false;
  try {
    await connect(`${wsBase}/ws`, {});
  } catch {
    upgradeRefused = true;
  }
  check(upgradeRefused, 'a WebSocket upgrade without a channel is refused');

  section('presence over a real socket');
  const deviceA = await connect(`${wsBase}/ws`, { 'x-dsh-connect-channel': channel });
  const opened = await deviceA.waitFor((f) => f.type === 'open');
  check(opened.type === 'open', 'server greets a new socket with `open`');
  deviceA.send({ type: 'hello', deviceId: 'dev-a', name: 'A 机' });
  const welcomeA = await deviceA.waitFor((f) => f.type === 'welcome');
  check(welcomeA.deviceId === 'dev-a' && welcomeA.seq === 0, '`welcome` reports identity and watermark');

  const deviceB = await connect(`${wsBase}/ws`, { 'x-dsh-connect-channel': channel });
  deviceB.send({ type: 'hello', deviceId: 'dev-b', name: 'B 机' });
  await deviceB.waitFor((f) => f.type === 'welcome');
  const presenceB = await deviceB.waitFor((f) => f.type === 'presence' && f.devices.some((d) => d.id === 'dev-a'));
  check(presenceB.devices.length === 2, 'a joining device sees both peers');
  const presenceA = await deviceA.waitFor((f) => f.type === 'presence' && f.devices.length === 2);
  check(presenceA.devices.find((d) => d.id === 'dev-b').online === true, 'an existing device learns the newcomer is online');

  section('encrypted envelope delivery');
  const index = { kind: 'index', deviceName: 'A 机', sessions: [{ id: 'session-1', title: '你好，世界' }] };
  deviceA.send({ type: 'send', envelope: { id: 'e1', to: 'dev-b', at: Date.now(), body: seal(index) } });
  const delivered = await deviceB.waitFor((f) => f.type === 'message' && f.envelope?.id === 'e1');
  check(delivered.envelope.from === 'dev-a', 'the relay stamps the real sender, not the claimed one');
  check(delivered.envelope.seq === 1, 'delivery carries a per-recipient sequence number');
  const recovered = open(delivered.envelope.body);
  check(recovered.sessions[0].title === '你好，世界', 'the recipient decrypts the payload end-to-end');
  check(!JSON.stringify(delivered.envelope).includes('你好'), 'the relay forwarded only ciphertext');

  section('broadcast excludes the sender');
  deviceA.send({ type: 'send', envelope: { id: 'e2', to: '*', at: Date.now(), body: seal({ kind: 'index' }) } });
  await deviceB.waitFor((f) => f.type === 'message' && f.envelope?.id === 'e2');
  const selfEcho = deviceA.frames.some((f) => f.type === 'message' && f.envelope?.id === 'e2');
  check(selfEcho === false, 'a broadcast never echoes back to its sender');

  section('offline mailbox');
  // A third device must observe the departure: presence can only be delivered
  // to sockets that are still open, so dev-a alone cannot learn dev-b left
  // unless somebody else is online to receive the broadcast. This is exactly
  // why the roster also rides along on every HTTP answer.
  const observer = await connect(`${wsBase}/ws`, { 'x-dsh-connect-channel': channel });
  observer.send({ type: 'hello', deviceId: 'dev-c', name: 'C 机' });
  // Wait for the observer's own join to be acknowledged, so we know its socket
  // is live BEFORE the departure happens. Waiting for the departure frame first
  // is not enough: the observer's socket may be established but not yet known to
  // the relay when the broadcast goes out, and the frame is then simply missed.
  await observer.waitFor((f) => f.type === 'presence', 8000);
  // `dev-a` stays connected throughout, so a departure broadcast is guaranteed.
  deviceB.close();
  // Give the transport a turn to carry the FIN; the assertions below are about
  // the roster, not about how fast a closed socket is observed.
  await new Promise((r) => setTimeout(r, 50));
  // Order-independent: the departure frame may arrive BEFORE the observer's own
  // join broadcast, in which case waiting for "another" presence frame would
  // deadlock even though the roster already says the peer left. Poll the newest
  // presence frame instead.
  const departed = await (async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const frames = observer.frames.filter((f) => f.type === 'presence');
      const newest = frames[frames.length - 1];
      if (newest !== undefined && newest.devices.find((d) => d.id === 'dev-b')?.online === false) return newest;
      if (Date.now() > deadline) {
        console.log('    · presence frames seen:', JSON.stringify(frames.map((f) => f.devices.map((d) => `${d.id}:${d.online}`))));
        throw new Error('observer never saw dev-b reported offline');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  })();
  check(departed.devices.find((d) => d.id === 'dev-b').online === false, 'a third online device is told the peer left');
  const rosterAfterLeave = await fetch(`${base}/v1/devices`, { headers: { 'x-dsh-connect-channel': channel } }).then((r) => r.json());
  check(rosterAfterLeave.devices.find((d) => d.id === 'dev-b').online === false, 'the HTTP roster agrees the peer is offline');
  observer.close();
  await new Promise((r) => setTimeout(r, 100));
  deviceA.send({ type: 'send', envelope: { id: 'e3', to: 'dev-b', at: Date.now(), body: seal({ kind: 'history', note: 'while you were out' }) } });
  const sent = await deviceA.waitFor((f) => f.type === 'sent' && f.id === 'e3');
  check(sent.queuedFor.includes('dev-b'), 'mail for an offline device is reported as queued');
  const recv = await fetch(`${base}/v1/recv`, {
    method: 'POST',
    headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-b' }),
  }).then((r) => r.json());
  check(recv.messages.length === 1 && recv.messages[0].id === 'e3', 'a socket-less device drains the same mailbox over HTTP');
  check(open(recv.messages[0].body).note === 'while you were out', 'mailbox bodies stay encrypted at rest');
  const recv2 = await fetch(`${base}/v1/recv`, {
    method: 'POST',
    headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-b' }),
  }).then((r) => r.json());
  check(recv2.messages.length === 0, 'the mailbox drains exactly once');

  section('queued mail is delivered on socket reconnect');
  // Regression: envelopes parked for an offline device used to be handed over
  // only through the HTTP mailbox path. A device that came back over the socket
  // therefore never saw anything it missed. The relay now drains the mailbox in
  // its `hello` handler, before the welcome frame's pending count is reported.
  const away = await connect(`${wsBase}/ws`, { 'x-dsh-connect-channel': channel });
  away.send({ type: 'hello', deviceId: 'dev-late', name: 'Late' });
  await away.waitFor((f) => f.type === 'welcome');
  away.close();
  await new Promise((r) => setTimeout(r, 100));
  // The queueing answer is what proves the relay parked the envelope; a fixed
  // sleep races the close handler and produced a flaky "pending: 0".
  const queuedResponse = await fetch(`${base}/v1/send`, {
    method: 'POST',
    headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-a', to: 'dev-late', id: 'e-while-away', body: seal({ note: 'missed you' }) }),
  }).then((r) => r.json());
  check(queuedResponse.queuedFor.includes('dev-late'), 'the relay parked the envelope for the absent device');
  const returning = await connect(`${wsBase}/ws`, { 'x-dsh-connect-channel': channel });
  returning.send({ type: 'hello', deviceId: 'dev-late', name: 'Late' });
  const welcomeBack = await returning.waitFor((f) => f.type === 'welcome');
  check(welcomeBack.pending === 1, `the welcome frame reports the queued backlog (${welcomeBack.pending})`);
  const drained = await returning.waitFor((f) => f.type === 'message' && f.envelope?.id === 'e-while-away', 5000);
  check(drained.envelope.from === 'dev-a', 'the queued envelope is delivered right after reconnect');
  check(open(drained.envelope.body).note === 'missed you', 'the redelivered body still decrypts');
  returning.close();
  await new Promise((r) => setTimeout(r, 100));

  section('mailbox bound and long-poll');
  for (let i = 0; i < 8; i += 1) {
    await fetch(`${base}/v1/send`, {
      method: 'POST',
      headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-a', to: 'dev-b', id: `bulk-${i}`, body: seal({ i }) }),
    }).then((r) => r.json());
  }
  const bounded = await fetch(`${base}/v1/recv`, {
    method: 'POST',
    headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-b' }),
  }).then((r) => r.json());
  check(bounded.messages.length === 4, 'the mailbox honours its cap (oldest dropped, 4 kept)');
  check(bounded.messages[0].id === 'bulk-4', 'the cap drops the OLDEST mail');
  const startedLong = Date.now();
  const longPoll = fetch(`${base}/v1/recv`, {
    method: 'POST',
    headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-b', waitMs: 400 }),
  }).then((r) => r.json());
  setTimeout(() => {
    fetch(`${base}/v1/send`, {
      method: 'POST',
      headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-a', to: 'dev-b', id: 'late', body: seal({ late: true }) }),
    });
  }, 80);
  const late = await longPoll;
  const waited = Date.now() - startedLong;
  check(late.messages.some((m) => m.id === 'late'), 'long-poll wakes on new mail');
  check(waited < 1500, `long-poll returns promptly once mail lands (${waited}ms)`);

  section('channel isolation');
  const otherChannel = createHash('sha256').update('dsh-deep-connect/channel/v1|other-account').digest('hex');
  const foreign = await fetch(`${base}/v1/devices`, { headers: { 'x-dsh-connect-channel': otherChannel } }).then((r) => r.json());
  check(foreign.devices.length === 0, 'a different channel sees an empty room');

  section('shared-secret gate');
  const gatedDir = mkdtempSync(join(tmpdir(), 'dsh-connect-relay-gated-'));
  const gated = createRelay({ host: '127.0.0.1', port: 0, token: 's3cret', statePath: join(gatedDir, 's.json') });
  const gatedPort = await gated.start();
  const noToken = await fetch(`http://127.0.0.1:${gatedPort}/v1/devices`, { headers: { 'x-dsh-connect-channel': channel } });
  check(noToken.status === 401, 'with --token, a missing token is refused');
  const withToken = await fetch(`http://127.0.0.1:${gatedPort}/v1/devices`, {
    headers: { 'x-dsh-connect-channel': channel, 'x-dsh-connect-token': 's3cret' },
  });
  check(withToken.status === 200, 'with --token, the right token is admitted');
  await gated.stop();
  rmSync(gatedDir, { recursive: true, force: true });

  section('mailbox survives a relay restart');
  // Stopping a listener and immediately rebinding the same port races the OS's
  // teardown, which shows up as an intermittent ECONNRESET. Retry the rebind a
  // few times; the behaviour under test is what the relay PERSISTED, not how
  // fast the kernel frees a socket.
  const restartRelay = async (options) => {
    let lastError;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const instance = createRelay(options);
      try {
        await instance.start();
        return instance;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    throw lastError;
  };
  await relay.stop();
  const relay2 = await restartRelay({ host: '127.0.0.1', port, statePath, mailboxLimit: 4, ttlMs: 60_000 });
  const afterRestart = await fetchRetry(`${base}/v1/recv`, {
    method: 'POST',
    headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-b' }),
  }).then((r) => r.json());
  check(afterRestart.messages.length === 0, 'an emptied mailbox stays empty across a restart');
  await fetchRetry(`${base}/v1/send`, {
    method: 'POST',
    headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-a', to: 'dev-b', id: 'pre-restart', body: seal({ x: 1 }) }),
  }).then((r) => r.json());
  await relay2.stop();
  const relay3 = await restartRelay({ host: '127.0.0.1', port, statePath, mailboxLimit: 4, ttlMs: 60_000 });
  const recoveredMail = await fetchRetry(`${base}/v1/recv`, {
    method: 'POST',
    headers: { 'x-dsh-connect-channel': channel, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'dev-b' }),
  }).then((r) => r.json());
  check(recoveredMail.messages.some((m) => m.id === 'pre-restart'), 'undelivered mail survives a relay restart on disk');
  await relay3.stop();
} finally {
  try {
    await relay.stop();
  } catch {
    /* already stopped */
  }
  rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failures.length > 0) {
  console.log(`${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('all relay checks passed');
