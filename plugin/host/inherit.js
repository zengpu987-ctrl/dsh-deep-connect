/**
 * Deep Connect — inheriting a peer's conversation as a local Session.
 *
 * "接管" (take over) hands a message to the machine that owns a conversation.
 * "继承" (inherit) is the other half: copy the owning machine's raw event log into
 * a NEW local session, so this machine's model and tools continue the work from
 * the full history even when the peer is unreachable.
 *
 * The copy is a fork, never a move. The source session keeps running untouched
 * on the other machine, and the copy is an ordinary local session with its own
 * identity — that is the only way two append-only logs can both stay honest.
 *
 * Writing goes through `ctx.sessionPersistence`:
 *
 *   create(header) -> append(events) -> flush() -> close()
 *
 * which is the same primitive DSH's own session lifecycle uses. Nothing here
 * touches `session.vN.jsonl.zstd` directly.
 *
 * @module dsh-deep-connect/inherit
 */
import { randomUUID } from 'node:crypto';

/** A hard ceiling far above any real conversation, so a hostile peer cannot OOM the Host. */
const MAX_EVENTS = 200_000;
/** Field allow-list for one event, so an unknown payload shape cannot ride along. */
const EVENT_FIELDS = ['type', 'seq', 'time', 'data', 'ignorable', 'surfaceOp', 'sourceEventSeqs'];

/** Is this a plain JSON object (not an array, not null)? */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The current on-disk format version, read from a local session when possible. */
async function localFormatVersion(persistence) {
  try {
    const snapshots = await persistence.list({});
    for (const snapshot of snapshots) {
      const version = Number(snapshot?.header?.version ?? 0);
      if (Number.isInteger(version) && version > 0) return version;
    }
  } catch {
    /* fall through to the peer's version */
  }
  return undefined;
}

/** The directory a new local session should be anchored to. */
function defaultCwd(ctx) {
  const directory = ctx.get?.('workingDirectory')?.defaultDirectory;
  if (typeof directory === 'string' && directory.startsWith('/')) return directory;
  return undefined;
}

/**
 * Re-sequence one event for the copy.
 *
 * Sequence numbers must be contiguous from 0 and are the copy's own numbers, so
 * the old values are mapped onto the new order. `sourceEventSeqs` references old
 * sequence numbers, so it is remapped through the same table rather than copied.
 */
function normalizeEvent(event, index, seqMap) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const field of EVENT_FIELDS) {
    if (event[field] === undefined) continue;
    out[field] = event[field];
  }
  out.seq = index;
  out.time = Number.isFinite(Number(event.time)) ? Number(event.time) : Date.now();
  out.type = String(event.type ?? '');
  out.data = isRecord(event.data) ? event.data : {};
  if (Array.isArray(event.sourceEventSeqs)) {
    out.sourceEventSeqs = event.sourceEventSeqs
      .map((seq) => seqMap.get(Number(seq)))
      .filter((seq) => seq !== undefined);
    if (out.sourceEventSeqs.length === 0) delete out.sourceEventSeqs;
  }
  return out;
}

/**
 * Copy one peer session into a brand-new local session.
 *
 * @param {object} options
 * @param {object} options.persistence - `ctx.sessionPersistence`.
 * @param {object} options.ctx - the Host plugin context (for the default cwd).
 * @param {object} options.payload - the peer's `export` answer.
 * @param {Function} [options.log] - level/message logger.
 * @returns {Promise<{sessionId: string, eventCount: number, cwd?: string}>}
 */
export async function createInheritedSession({ persistence, ctx, payload, log = () => {} }) {
  if (persistence === undefined || typeof persistence.create !== 'function') {
    throw new Error('这个部署没有挂载可写的会话存储（sessionPersistence），无法在本机继承');
  }
  const source = Array.isArray(payload?.events) ? payload.events : [];
  if (source.length === 0) throw new Error('对端没有返回任何会话事件，无法继承');
  if (source.length > MAX_EVENTS) throw new Error(`这条会话有 ${source.length} 条事件，超过继承上限 ${MAX_EVENTS}`);

  const version = (await localFormatVersion(persistence)) ?? Number(payload?.header?.version ?? 0);
  if (!Number.isInteger(version) || version <= 0) throw new Error('无法确定本机的会话格式版本，拒绝写入');

  /** old seq -> new seq; a complete copy keeps the same order but not necessarily the same numbers. */
  const seqMap = new Map();
  for (const [index, event] of source.entries()) {
    const seq = Number(event?.seq);
    if (Number.isFinite(seq)) seqMap.set(seq, index);
  }

  const sessionId = `session-${randomUUID()}`;
  const cwd = defaultCwd(ctx);
  const header = {
    version,
    id: sessionId,
    createdAt: Date.now(),
    ...(cwd === undefined ? {} : { cwd }),
    isSeeded: false,
  };

  const handle = await persistence.create(header);
  try {
    const events = source.map((event, index) => normalizeEvent(event, index, seqMap));
    await handle.append(events);
    await handle.flush();
    log('info', `已继承会话 ${String(payload?.sessionId ?? '')} -> ${sessionId}（${events.length} 条事件）`);
    return { sessionId, eventCount: events.length, ...(cwd === undefined ? {} : { cwd }) };
  } catch (error) {
    // The created shell cannot be deleted through this API; say so plainly rather
    // than pretending the failed copy never happened.
    const message = error instanceof Error ? error.message : String(error);
    log('warn', `继承会话写入失败（${sessionId} 可能留下一个空会话）：${message}`);
    throw new Error(`写入本机会话失败：${message}`);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
