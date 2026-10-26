/**
 * Deep Connect — durable plugin state.
 *
 * Layout under `<root>` (default `~/.dsh/deep-connect`):
 *
 *   config.json                     relay URL, token, optional passphrase, toggles
 *   identity.json                   this machine's stable device id + display name
 *   peers.json                      the channel's roster, as last heard from the relay
 *   index/<deviceId>.json           each peer's advertised session index
 *   remote/<deviceId>/<sessionId>.json   conversation copies fetched from a peer
 *   outbox.json                     envelopes the relay has not accepted yet
 *
 * Every write is "write a sibling temp file, then rename over the target", so a
 * crash can never leave a half-written JSON document. That is the same contract
 * the Superman memory store uses in this workspace, and it is the reason reads
 * here never need a repair pass.
 *
 * The remote/ cache is deliberately NOT registered with the session store: an
 * imported conversation must never show up in the ordinary session list or be
 * resumable by accident. Reading a peer's history is a copy, and the copy lives
 * here.
 *
 * @module dsh-deep-connect/store
 */
import { access, mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Bumped when a stored document's shape changes in a way readers must notice. */
const DOC_VERSION = 1;
/** Cap on the offline outbox, so a long relay outage cannot grow without bound. */
const OUTBOX_LIMIT = 400;

/** Read one JSON file, answering `undefined` for absent or damaged content. */
async function readJson(path) {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Atomically replace one JSON file. */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(tmp, path);
}

/**
 * One device's session index, as advertised to peers. Kept minimal on purpose:
 * the index crosses an encrypted but still untrusted boundary, and every field
 * here is metadata a peer is entitled to see.
 */
export class DeepConnectStore {
  /**
   * @param {string} root - absolute state directory (the Loader passes `dshHomePath('deep-connect')`).
   * @param {object} [options] - `{ maxIndexSessions, log }`.
   */
  constructor(root, options = {}) {
    this.root = root;
    this.indexDir = join(root, 'index');
    this.remoteDir = join(root, 'remote');
    this.configPath = join(root, 'config.json');
    this.identityPath = join(root, 'identity.json');
    this.peersPath = join(root, 'peers.json');
    this.outboxPath = join(root, 'outbox.json');
    this.maxIndexSessions = Math.max(1, Number(options.maxIndexSessions ?? 300));
    this.defaultName = String(options.defaultName ?? '');
    this.log = options.log ?? (() => {});
    /** Serializes read-modify-write cycles so two flushes cannot interleave. */
    this.queue = Promise.resolve();
    this.loaded = false;
    this.config = {};
    this.identity = {};
    this.peers = [];
    this.outbox = [];
    /** deviceId -> index document, held in memory after the first load. */
    this.indices = new Map();
  }

  /** Run one mutation on the serialized chain. */
  #serial(operation) {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Load everything once; later calls are free. */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    this.config = (await readJson(this.configPath)) ?? {};
    this.identity = (await readJson(this.identityPath)) ?? {};
    this.peers = Array.isArray((await readJson(this.peersPath))?.peers) ? (await readJson(this.peersPath)).peers : [];
    this.outbox = Array.isArray((await readJson(this.outboxPath))?.items) ? (await readJson(this.outboxPath)).items : [];
    if (typeof this.identity.deviceId !== 'string' || this.identity.deviceId === '') {
      // The device id is the only identity the relay sees. It is random per
      // install, not derived from anything, and never changes afterwards.
      this.identity = {
        version: DOC_VERSION,
        deviceId: `dev-${randomUUID()}`,
        name: typeof this.identity.name === 'string' ? this.identity.name : '',
        createdAt: Date.now(),
      };
      await writeJson(this.identityPath, this.identity);
    }
    if (this.identity.name === '' && this.defaultName !== '') {
      this.identity = { ...this.identity, name: this.defaultName };
      await writeJson(this.identityPath, this.identity);
    }
  }

  /* ------------------------------- config ------------------------------- */

  /** Current configuration with defaults applied. */
  getConfig() {
    return {
      relayUrl: String(this.config.relayUrl ?? ''),
      token: String(this.config.token ?? ''),
      secret: String(this.config.secret ?? ''),
      deviceName: String(this.config.deviceName ?? this.identity.name ?? ''),
      autoConnect: this.config.autoConnect !== false,
      autoIndex: this.config.autoIndex !== false,
      indexIntervalMs: Math.max(5000, Number(this.config.indexIntervalMs ?? 15000)),
      historyLimitEvents: Math.max(200, Number(this.config.historyLimitEvents ?? 20000)),
    };
  }

  /** Persist a partial configuration change and answer the merged result. */
  async setConfig(patch) {
    return this.#serial(async () => {
      const next = { ...this.config };
      for (const key of ['relayUrl', 'token', 'secret', 'deviceName']) {
        if (patch[key] !== undefined) next[key] = String(patch[key]);
      }
      for (const key of ['autoConnect', 'autoIndex']) {
        if (patch[key] !== undefined) next[key] = patch[key] === true;
      }
      if (patch.indexIntervalMs !== undefined) {
        next.indexIntervalMs = Math.max(5000, Number(patch.indexIntervalMs) || 15000);
      }
      next.version = DOC_VERSION;
      this.config = next;
      if (patch.deviceName !== undefined) {
        this.identity = { ...this.identity, name: String(patch.deviceName) };
        await writeJson(this.identityPath, this.identity);
      }
      await writeJson(this.configPath, next);
      return this.getConfig();
    });
  }

  /**
   * This machine's stable identity.
   *
   * Safe to call before {@link load} has finished: every field is guaranteed
   * present, because callers compare and slice `deviceId` without checking, and
   * a missing field there turns a retryable "not ready yet" into a TypeError.
   * @returns {{deviceId: string, name: string, createdAt: number, ready: boolean}}
   */
  getIdentity() {
    return {
      deviceId: typeof this.identity.deviceId === 'string' ? this.identity.deviceId : 'dev-pending',
      name: typeof this.identity.name === 'string' ? this.identity.name : '',
      createdAt: Number(this.identity.createdAt ?? 0),
      ready: this.loaded === true && typeof this.identity.deviceId === 'string',
    };
  }

  /* -------------------------------- peers -------------------------------- */

  /** Replace the roster with what the relay just reported. */
  async setPeers(peers) {
    return this.#serial(async () => {
      this.peers = Array.isArray(peers) ? peers : [];
      await writeJson(this.peersPath, { version: DOC_VERSION, at: Date.now(), peers: this.peers });
    });
  }

  /** The roster as last known. */
  getPeers() {
    return this.peers;
  }

  /* -------------------------------- index -------------------------------- */

  /** Store one peer's advertised index. */
  async setRemoteIndex(deviceId, document) {
    return this.#serial(async () => {
      this.indices.set(deviceId, document);
      await writeJson(join(this.indexDir, `${encodeURIComponent(deviceId)}.json`), document);
    });
  }

  /** Read one peer's advertised index, from memory or disk. */
  async getRemoteIndex(deviceId) {
    const cached = this.indices.get(deviceId);
    if (cached !== undefined) return cached;
    const loaded = await readJson(join(this.indexDir, `${encodeURIComponent(deviceId)}.json`));
    if (loaded !== undefined) this.indices.set(deviceId, loaded);
    return loaded;
  }

  /** Every peer index currently known, newest first. */
  async listRemoteIndices() {
    await this.load();
    const out = [];
    for (const peer of this.peers) {
      const document = await this.getRemoteIndex(peer.deviceId);
      if (document !== undefined) out.push(document);
    }
    return out;
  }

  /* ------------------------------- history ------------------------------- */

  /** Where one peer's copy of one conversation lives. */
  #historyPath(deviceId, sessionId) {
    return join(this.remoteDir, encodeURIComponent(deviceId), `${encodeURIComponent(sessionId)}.json`);
  }

  /** Persist a fetched conversation copy. */
  async putHistory(deviceId, sessionId, document) {
    return this.#serial(async () => {
      await writeJson(this.#historyPath(deviceId, sessionId), document);
    });
  }

  /** Read a stored conversation copy, or `undefined` when never fetched. */
  async getHistory(deviceId, sessionId) {
    return readJson(this.#historyPath(deviceId, sessionId));
  }

  /** Whether a copy exists, without reading the (possibly large) body. */
  async hasHistory(deviceId, sessionId) {
    try {
      await access(this.#historyPath(deviceId, sessionId));
      return true;
    } catch {
      return false;
    }
  }

  /** Forget every copy of one peer's conversations (used when a peer is removed). */
  async dropPeerHistory(deviceId) {
    return this.#serial(async () => {
      await rm(join(this.remoteDir, encodeURIComponent(deviceId)), { recursive: true, force: true });
      this.indices.delete(deviceId);
      await rm(join(this.indexDir, `${encodeURIComponent(deviceId)}.json`), { force: true });
    });
  }

  /* -------------------------------- outbox -------------------------------- */

  /** Queue an envelope the relay has not accepted. */
  async queueOutbox(envelope) {
    return this.#serial(async () => {
      this.outbox.push({ ...envelope, queuedAt: Date.now() });
      while (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
      await writeJson(this.outboxPath, { version: DOC_VERSION, items: this.outbox });
    });
  }

  /** Drain the outbox, oldest first. */
  async takeOutbox() {
    return this.#serial(async () => {
      const items = this.outbox;
      this.outbox = [];
      if (items.length > 0) await writeJson(this.outboxPath, { version: DOC_VERSION, items: [] });
      return items;
    });
  }

  /** How many envelopes are waiting for the relay. */
  outboxSize() {
    return this.outbox.length;
  }

  /** Keep the index bounded, newest activity first. */
  capIndex(entries) {
    return [...entries].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, this.maxIndexSessions);
  }
}
