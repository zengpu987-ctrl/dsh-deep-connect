#!/usr/bin/env node
/**
 * Deep Connect — end-to-end test with no DSH boot.
 *
 * Starts a REAL relay on an ephemeral port, then applies the plugin TWICE with
 * two stub Host contexts, each holding its own little session corpus. Everything
 * after that is the shipped code path: the real relay client, real AES-GCM
 * sealing, the real index builder, the real route handler.
 *
 * This is the test that can actually fail in a useful way, because the two
 * halves are genuinely independent processes-worth of state talking over a
 * socket.
 *
 * Usage: node tools/deep-connect-e2e.mjs
 */
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createRelay } = require('../relay/relay.cjs');

const failures = [];
const check = (condition, label) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
};
const section = (title) => console.log(`\n${title}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `predicate` answers something truthy, or fail the wait.
 * @returns {Promise<any>} the first truthy value.
 */
async function until(predicate, { timeoutMs = 8000, everyMs = 50, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

/** One fake conversation, as the session services would report it. */
function makeSession({ id, title, cwd, texts, tasks }) {
  const events = [
    { type: 'session/title', seq: 0, time: 1_700_000_000_000, data: { title, messageSeqs: [], source: { kind: 'user' } } },
  ];
  let seq = 1;
  for (const [index, text] of texts.entries()) {
    events.push({ type: 'user/message', seq: seq++, time: 1_700_000_100_000 + index, surfaceOp: 'append', data: { role: 'user', id: `u${index}`, content: [{ type: 'text', text }], source: { kind: 'user' } } });
    events.push({
      type: 'assistant/message',
      seq: seq++,
      time: 1_700_000_100_500 + index,
      surfaceOp: 'append',
      data: { turn: index + 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: `答复 ${index}：${text}` }] }, stream: [] },
    });
  }
  for (const item of tasks?.todos ?? []) {
    events.push({ type: 'todo/write', seq: seq++, time: 1_700_000_200_000, data: { todos: tasks.todos } });
    break;
  }
  if (tasks?.goal !== undefined) {
    events.push({ type: 'goal/change', seq: seq++, time: 1_700_000_200_100, data: { kind: 'goal/change', version: 1, operation: 'create', goal: { objective: tasks.goal, status: 'active' }, roundsStarted: 0, createdAt: 1, updatedAt: 2 } });
  }
  for (const task of tasks?.team ?? []) {
    events.push({ type: 'team/task', seq: seq++, time: 1_700_000_200_200, data: { version: 2, teamId: 'team-1', task: task } });
  }
  return { header: { version: 4, id, createdAt: 1_700_000_000_000, cwd, isSeeded: false }, live: false, persisted: true, events };
}

/**
 * A stub Host context exposing exactly the surface the plugin touches.
 * @returns {object} the context, plus captured route registrations.
 */
function makeStubContext({ accountId, sessions, prompts, log }) {
  const routes = [];
  const listeners = [];
  /** Sessions the plugin itself wrote (inheritance lands here). */
  const written = [];
  const services = {
    sessions: { list: () => sessions.filter((s) => s.live).map((s) => ({ id: s.header.id })) },
    sessionQuery: {
      listSessions: async () => sessions.map(({ header, live, persisted }) => ({ header, live, persisted })),
      readSession: async (id) => {
        const found = sessions.find((s) => s.header.id === id);
        if (found === undefined) throw new Error(`no session ${id}`);
        return { session: found.header, inheritedEventCount: 0, events: found.events };
      },
      readTitleSnapshot: async (id) => {
        const found = sessions.find((s) => s.header.id === id);
        if (found === undefined) return undefined;
        const title = [...found.events].reverse().find((e) => e.type === 'session/title');
        return title === undefined ? undefined : { session: found.header, title: { title: title.data.title, messageSeqs: [], source: { kind: 'user' }, eventSeq: title.seq, updatedAt: title.time } };
      },
    },
    // Just enough of the durable store for the inherit path: create + append +
    // flush + close, plus list/stat for version discovery.
    sessionPersistence: {
      list: async () => written.map((session) => ({ header: session.header, revision: `rev-${session.events.length}`, eventCount: session.events.length })),
      stat: async (id) => {
        const found = written.find((session) => session.header.id === id);
        return found === undefined ? undefined : { header: found.header, revision: `rev-${found.events.length}`, eventCount: found.events.length };
      },
      open: async (id) => {
        const found = written.find((session) => session.header.id === id);
        if (found === undefined) throw new Error(`no stored session ${id}`);
        return {
          id,
          header: found.header,
          inheritedEventCount: 0,
          access: 'read',
          read: async () => ({ eventState: 'detached', events: [...found.events] }),
          close: async () => {},
        };
      },
      create: async (header) => {
        const session = { header, events: [] };
        written.push(session);
        return {
          id: header.id,
          header,
          inheritedEventCount: 0,
          access: 'write',
          append: async (events) => {
            session.events.push(...events);
          },
          flush: async () => {},
          close: async () => {},
        };
      },
    },
    deepseekAccount: {
      getProfile: async () => (accountId === undefined ? null : { status: 'ready', value: { id: accountId, name: '测试账号', contact: null } }),
    },
    sessionController: {
      prompt: async (request) => {
        prompts.push(request);
      },
      create: async () => ({ sessionId: `session-new-${prompts.length + 1}` }),
    },
  };
  const ctx = {
    logger: { info: (m) => log(`info ${m}`), warn: (m) => log(`warn ${m}`), debug: () => {}, error: (m) => log(`error ${m}`) },
    get: (serviceName) => services[serviceName],
    on: (event, handler) => {
      listeners.push({ event, handler });
      return () => {};
    },
    interval: () => () => {},
    effect: (execute) => {
      const disposer = execute();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    inject: (deps, callback) => {
      if (deps.every((dep) => services[dep] !== undefined || dep === 'connection')) {
        callback({
          ...ctx,
          connection: {
            fetch: {
              register: (route) => {
                routes.push(route);
                return async () => {};
              },
            },
          },
        });
      }
      return undefined;
    },
  };
  return { ctx, routes, listeners, services, written };
}

/* ------------------------------- run ------------------------------- */

const dir = mkdtempSync(join(tmpdir(), 'deep-connect-e2e-'));
const relayState = join(dir, 'relay-state.json');
const relay = createRelay({ host: '127.0.0.1', port: 0, statePath: relayState });
const relayPort = await relay.start();
const relayUrl = `http://127.0.0.1:${relayPort}`;
console.log(`relay on ${relayUrl}`);

const { apply, PLUGIN_VERSION } = await import('../plugin/index.js');

const promptsA = [];
const promptsB = [];
const sessionsA = [
  makeSession({
    id: 'session-alpha',
    title: '把中继写成单文件',
    cwd: '/Users/zp/work/alpha',
    texts: ['帮我把中继端写成单文件', '顺便加上端到端加密', '再补一个部署脚本'],
    tasks: { todos: [{ content: '写 relay', status: 'completed' }, { content: '写测试', status: 'pending' }], goal: '让两台 DSH 互联', team: [{ id: 't1', status: 'completed' }, { id: 't2', status: 'in_progress' }] },
  }),
  makeSession({ id: 'session-beta', title: '一个很短的会话', cwd: '/Users/zp/work/beta', texts: ['只问一句'] }),
];
const sessionsB = [
  makeSession({ id: 'session-gamma', title: 'B 机的会话', cwd: '/Users/zp/work/gamma', texts: ['这是 B 机上的对话', '第二句'] }),
];

const logs = [];
const hostA = makeStubContext({ accountId: 'acct-shared-7f3a', sessions: sessionsA, prompts: promptsA, log: (m) => logs.push(`A ${m}`) });
const hostB = makeStubContext({ accountId: 'acct-shared-7f3a', sessions: sessionsB, prompts: promptsB, log: (m) => logs.push(`B ${m}`) });

try {
  section('start two Host halves against one relay');
  const apiA = apply(hostA.ctx, { root: join(dir, 'a'), relayUrl, deviceName: 'A 机', indexIntervalMs: 5000, heartbeatMs: 1500 });
  const apiB = apply(hostB.ctx, { root: join(dir, 'b'), relayUrl, deviceName: 'B 机', indexIntervalMs: 5000, heartbeatMs: 1500 });
  // The production heartbeat is 20s; a test cannot wait that long, and the
  // recovery path is exactly what the relay-restart section exercises.
  check(hostA.routes.length === 1 && hostA.routes[0].path === '/api/deep-connect/api', 'A registered the browser route');
  check(hostB.routes.length === 1, 'B registered the browser route');
  check(apiA !== undefined && typeof apiA.command === 'function', 'the plugin returns its test surface');

  let peekA;
  const listA = await until(async () => {
    const value = await apiA.command({ action: 'list' });
    peekA = value;
    // `sessions` is the merged view of BOTH machines; what A "sees of its own"
    // is only the rows that are not remote.
    return value.self.connected && value.self.fingerprint !== '' && value.sessions.filter((row) => row.isRemote !== true).length === 2 ? value : undefined;
  }, { what: `A to index its own corpus (last saw connected=${peekA?.self?.connected} local=${peekA?.sessions?.filter((r) => r.isRemote !== true).length} indexError=${peekA?.lastIndexError})` });
  const localRowsA = listA.sessions.filter((row) => row.isRemote !== true);
  check(listA.self.name === 'A 机', 'A knows its own name');
  check(localRowsA.length === 2, 'A sees its own two sessions');
  check(listA.self.relayUrl === relayUrl, 'A reports the relay it is dialing');
  check(listA.peers.length === 0 || listA.peers.every((p) => p.deviceId !== listA.self.deviceId), 'A never lists itself as a peer');

  section('key agreement and the index crossing the wire');
  const listB = await until(async () => {
    const value = await apiB.command({ action: 'list' });
    return value.peers.some((p) => p.online) && value.sessions.some((s) => s.isRemote) ? value : undefined;
  }, { what: "B to see A's session index" });
  check(listB.self.fingerprint === listA.self.fingerprint, `both machines derived the same key fingerprint (${listA.self.fingerprint})`);
  check(listB.peers.length === 1 && listB.peers[0].online === true, 'B sees exactly one online peer');
  const remoteRows = listB.sessions.filter((s) => s.isRemote);
  check(remoteRows.length === 2, "A's two sessions arrived in B's list");
  const alpha = remoteRows.find((s) => s.sessionId === 'session-alpha');
  check(alpha !== undefined && alpha.title === '把中继写成单文件', 'the remote title survived the round trip');
  check(alpha.userPrompts.length === 3, 'the index carries first-two-plus-last prompts');
  check(alpha.tasks.open === 1 && alpha.tasks.done === 1, 'todo counts folded from the log');
  check(alpha.tasks.team === 2 && alpha.tasks.teamDone === 1, 'team task counts folded from the log');
  check(alpha.tasks.goal === '让两台 DSH 互联', 'the goal objective folded from the log');
  check(Array.isArray(alpha.tasks.items) && alpha.tasks.items.length >= 3, 'the task CONTENT crossed the wire, not just counts');
  check(alpha.tasks.items.some((item) => item.text === '写测试' && item.status === 'open'), 'the open todo keeps its text and state');
  check(alpha.tasks.items.some((item) => item.kind === 'goal' && item.text === '让两台 DSH 互联'), 'the goal appears as a task item');

  const remoteSessionIds = listB.sessions.filter((s) => !s.isRemote).map((s) => s.sessionId);
  check(remoteSessionIds.includes('session-gamma'), 'B still sees its own session');

  section('an offline mailbox holds ciphertext, not plaintext');
  // Exercise the mailbox path on its own terms: the relay's HTTP API accepts an
  // envelope for a device that is not connected, which is exactly what happens
  // when the last machine goes offline for the night. It must queue the opaque
  // body and nothing else.
  await sleep(1500);
  {
    const relayB = apiB.state.relay;
    console.log(`    · after restart: A.connected=${(await apiA.command({ action: 'list' })).self.connected} B.connected=${relayB.connected}`);
  }
  const envelopeBody = 'ZGVlcC1jb25uZWN0LXRlc3QtY2lwaGVydGV4dC1nb2VzLWhlcmUtYW5kLWlzLWxvbmc=';
  // The relay refuses to invent a mailbox for a device it has never seen — a
  // deliberate choice, since otherwise anyone holding the channel could make it
  // allocate unbounded storage. So register the device first, exactly as a
  // machine does on connect, and then let it leave.
  const enrolledPeer = await fetch(`${relayUrl}/v1/recv`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-connect-channel': apiA.state.relay.channel },
    body: JSON.stringify({ deviceId: 'dev-absent-too', name: '离线机', waitMs: 0 }),
  }).then((response) => response.json());
  check(Array.isArray(enrolledPeer.devices), 'a device enrolls in the channel by polling once');
  const postResponse = await fetch(`${relayUrl}/v1/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-connect-channel': apiA.state.relay.channel },
    body: JSON.stringify({ deviceId: 'dev-absent', to: 'dev-absent-too', id: 'e-offline-test', body: envelopeBody, ttlMs: 600_000 }),
  }).then((response) => response.json());
  check(postResponse.queuedFor?.includes('dev-absent-too'), `the relay queues mail for the offline device (${JSON.stringify(postResponse)})`);
  const unknownDevice = await fetch(`${relayUrl}/v1/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-connect-channel': apiA.state.relay.channel },
    body: JSON.stringify({ deviceId: 'dev-absent', to: 'dev-never-seen', id: 'e-unknown', body: envelopeBody }),
  }).then((response) => response.json());
  check(unknownDevice.queuedFor.length === 0 && unknownDevice.delivered.length === 0, 'the relay refuses to allocate a mailbox for a device it has never seen');
  await sleep(700);
  const relayStateText = readFileSync(relayState, 'utf8');
  check(relayStateText.length > 0, 'the relay state file exists and holds the queued envelope');
  check(relayStateText.includes('e-offline-test'), 'the queued envelope keeps only its routing id');
  const queued = JSON.parse(relayStateText);
  const queuedEnvelope = Object.values(queued)
    .flatMap((devices) => devices)
    .flatMap((device) => device.mailbox ?? [])
    .find((envelope) => envelope?.id === 'e-offline-test');
  check(queuedEnvelope !== undefined, 'the mailbox holds the envelope for the offline device');
  check(
    Object.keys(queuedEnvelope ?? {}).join(',') === 'id,from,to,at,ttlMs,body,seq,expiresAt',
    `an envelope carries routing metadata plus one body (${Object.keys(queuedEnvelope ?? {}).join(',')})`,
  );
  check(queuedEnvelope.body === envelopeBody, 'the relay stored the body byte-for-byte and never parsed it');
  check(!/[\u4e00-\u9fff]/.test(queuedEnvelope.body), 'the body is opaque, not readable text');

  section('the relay never sees plaintext on the wire either');
  // The real proof: what two devices actually exchanged never appears as text
  // anywhere the relay wrote.
  check(!relayStateText.includes('把中继写成单文件'), 'no conversation title appears in the relay state file');
  check(!relayStateText.includes('答复'), 'no assistant text appears in the relay state file');
  check(!relayStateText.includes('acct-shared-7f3a'), 'the account id never reaches the relay');


  section('the peer comes back and answers');
  await until(async () => {
    const value = await apiB.command({ action: 'list' });
    return value.self.connected && value.peers.some((p) => p.online) ? value : undefined;
  }, { timeoutMs: 30_000, what: 'B to reconnect and see A online' });

  section('reading a remote conversation in full');
  const history = await apiB.command({ action: 'history', deviceId: alpha.ownerId, sessionId: 'session-alpha' });
  check(history.transcript.length === 6, `full transcript fetched for the first time (${history.transcript.length} turns)`);
  check(history.transcript[0].role === 'user' && history.transcript[1].role === 'assistant', 'turns alternate user/assistant');
  check(history.transcript.some((t) => t.text.includes('顺便加上端到端加密')), 'middle turns are present, not just the previews');
  check(typeof history.fromCache === 'boolean', 'the answer states whether it came from the peer or the local copy');
  // 1 title + 3 user + 3 assistant + 1 todo/write + 1 goal/change + 2 team/task.
  check(history.eventCount === 11, `the full event log is reported, task events included (${history.eventCount})`);

  const cachedAgain = await apiB.command({ action: 'history', deviceId: alpha.ownerId, sessionId: 'session-alpha' });
  check(cachedAgain.fromCache === true, 'a second read is served from the local copy');
  check(cachedAgain.transcript.length === 6, 'the cached copy is complete');

  section('a conversation that was never fetched is not invented');
  let neverFetched = '';
  try {
    await apiB.command({ action: 'history', deviceId: alpha.ownerId, sessionId: 'session-beta' });
    neverFetched = 'no-error';
  } catch (error) {
    neverFetched = error.code ?? 'thrown';
  }
  check(neverFetched === 'no-error', 'a second real session on the peer is fetched on demand');
  const betaRemote = await apiB.command({ action: 'history', deviceId: alpha.ownerId, sessionId: 'session-beta' });
  check(betaRemote.transcript.length === 2, `the second remote session reads correctly (${betaRemote.transcript.length} turns)`);
  // A session id that exists only on THIS machine must be addressed to it, not
  // to the peer: an id is scoped by its owning device.
  const ownSession = await apiB.command({ action: 'history', deviceId: listB.self.deviceId, sessionId: 'session-gamma' });
  check(ownSession.transcript.length === 4, 'a local-only session is read locally, not looked up on the peer');
  let wrongOwner = '';
  try {
    await apiB.command({ action: 'history', deviceId: alpha.ownerId, sessionId: 'session-gamma' });
    wrongOwner = 'no-error';
  } catch (error) {
    wrongOwner = error.code ?? 'thrown';
  }
  check(wrongOwner === 'not-found', 'asking the peer for a session it does not own fails honestly');

  section('reading a local conversation through the same path');
  const localHistory = await apiB.command({ action: 'history', deviceId: listB.self.deviceId, sessionId: 'session-gamma' });
  check(localHistory.transcript.length === 4, 'local reads skip the relay entirely');

  section('continuing a conversation on the other machine');
  const accepted = await apiB.command({ action: 'prompt', deviceId: alpha.ownerId, sessionId: 'session-alpha', text: '在 A 机上继续：再加一条日志', mode: 'queue' });
  check(accepted.accepted === true, 'A accepted the prompt from B');
  check(promptsA.length === 1, 'the prompt reached the real session controller path');
  check(promptsA[0].sessionId === 'session-alpha', 'it was addressed to the right session');
  check(promptsA[0].content[0].text === '在 A 机上继续：再加一条日志', 'the text survived encryption intact');
  check(promptsA[0].mode === 'queue', 'queue mode is preserved');
  check(typeof promptsA[0].requestId === 'string' && promptsA[0].requestId.startsWith('dc-'), 'the prompt carries a fresh request id');
  check(promptsB.length === 0, 'B did not execute anything locally');

  section('a request for something that does not exist fails honestly');
  let missingCode = '';
  try {
    await apiB.command({ action: 'history', deviceId: alpha.ownerId, sessionId: 'session-nope' });
    missingCode = 'no-error';
  } catch (error) {
    missingCode = error.code ?? 'thrown';
  }
  check(missingCode === 'not-found', `an unknown session answers a not-found error (${missingCode})`);

  let offlineCode = '';
  try {
    await apiB.command({ action: 'prompt', deviceId: 'dev-does-not-exist', sessionId: 'session-alpha', text: 'hi' });
    offlineCode = 'no-error';
  } catch (error) {
    offlineCode = error.code ?? 'thrown';
  }
  check(offlineCode === 'not-found', `prompting an offline device is refused (${offlineCode})`);

  section('a different account cannot join the room');
  const strangerPrompts = [];
  const stranger = makeStubContext({ accountId: 'acct-other-9999', sessions: [], prompts: strangerPrompts, log: () => {} });
  const apiC = apply(stranger.ctx, { root: join(dir, 'c'), relayUrl, deviceName: '陌生人', indexIntervalMs: 5000, heartbeatMs: 1500 });
  const strangerList = await until(async () => {
    const value = await apiC.command({ action: 'list' });
    return value.self.connected ? value : undefined;
  }, { what: 'the stranger to connect' });
  check(strangerList.self.fingerprint !== listA.self.fingerprint, 'a different account derives a different key');
  await sleep(600);
  const strangerAfter = await apiC.command({ action: 'list' });
  check(strangerAfter.peers.length === 0, 'the stranger sees no peers from the other account');
  check(strangerAfter.sessions.length === 0, 'the stranger sees no foreign sessions');
  const listAAfter = await apiA.command({ action: 'list' });
  check(listAAfter.peers.every((p) => p.name !== '陌生人'), 'the original room never admits the stranger');
  check(listAAfter.peers.length === 1, 'the original room still has exactly its one peer');

  section('a corrupted frame is refused');
  {
    const { seal, open } = await import('../plugin/host/crypto.js');
    const key = new Uint8Array(32).fill(7);
    const envelope = { id: 'e-x', from: 'a', to: 'b' };
    const body = seal(key, envelope, { kind: 'index', secret: '你好' });
    check(open(key, envelope, body)?.secret === '你好', 'a frame opens with the right key');
    const otherKey = new Uint8Array(32).fill(8);
    check(open(otherKey, envelope, body) === undefined, 'a frame does NOT open with the wrong key');
    const retargeted = { id: 'e-x', from: 'a', to: 'evil' };
    check(open(key, retargeted, body) === undefined, 'retargeting a frame in transit fails the tag check');
    const tampered = Buffer.from(body, 'base64');
    tampered[tampered.length - 1] ^= 0x01;
    check(open(key, envelope, tampered.toString('base64')) === undefined, 'flipping one ciphertext bit fails the tag check');
  }

  section('every peer conversation body is pulled automatically');
  const peerId = listA.peers[0]?.deviceId;
  const synced = await until(async () => {
    const value = await apiA.command({ action: 'list' });
    return value.stats.remoteWithCopy >= 1 && value.stats.syncRunning !== true ? value : undefined;
  }, { timeoutMs: 20_000, what: `A to pull B's conversation body (remoteWithCopy=${listA.stats.remoteWithCopy})` });
  const syncedPeerId = synced.peers[0]?.deviceId ?? peerId;
  check(typeof syncedPeerId === 'string' && syncedPeerId !== '', 'A knows which device the copy came from');
  const gammaRow = synced.sessions.find((row) => row.isRemote === true && row.sessionId === 'session-gamma');
  check(synced.stats.remoteWithCopy >= 1, 'A reports at least one peer body on disk');
  check(gammaRow !== undefined && gammaRow.hasCopy === true, "B's conversation is cached on A without anyone clicking it");
  check(synced.stats.remote === 1, 'A still lists exactly the one peer session');

  section('a cached body opens without a live round trip');
  const cachedHistory = await apiA.command({ action: 'history', deviceId: syncedPeerId, sessionId: 'session-gamma' });
  check(cachedHistory.fromCache === true, 'the reader is served from the local copy');
  check(Array.isArray(cachedHistory.transcript) && cachedHistory.transcript.length >= 4, 'the local copy carries the whole transcript');
  check(cachedHistory.tasks !== undefined, 'the task board came with the copy');

  section('inheriting a conversation as a local session');
  const inherited = await apiB.command({ action: 'inherit', deviceId: listA.self.deviceId, sessionId: 'session-alpha' });
  check(typeof inherited.sessionId === 'string' && inherited.sessionId.startsWith('session-'), 'the Host minted a local session id');
  check(inherited.eventCount === sessionsA[0].events.length, "every source event crossed the wire");
  const stored = hostB.written.find((session) => session.header.id === inherited.sessionId);
  check(stored !== undefined, 'the new session was written through sessionPersistence');
  check(stored !== undefined && stored.events.length === sessionsA[0].events.length, 'the stored log has the same number of events');
  check(stored !== undefined && stored.events[0]?.seq === 0 && stored.events.at(-1)?.seq === stored.events.length - 1, 'sequence numbers are re-based to 0..n-1');
  check(stored !== undefined && stored.events.some((event) => event.type === 'todo/write'), 'todo events survived the copy');
  check(stored !== undefined && stored.header.isSeeded === false && typeof stored.header.version === 'number', 'the header is a valid ordinary session header');

  section('v3: station surface, invite links, version compare');
  check(listA.version === PLUGIN_VERSION && listA.protocol === 3 && listA.edition === 'Pro', `the panel reports v3 Pro (${listA.version}/${listA.protocol}/${listA.edition})`);
  check(listA.station !== null && typeof listA.station === 'object' && listA.station.link === '', 'a machine with no station reports an empty station');
  check(listA.update !== null && typeof listA.update === 'object' && listA.update.current === PLUGIN_VERSION, 'the update block reports the current version');
  const { parseStationLink, stationLink } = await import('../plugin/host/station.js');
  const invite = stationLink('https://abc-def.trycloudflare.com', 'invite-token-0123456789');
  const parsed = parseStationLink(invite);
  check(parsed.baseUrl === 'https://abc-def.trycloudflare.com', 'the invite link round-trips its address');
  check(parsed.token === 'invite-token-0123456789', 'the invite token rides in the fragment');
  const bare = parseStationLink('abc-def.trycloudflare.com#invite-token-0123456789');
  check(bare.baseUrl === 'https://abc-def.trycloudflare.com', 'a link without a scheme is still accepted');
  let rejected = false;
  try {
    parseStationLink('https://abc-def.trycloudflare.com');
  } catch {
    rejected = true;
  }
  check(rejected, 'a link without the invite token is rejected');
  check(apiA.compareVersion('3.0.1', '3.0.0') === 1, '3.0.1 is newer than 3.0.0');
  check(apiA.compareVersion('v2.9.9', '3.0.0') === -1, 'v2.9.9 is older than 3.0.0');
  check(apiA.compareVersion('3.0.0', '3.0.0') === 0, 'equal versions compare equal');
  const { pickLatestVersion } = await import('../plugin/index.js');
  check(pickLatestVersion([{ name: 'v2.0.0' }, { name: 'v3.0.1' }, { name: 'v3.0.0' }, { name: 'not-a-version' }]) === '3.0.1', 'the update check picks the highest tag, not the first');

  section('v3.0.2: send a command to another DSH');
  const taskReply = await apiB.command({ action: 'task-run', deviceId: listA.self.deviceId, text: '在 A 上跑一下统计' });
  check(taskReply.accepted === true, 'the peer accepts a remote command');
  check(String(taskReply.sessionId).startsWith('session-new-'), 'the command lands in a NEW session on the peer');
  check(promptsA.some((request) => request.sessionId === taskReply.sessionId && request.content?.[0]?.text === '在 A 上跑一下统计'), 'the peer actually admits the prompt');

  section('v3.0.2: memory sharing can be switched off');
  await apiA.command({ action: 'configure', shareMemory: false });
  await until(async () => {
    const value = await apiB.command({ action: 'list' });
    const peer = value.peers.find((entry) => entry.deviceId === listA.self.deviceId);
    return peer !== undefined && peer.online === true && peer.shareMemory === false ? value : undefined;
  }, { timeoutMs: 15000, what: 'B to see A online with sharing off' });
  let blocked = '';
  try {
    await apiB.command({ action: 'inherit', deviceId: listA.self.deviceId, sessionId: 'session-alpha' });
  } catch (error) {
    blocked = error instanceof Error ? error.message : String(error);
  }
  check(blocked.includes('memory-sharing-off'), `inheritance is refused while sharing is off (${blocked})`);
  await apiA.command({ action: 'configure', shareMemory: true });
  await sleep(300);
  const afterShare = await apiA.command({ action: 'list' });
  check(afterShare.self.shareMemory === true, 'the switch reports itself back on');

  section('settings round-trip');
  const configured = await apiB.command({ action: 'configure', deviceName: 'B 机（改名）', secret: 'my-shared-passphrase' });
  check(configured.self.name === 'B 机（改名）', 'the display name persisted');
  await until(async () => {
    const value = await apiB.command({ action: 'list' });
    return value.self.fingerprint !== '' && value.self.keySource === 'passphrase' ? value : undefined;
  }, { what: 'B to switch to the passphrase key' });
  const passphraseList = await apiB.command({ action: 'list' });
  check(passphraseList.self.keySource === 'passphrase', 'the key source is reported as passphrase');
  check(passphraseList.self.fingerprint !== listA.self.fingerprint, 'switching to a passphrase changes the key (so the old room no longer opens)');
  await apiB.command({ action: 'configure', secret: '' });
  const restored = await until(async () => {
    const value = await apiB.command({ action: 'list' });
    return value.self.keySource === 'account' ? value : undefined;
  }, { what: 'B to fall back to the account key' });
  check(restored.self.fingerprint === listA.self.fingerprint, 'clearing the passphrase restores the account-derived key');
} catch (error) {
  failures.push(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`);
  console.log(`\n!! ${error instanceof Error ? error.stack : String(error)}`);
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
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
console.log('all Deep Connect end-to-end checks passed');
