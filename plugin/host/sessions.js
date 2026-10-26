/**
 * Deep Connect — reading the local conversation corpus.
 *
 * Everything here goes through `ctx.sessionQuery` when it exists, because that
 * service already solves the hard parts: it is "live-preferred" (a session that
 * is open right now reads from memory, a closed one from disk), it handles the
 * versioned per-session JSONL generation on disk, and it folds compaction
 * replacements so a transcript reads in model-history order rather than in raw
 * append order.
 *
 * When `ctx.sessionQuery` is absent we fall back to `ctx.sessionPersistence`,
 * which is the guaranteed primitive. The fallback loses the surface fold (a
 * compacted session shows its pre-compaction turns too) and is slower, so it is
 * a degraded mode, not an equal one. This plugin never touches
 * `session.vN.jsonl.zstd` directly: that file is a concatenation of independent
 * zstd frames with per-frame checksums and torn-tail recovery, and re-deriving
 * it here would silently diverge from the real reader.
 *
 * @module dsh-deep-connect/sessions
 */

/** Longest preview text kept per user prompt in the index. */
const PREVIEW_CHARS = 220;
/** User prompts kept per session in the index (first two, plus the most recent). */
const PREVIEW_PROMPTS = 3;
/** Characters of a tool result kept in a transcript turn. */
const TOOL_RESULT_CHARS = 4000;
/** Characters of one assistant/user turn kept in a transcript. */
const TURN_CHARS = 200_000;

/** Flatten one message content value into plain text. */
export function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue;
      if (typeof block.text === 'string') parts.push(block.text);
      else if (block.type === 'tool-call') parts.push(`[tool ${block.name ?? '?'}] ${String(block.arguments ?? '')}`);
      else if (typeof block.ref === 'string') parts.push(`[image ${block.ref}]`);
    }
    return parts.join('\n');
  }
  if (content === null || content === undefined) return '';
  return String(content);
}

/** Truncate to a character budget, marking the cut honestly. */
function clip(text, limit) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（已截断 ${value.length - limit} 字）`;
}

/**
 * Derive the task board for one session from its event stream.
 *
 * Each of the three task kinds is a whole-value snapshot event, so the fold is
 * last-write-wins per key — which is exactly why this is cheap:
 *   - `todo/write` carries the complete todo list every time.
 *   - `goal/change` carries the complete goal or a clear tombstone.
 *   - `team/task` is keyed by task id in the agent-team runtime.
 *
 * @param {readonly object[]} events - canonical session events for one session.
 * @returns {{open: number, done: number, goal?: string, goalStatus?: string, team: number, teamDone: number}}
 */
export function foldTasks(events) {
  let todos = null;
  let goal;
  let goalStatus;
  const teamTasks = new Map();
  for (const event of events) {
    const data = event?.data;
    if (data === null || typeof data !== 'object') continue;
    switch (event.type) {
      case 'todo/write':
        if (Array.isArray(data.todos)) todos = data.todos;
        break;
      case 'goal/change':
        if (data.operation === 'clear') {
          goal = undefined;
          goalStatus = undefined;
        } else if (data.goal !== null && typeof data.goal === 'object') {
          goal = typeof data.goal.objective === 'string' ? data.goal.objective : goal;
          goalStatus = typeof data.goal.status === 'string' ? data.goal.status : goalStatus;
        }
        break;
      case 'team/task': {
        const task = data.task;
        const id = task?.id ?? task?.taskId;
        if (typeof id === 'string') teamTasks.set(id, task);
        break;
      }
      default:
        break;
    }
  }
  const open = Array.isArray(todos) ? todos.filter((t) => t?.status !== 'completed').length : 0;
  const done = Array.isArray(todos) ? todos.filter((t) => t?.status === 'completed').length : 0;
  let teamDone = 0;
  for (const task of teamTasks.values()) {
    if (task?.status === 'completed' || task?.state === 'completed' || task?.state === 'done') teamDone += 1;
  }
  const result = { open, done, team: teamTasks.size, teamDone };
  if (goal !== undefined) {
    result.goal = clip(goal, 140);
    if (goalStatus !== undefined) result.goalStatus = goalStatus;
  }
  return result;
}

/**
 * Pick the user prompts worth showing in an index row: the first two and the
 * last one. The middle of a long conversation is never a useful preview, and
 * the index has to stay small because it is broadcast on every change.
 * @param {readonly object[]} events - canonical session events.
 * @returns {string[]} at most three clipped prompts.
 */
export function userPromptsOf(events) {
  const prompts = [];
  for (const event of events) {
    if (event?.type !== 'user/message') continue;
    const text = contentToText(event.data?.content).replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    prompts.push(clip(text, PREVIEW_CHARS));
  }
  if (prompts.length <= PREVIEW_PROMPTS) return prompts;
  return [prompts[0], prompts[1], prompts[prompts.length - 1]];
}

/**
 * Fold the events that matter into a transcript a human can read.
 *
 * Only surface events become turns. `tool/call` events are dropped on purpose:
 * a read-only reader wants "what was asked, what was answered, what ran", and
 * the tool call's name/arguments are already embedded in the assistant message
 * that requested it.
 *
 * @param {readonly object[]} events - canonical session events.
 * @returns {Array<{seq: number, role: string, time: number, text: string, toolName?: string, isError?: boolean}>}
 */
export function buildTranscript(events) {
  const turns = [];
  for (const event of events) {
    const data = event?.data;
    if (data === null || typeof data !== 'object') continue;
    const base = { seq: Number(event.seq ?? 0), time: Number(event.time ?? 0) };
    switch (event.type) {
      case 'user/message': {
        const text = contentToText(data.content);
        if (text.trim() !== '') turns.push({ ...base, role: 'user', text: clip(text, TURN_CHARS) });
        break;
      }
      case 'assistant/message': {
        const text = contentToText(data.message?.content);
        if (text.trim() !== '') turns.push({ ...base, role: 'assistant', text: clip(text, TURN_CHARS) });
        break;
      }
      case 'tool/result': {
        const message = data.message ?? {};
        const text = contentToText(message.content);
        const turn = { ...base, role: 'tool', text: clip(text, TOOL_RESULT_CHARS) };
        if (typeof data.meta?.toolName === 'string') turn.toolName = data.meta.toolName;
        else if (typeof message.name === 'string') turn.toolName = message.name;
        const failed = message.isError === true || data.error !== undefined;
        if (failed) turn.isError = true;
        turns.push(turn);
        break;
      }
      case 'system/message': {
        const text = contentToText(data.message?.content);
        if (text.trim() !== '') turns.push({ ...base, role: 'system', text: clip(text, 20_000) });
        break;
      }
      case 'developer/message': {
        const text = contentToText(data.message?.content);
        if (text.trim() !== '') turns.push({ ...base, role: 'developer', text: clip(text, 20_000) });
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

/** Fold the latest `session/title` event out of a raw event stream. */
export function titleFromEvents(events) {
  let title = '';
  for (const event of events) {
    if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title;
  }
  return title;
}

/**
 * Wraps whichever session services this deployment composed, behind one small
 * surface: list stored sessions, read one session's events, read its title.
 */
export class SessionAdapter {
  /**
   * @param {object} ctx - the Host plugin context.
   * @param {object} [options] - `{ historyLimitEvents, log }`.
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.historyLimitEvents = Math.max(200, Number(options.historyLimitEvents ?? 20_000));
    this.log = options.log ?? (() => {});
    this.query = ctx.get?.('sessionQuery');
    this.persistence = ctx.get?.('sessionPersistence');
    /** `id -> revision key`, so the index only re-reads sessions that changed. */
    this.revisionCache = new Map();
    /** `id -> { title, updatedAt, eventCount, userPrompts, tasks }`, the expensive part. */
    this.summaryCache = new Map();
  }

  /** Whether the rich reader is available; the fallback is a degraded mode. */
  get degraded() {
    return this.query === undefined;
  }

  /** Whether this deployment composed any session storage at all. */
  get available() {
    return this.query !== undefined || this.persistence !== undefined;
  }

  /**
   * List every stored session as `{ id, cwd, createdAt, isSeeded, live, eventCount }`.
   * @param {AbortSignal} [signal] - caller cancellation.
   */
  async list(signal) {
    if (this.query !== undefined) {
      const records = await this.query.listSessions(signal);
      return records.map((record) => ({
        id: String(record.header?.id ?? ''),
        cwd: typeof record.header?.cwd === 'string' ? record.header.cwd : undefined,
        createdAt: Number(record.header?.createdAt ?? 0),
        isSeeded: record.header?.isSeeded === true,
        live: record.live === true,
        eventCount: undefined,
      })).filter((row) => row.id !== '');
    }
    if (this.persistence !== undefined) {
      const snapshots = await this.persistence.list({ signal });
      return snapshots.map((snapshot) => ({
        id: String(snapshot.header?.id ?? ''),
        cwd: typeof snapshot.header?.cwd === 'string' ? snapshot.header.cwd : undefined,
        createdAt: Number(snapshot.header?.createdAt ?? 0),
        isSeeded: snapshot.header?.isSeeded === true,
        live: false,
        eventCount: snapshot.eventCount,
      })).filter((row) => row.id !== '');
    }
    return [];
  }

  /**
   * Read one session's complete validated event log.
   * @param {string} sessionId - the session to read.
   * @param {AbortSignal} [signal] - caller cancellation.
   * @returns {Promise<{events: object[], inheritedEventCount: number, title: string} | undefined>}
   */
  async readEvents(sessionId, signal) {
    if (this.query !== undefined) {
      try {
        const snapshot = await this.query.readSession(sessionId);
        const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
        // The reader has been observed with the header under all three of these
        // shapes; take whichever this deployment actually returns.
        const header =
          snapshot?.header ??
          snapshot?.session?.header ??
          (typeof snapshot?.session?.version === 'number' ? snapshot.session : undefined);
        return {
          events,
          header,
          inheritedEventCount: Number(snapshot?.inheritedEventCount ?? 0),
          title: titleFromEvents(events),
        };
      } catch (error) {
        this.log('warn', `readSession(${sessionId}) failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    }
    if (this.persistence !== undefined) {
      let handle;
      try {
        handle = await this.persistence.open(sessionId, 'read', { signal });
        const result = await handle.read(0, undefined, { signal });
        const events = Array.isArray(result?.events) ? [...result.events] : [];
        return {
          events,
          header: handle.header,
          inheritedEventCount: Number(handle.inheritedEventCount ?? 0),
          title: titleFromEvents(events),
        };
      } catch (error) {
        this.log('warn', `open(${sessionId}) failed: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      } finally {
        if (handle !== undefined) await handle.close().catch(() => undefined);
      }
    }
    return undefined;
  }

  /**
   * Read just one session's title, preferring the cheap query path.
   * @param {string} sessionId - the session to title.
   * @param {AbortSignal} [signal] - caller cancellation.
   */
  async readTitle(sessionId, signal) {
    if (this.query !== undefined) {
      try {
        const observation = await this.query.readTitleSnapshot(sessionId, signal);
        if (typeof observation?.title?.title === 'string' && observation.title.title !== '') return observation.title.title;
      } catch {
        /* fall through to the event fold */
      }
    }
    const read = await this.readEvents(sessionId, signal);
    return read?.title ?? '';
  }

  /**
   * A cheap change token for one session. Reading events is expensive, so the
   * index uses this to decide whether a session needs re-reading at all.
   * @param {string} sessionId - the session to fingerprint.
   */
  async revisionOf(sessionId) {
    if (this.persistence === undefined) return undefined;
    try {
      const snapshot = await this.persistence.stat(sessionId);
      if (snapshot === undefined) return undefined;
      const revision = snapshot.revision;
      return typeof revision === 'object' && revision !== null ? JSON.stringify(revision) : String(revision);
    } catch {
      return undefined;
    }
  }

  /**
   * Build index entries for every stored session, re-reading only what changed.
   *
   * The caches are the point: a stable corpus costs one `list()` plus one
   * `stat()` per session, and a conversation that just grew re-reads exactly
   * that conversation.
   *
   * @param {object} options - `{ signal, limit }`.
   * @returns {Promise<object[]>} index rows, newest activity first.
   */
  async buildIndex({ signal, limit } = {}) {
    const rows = await this.list(signal);
    const cap = Math.max(1, Number(limit ?? 300));
    /** Metadata-only rows are cheap; sort and cap before the expensive reads. */
    const ordered = [...rows].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)).slice(0, cap);
    const live = new Set(this.ctx.get?.('sessions')?.list?.().map((session) => session.id) ?? []);
    const entries = [];
    for (const row of ordered) {
      if (signal?.aborted) break;
      const revision = await this.revisionOf(row.id);
      const cached = this.summaryCache.get(row.id);
      // A session with no revision token (the query-only path) is always
      // re-read: correctness beats the cache when the backend cannot tell us
      // whether anything changed.
      const fresh = cached !== undefined && revision !== undefined && cached.revision === revision;
      let summary = cached;
      if (!fresh) {
        const read = await this.readEvents(row.id, signal);
        if (read === undefined) continue;
        summary = {
          revision,
          title: read.title,
          eventCount: read.events.length,
          updatedAt: latestTime(read.events, row.createdAt),
          userPrompts: userPromptsOf(read.events),
          tasks: foldTasks(read.events),
        };
        this.summaryCache.set(row.id, summary);
      }
      // A live session is one this process currently has open, which is the
      // honest signal for "someone is working in it right now".
      const isLive = row.live || live.has(row.id);
      entries.push({
        ownerId: '',
        sessionId: row.id,
        title: summary.title !== '' ? summary.title : fallbackTitle(summary.userPrompts, row.id),
        cwd: row.cwd,
        createdAt: row.createdAt,
        updatedAt: summary.updatedAt,
        eventCount: summary.eventCount,
        userPrompts: summary.userPrompts,
        tasks: summary.tasks,
        live: isLive,
        isRemote: false,
      });
    }
    for (const id of [...this.summaryCache.keys()]) {
      if (!rows.some((row) => row.id === id)) this.summaryCache.delete(id);
    }
    return entries.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /**
   * Compose the read-only transcript document handed to the browser.
   * @param {string} sessionId - the session to export.
   * @param {AbortSignal} [signal] - caller cancellation.
   */
  async exportTranscript(sessionId, signal) {
    const read = await this.readEvents(sessionId, signal);
    if (read === undefined) return undefined;
    const events = read.events.slice(0, this.historyLimitEvents);
    return {
      sessionId,
      title: read.title,
      eventCount: read.events.length,
      truncated: read.events.length > events.length,
      tasks: foldTasks(read.events),
      updatedAt: latestTime(read.events, 0),
      transcript: buildTranscript(events),
    };
  }
}

/** Newest event time in a log, or the fallback when the log is empty. */
function latestTime(events, fallback) {
  let newest = Number(fallback ?? 0);
  for (const event of events) {
    const time = Number(event?.time ?? 0);
    if (time > newest) newest = time;
  }
  return newest;
}

/** A title is never empty in the UI; fall back to the first prompt, then the id. */
function fallbackTitle(userPrompts, sessionId) {
  if (Array.isArray(userPrompts) && userPrompts.length > 0 && userPrompts[0].trim() !== '') return clip(userPrompts[0], 60);
  return sessionId;
}
