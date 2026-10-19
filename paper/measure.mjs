#!/usr/bin/env node
/**
 * Deep Connect — measurements for the paper.
 *
 * Everything here runs the SHIPPED code: the real crypto module, the real relay,
 * the real relay client, the real session adapter. Nothing is simulated except
 * the session corpus, which is synthetic so that size can be controlled.
 *
 * Output: paper/data/metrics.json (raw samples + summaries) and metrics.md.
 *
 * Usage: node paper/measure.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const HERE = dirname(new URL(import.meta.url).pathname);
const ROOT = resolve(HERE, '..');
const DATA = join(HERE, 'data');
mkdirSync(DATA, { recursive: true });

const { createRelay } = require(join(ROOT, 'relay/relay.cjs'));
const cryptoMod = await import(join(ROOT, 'plugin/host/crypto.js'));
const { RelayClient } = await import(join(ROOT, 'plugin/host/relay.js'));
const { SessionAdapter } = await import(join(ROOT, 'plugin/host/sessions.js'));
const { DeepConnectStore } = await import(join(ROOT, 'plugin/host/store.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const METRICS = { generatedAt: new Date().toISOString(), host: {}, samples: {}, summary: {} };

/** Summarize a numeric sample: n, mean, sd, p50, p95, min, max. */
function summarize(values) {
  const v = values.map(Number).sort((a, b) => a - b);
  const n = v.length;
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const q = (p) => {
    const idx = (n - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  const r = (x) => Number(x.toFixed(4));
  return { n, mean: r(mean), sd: r(sd), p50: r(q(0.5)), p95: r(q(0.95)), min: r(v[0]), max: r(v[n - 1]) };
}

function record(key, values, unit) {
  METRICS.samples[key] = values.map((x) => Number(Number(x).toFixed(4)));
  METRICS.summary[key] = { ...summarize(values), unit };
}

/* ------------------------------------------------------------------ crypto */

async function measureCrypto() {
  const account = 'acct-paper-measurement-7f3a91c2';
  const channel = cryptoMod.channelFor(account);

  const derive = [];
  for (let i = 0; i < 20; i += 1) {
    const t0 = performance.now();
    await cryptoMod.deriveKeyPbkdf2(account);
    derive.push(performance.now() - t0);
  }
  record('kdf_ms', derive, 'ms');

  const hashTimes = [];
  for (let i = 0; i < 2000; i += 1) {
    const t0 = performance.now();
    cryptoMod.channelFor(account);
    hashTimes.push((performance.now() - t0) * 1000);
  }
  record('channel_hash_us', hashTimes, 'us');

  const key = await cryptoMod.deriveKeyPbkdf2(account);
  const sizes = [
    [1024, '1 KiB'],
    [8192, '8 KiB'],
    [65536, '64 KiB'],
    [262144, '256 KiB'],
    [1048576, '1 MiB'],
  ];
  const sealThroughput = [];
  const openThroughput = [];
  const overhead = [];
  const plaintextBytes = {};
  const envelopeBytes = {};

  for (const [size, label] of sizes) {
    const payload = { kind: 'history', sessionId: 'session-paper', transcript: [{ seq: 1, role: 'assistant', text: 'x'.repeat(size) }] };
    const envelope = { id: 'e-paper', from: 'dev-a', to: 'dev-b', at: Date.now(), ttlMs: 60000 };
    // Warm up.
    for (let i = 0; i < 3; i += 1) cryptoMod.seal(key, envelope, payload);
    const iterations = size <= 8192 ? 400 : size <= 65536 ? 200 : size <= 262144 ? 80 : 30;
    const t0 = performance.now();
    let body;
    for (let i = 0; i < iterations; i += 1) body = cryptoMod.seal(key, envelope, payload);
    const sealMs = (performance.now() - t0) / iterations;
    sealThroughput.push({ label, size, opsPerSec: 1000 / sealMs, mbPerSec: (size / 1048576) * (1000 / sealMs), msPerOp: sealMs, iterations });
    // Open.
    const t1 = performance.now();
    for (let i = 0; i < iterations; i += 1) cryptoMod.open(key, envelope, body);
    const openMs = (performance.now() - t1) / iterations;
    openThroughput.push({ label, size, opsPerSec: 1000 / openMs, mbPerSec: (size / 1048576) * (1000 / openMs), msPerOp: openMs, iterations });

    const plain = Buffer.byteLength(JSON.stringify(payload));
    const wire = Buffer.byteLength(JSON.stringify({ id: envelope.id, from: envelope.from, to: envelope.to, at: envelope.at, ttlMs: envelope.ttlMs, body }));
    plaintextBytes[label] = plain;
    envelopeBytes[label] = wire;
    overhead.push({ label, plain, wire, ratio: wire / plain, bodyB64: Buffer.byteLength(body) });
  }
  METRICS.sealThroughput = sealThroughput;
  METRICS.openThroughput = openThroughput;
  METRICS.envelopeOverhead = overhead;

  // Negative tests: every tampered or retargeted frame must be rejected.
  const envelope = { id: 'e-neg', from: 'dev-a', to: 'dev-b' };
  const body = cryptoMod.seal(key, envelope, { kind: 'index', secret: 'measure' });
  let wrongKeyRejected = 0;
  let tamperRejected = 0;
  let retargetRejected = 0;
  const otherKey = await cryptoMod.deriveKeyPbkdf2('acct-different-account');
  for (let i = 0; i < 500; i += 1) {
    if (cryptoMod.open(otherKey, envelope, body) === undefined) wrongKeyRejected += 1;
  }
  for (let i = 0; i < 500; i += 1) {
    const raw = Buffer.from(body, 'base64');
    raw[raw.length - 1 - (i % 8)] ^= 0x01 << (i % 8);
    if (cryptoMod.open(key, envelope, raw.toString('base64')) === undefined) tamperRejected += 1;
  }
  for (let i = 0; i < 500; i += 1) {
    if (cryptoMod.open(key, { ...envelope, to: `dev-evil-${i}` }, body) === undefined) retargetRejected += 1;
  }
  METRICS.negative = { wrongKeyRejected, tamperRejected, retargetRejected, trials: 500, channel };

  METRICS.fingerprint = cryptoMod.fingerprint(key);
}

/* --------------------------------------------------- relay + client link */

async function measureLink() {
  const dir = mkdtempSync(join(tmpdir(), 'dc-measure-'));
  const statePath = join(dir, 'relay-state.json');
  const relay = createRelay({ host: '127.0.0.1', port: 0, statePath, mailboxLimit: 512 });
  const port = await relay.start();
  const relayUrl = `http://127.0.0.1:${port}`;
  const account = 'acct-paper-link';
  const key = await cryptoMod.deriveKeyPbkdf2(account);
  const secret = account;

  const storeA = new DeepConnectStore(join(dir, 'a'), {});
  const storeB = new DeepConnectStore(join(dir, 'b'), {});
  await storeA.load();
  await storeB.load();

  const inboxB = [];
  let resolveB = null;
  /** Set before each broadcast so a single handler can time its arrival. */
  let onIndex = null;
  const clientA = new RelayClient({
    store: storeA, key, secret, token: '', relayUrl, deviceName: 'A', deviceId: storeA.getIdentity().deviceId,
    log: () => {}, heartbeatMs: 1000,
    onFrame: () => {}, onRoster: () => {}, onState: () => {},
  });
  const clientB = new RelayClient({
    store: storeB, key, secret, token: '', relayUrl, deviceName: 'B', deviceId: storeB.getIdentity().deviceId,
    log: () => {}, heartbeatMs: 1000,
    onFrame: ({ from, payload }) => {
      inboxB.push(payload);
      if (payload?.kind === 'queued' && resolveB) { resolveB(payload); resolveB = null; }
      if (payload?.kind === 'index' && onIndex) { onIndex(); onIndex = null; }
      if (typeof payload?.requestId === 'string') void clientB.reply(from, payload.requestId, { kind: 'pong', at: Date.now() });
    },
    onRoster: () => {}, onState: () => {},
  });

  // Handshake / connect latency.
  const connectMs = [];
  for (let i = 0; i < 12; i += 1) {
    const t0 = performance.now();
    clientA.start();
    while (!clientA.connected) await sleep(2);
    connectMs.push(performance.now() - t0);
    clientA.stop();
    await sleep(20);
  }
  record('ws_connect_ms', connectMs, 'ms');

  clientA.start();
  clientB.start();
  while (!clientA.connected || !clientB.connected) await sleep(5);
  await sleep(250);
  record('ws_connect_ms', connectMs, 'ms');

  /** Round trip through relay: A sends, B receives, B replies, A resolves. */
  /** A asks B, B answers: one full request/response over the relay. */
  async function roundTrip(sizeBytes, iterations) {
    const samples = [];
    for (let i = 0; i < iterations; i += 1) {
      const requestId = `q-paper-${sizeBytes}-${i}`;
      const text = 'y'.repeat(sizeBytes);
      const t0 = performance.now();
      const result = await clientA.send(clientB.deviceId, { kind: 'ping', requestId, text }, { id: requestId, waitForReply: true, timeoutMs: 15000 });
      const dt = performance.now() - t0;
      if (result.reply === undefined) continue;
      samples.push(dt);
      await sleep(2);
    }
    return samples;
  }

  const rtt1k = await roundTrip(1024, 60);
  const rtt64k = await roundTrip(65536, 40);
  record('rtt_1k_ms', rtt1k, 'ms');
  record('rtt_64k_ms', rtt64k, 'ms');

  // One-way index delivery: A broadcasts, B records arrival.
  const indexTimes = [];
  for (let i = 0; i < 30; i += 1) {
    const arrived = new Promise((r) => { onIndex = r; });
    const t0 = performance.now();
    await clientA.send('*', { kind: 'index', at: Date.now(), entries: new Array(50).fill(0).map((_, k) => ({ sessionId: `s-${k}`, title: `t${k}`, updatedAt: Date.now(), eventCount: 12 })) });
    const got = await Promise.race([arrived.then(() => true), sleep(2000).then(() => false)]);
    if (got) indexTimes.push(performance.now() - t0);
    await sleep(2);
  }
  record('index_broadcast_ms', indexTimes, 'ms');

  // Offline mailbox: queue to a device the relay knows but cannot reach, then
  // reconnect it and time the drain.
  const queued = 40;
  clientB.stop();
  await sleep(200);
  const before = inboxB.length;
  for (let i = 0; i < queued; i += 1) {
    await clientA.send(clientB.deviceId, { kind: 'queued', i }, {});
  }
  await sleep(100);
  const drainStart = performance.now();
  clientB.start();
  const drainDeadline = performance.now() + 15000;
  while (inboxB.length - before < queued && performance.now() < drainDeadline) await sleep(2);
  METRICS.mailboxDrain = {
    queued,
    received: inboxB.length - before,
    drainMs: Number((performance.now() - drainStart).toFixed(2)),
  };

  // Reconnect detection: stop the relay, see how long the client takes to notice.
  const detectStart = performance.now();
  await relay.stop();
  const detectDeadline = performance.now() + 8000;
  while (clientA.connected && performance.now() < detectDeadline) await sleep(5);
  METRICS.detectDisconnectMs = Number((performance.now() - detectStart).toFixed(2));

  clientA.stop();
  clientB.stop();
  rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------- indexed session corpus */

/** Build a synthetic session with `turns` user/assistant pairs plus task events. */
function syntheticSession(index, turns) {
  const events = [
    { type: 'session/title', seq: 0, time: 1_700_000_000_000 + index, data: { title: `Session ${index}`, messageSeqs: [], source: { kind: 'user' } } },
    { type: 'todo/write', seq: 1, time: 1_700_000_000_100 + index, data: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] } },
    { type: 'goal/change', seq: 2, time: 1_700_000_000_200 + index, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { objective: `goal ${index}`, status: 'active' }, roundsStarted: 0, createdAt: 1, updatedAt: 2 } },
    { type: 'team/task', seq: 3, time: 1_700_000_000_300 + index, data: { version: 2, teamId: 't1', task: { id: 'k1', status: 'completed' } } },
  ];
  let seq = 4;
  for (let t = 0; t < turns; t += 1) {
    events.push({ type: 'user/message', seq: seq++, time: 1_700_000_001_000 + t, surfaceOp: 'append', data: { role: 'user', id: `u${t}`, content: [{ type: 'text', text: `question ${t} about the relay design and its guarantees` }], source: { kind: 'user' } } });
    events.push({ type: 'assistant/message', seq: seq++, time: 1_700_000_001_500 + t, surfaceOp: 'append', data: { turn: t + 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `answer ${t}: `.padEnd(120, 'z') }] }, stream: [] } });
  }
  return { header: { id: `session-paper-${index}`, createdAt: 1_700_000_000_000 + index, cwd: `/work/project-${index}`, isSeeded: false }, live: false, persisted: true, events };
}

async function measureCorpus() {
  const scale = [
    { sessions: 10, turns: 20 },
    { sessions: 50, turns: 20 },
    { sessions: 200, turns: 20 },
  ];
  const indexRows = [];
  for (const { sessions, turns } of scale) {
    const corpus = new Array(sessions).fill(0).map((_, i) => syntheticSession(i, turns));
    const ctx = {
      get: (name) => (name === 'sessionQuery'
        ? {
            listSessions: async () => corpus.map(({ header, live, persisted }) => ({ header, live, persisted })),
            readSession: async (id) => {
              const found = corpus.find((s) => s.header.id === id);
              if (found === undefined) throw new Error('missing');
              return { session: found.header, inheritedEventCount: 0, events: found.events };
            },
            readTitleSnapshot: async () => undefined,
          }
        : undefined),
    };
    const adapter = new SessionAdapter(ctx, { log: () => {} });
    const t0 = performance.now();
    const entries = await adapter.buildIndex({ limit: 300 });
    const ms = performance.now() - t0;
    const wire = JSON.stringify(entries).length;
    indexRows.push({ sessions, turns, buildMs: Number(ms.toFixed(2)), wireBytes: wire, perSessionBytes: Math.round(wire / sessions), events: sessions * (turns * 2 + 4) });
  }
  METRICS.indexScale = indexRows;

  // Transcript extraction: small / medium / large.
  const transcriptRows = [];
  for (const turns of [6, 200, 2000]) {
    const corpus = [syntheticSession(0, turns)];
    const ctx = { get: (name) => (name === 'sessionQuery' ? {
      listSessions: async () => corpus.map(({ header, live, persisted }) => ({ header, live, persisted })),
      readSession: async () => ({ session: corpus[0].header, inheritedEventCount: 0, events: corpus[0].events }),
      readTitleSnapshot: async () => undefined,
    } : undefined) };
    const adapter = new SessionAdapter(ctx, { log: () => {} });
    const times = [];
    let doc;
    for (let i = 0; i < 8; i += 1) {
      const t0 = performance.now();
      doc = await adapter.exportTranscript('session-paper-0');
      times.push(performance.now() - t0);
    }
    const plain = JSON.stringify(doc).length;
    const key = await cryptoMod.deriveKeyPbkdf2('acct-paper-transcript');
    const envelope = { id: 'e-t', from: 'a', to: 'b' };
    const t0 = performance.now();
    const body = cryptoMod.seal(key, envelope, doc);
    const sealMs = performance.now() - t0;
    transcriptRows.push({
      turns, events: corpus[0].events.length, exportMs: Number(summarize(times).p50.toFixed(2)),
      plaintextBytes: plain, ciphertextBytes: Buffer.byteLength(body), wireBytes: Buffer.byteLength(JSON.stringify({ id: envelope.id, from: envelope.from, to: envelope.to, body })) + sealMs * 0,
      sealMs: Number(sealMs.toFixed(3)),
    });
  }
  METRICS.transcripts = transcriptRows;

  // Task fold accuracy: the fold must see todo/goal/team events in the synthetic corpus.
  const corpus = [syntheticSession(0, 5)];
  const ctx = { get: (name) => (name === 'sessionQuery' ? {
    listSessions: async () => corpus.map(({ header, live, persisted }) => ({ header, live, persisted })),
    readSession: async () => ({ session: corpus[0].header, inheritedEventCount: 0, events: corpus[0].events }),
    readTitleSnapshot: async () => undefined,
  } : undefined) };
  const adapter = new SessionAdapter(ctx, { log: () => {} });
  const entries = await adapter.buildIndex({ limit: 10 });
  METRICS.taskFold = entries[0]?.tasks ?? null;
}

/* --------------------------------------------------------- code and tests */

function measureCode() {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (['node_modules', '.git', 'paper', 'profile-backup', 'build', 'data', 'assets'].includes(name)) continue;
        walk(full);
      } else {
        files.push({ path: full.slice(ROOT.length + 1), bytes: st.size, lines: readFileSync(full, 'utf8').split('\n').length });
      }
    }
  };
  walk(ROOT);
  const code = files.filter((f) => f.path.endsWith('.js') || f.path.endsWith('.mjs') || f.path.endsWith('.cjs'));
  const sum = (arr, key) => arr.reduce((s, x) => s + x[key], 0);
  METRICS.code = {
    files: files.length,
    codeFiles: code.length,
    codeLines: sum(code, 'lines'),
    totalBytes: sum(files, 'bytes'),
    pluginLines: sum(code.filter((f) => f.path.startsWith('plugin/')), 'lines'),
    relayLines: sum(code.filter((f) => f.path.startsWith('relay/')), 'lines'),
    testLines: sum(code.filter((f) => f.path.startsWith('tools/')), 'lines'),
    filesByPath: files.map((f) => ({ path: f.path, bytes: f.bytes })),
  };
}

/* -------------------------------------------------------------- run + save */

const failures = [];
async function attempt(name, fn) {
  try {
    const t0 = performance.now();
    await fn();
    console.log(`  ok   ${name} (${Math.round(performance.now() - t0)}ms)`);
  } catch (error) {
    failures.push({ name, error: String(error?.stack ?? error) });
    console.log(`  FAIL ${name}: ${error?.message ?? error}`);
  }
}

console.log('Deep Connect measurements');
await attempt('crypto', measureCrypto);
await attempt('link', measureLink);
await attempt('corpus', measureCorpus);
await attempt('code', measureCode);

METRICS.failures = failures;
writeFileSync(join(DATA, 'metrics.json'), `${JSON.stringify(METRICS, null, 2)}\n`);

const md = ['# Deep Connect measurements', ''];
for (const [key, value] of Object.entries(METRICS.summary)) {
  md.push(`- **${key}** (${value.unit}): n=${value.n}, mean ${value.mean}, sd ${value.sd}, p50 ${value.p50}, p95 ${value.p95}, min ${value.min}, max ${value.max}`);
}
md.push('', '## Seal throughput', '', '| payload | ops/s | MB/s | ms/op |', '|---|---|---|---|');
for (const row of METRICS.sealThroughput ?? []) md.push(`| ${row.label} | ${row.opsPerSec.toFixed(0)} | ${row.mbPerSec.toFixed(2)} | ${row.msPerOp.toFixed(3)} |`);
md.push('', '## Index scale', '', '| sessions | events | build ms | wire bytes | per session |', '|---|---|---|---|---|');
for (const row of METRICS.indexScale ?? []) md.push(`| ${row.sessions} | ${row.events} | ${row.buildMs} | ${row.wireBytes} | ${row.perSessionBytes} |`);
md.push('', '## Transcripts', '', '| turns | events | export p50 ms | plaintext B | ciphertext B | wire B |', '|---|---|---|---|---|---|');
for (const row of METRICS.transcripts ?? []) md.push(`| ${row.turns} | ${row.events} | ${row.exportMs} | ${row.plaintextBytes} | ${row.ciphertextBytes} | ${row.wireBytes} |`);
writeFileSync(join(DATA, 'metrics.md'), `${md.join('\n')}\n`);
console.log(`\nwrote ${join(DATA, 'metrics.json')}`);
if (failures.length > 0) process.exitCode = 1;
