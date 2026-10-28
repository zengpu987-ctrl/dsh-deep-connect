/**
 * Offline check for the browser half.
 *
 * Stubs `window.__ModuleLoader__`, evaluates `plugin/client.js` as TEXT (so the
 * file is exercised exactly as the host serves it, not as a module import), calls
 * the captured factory with a cursor-based React stub exposing only the Hooks the
 * offline harness really has, applies the result to a fake `ctx`, then renders
 * the panel against canned Host payloads and asserts what comes out.
 *
 * This is the only way to check the browser half without a browser, and it has
 * caught real bugs: a panel that destructured `actions` it never received, and a
 * sidebar icon whose SVG helper dropped its children.
 *
 * Usage: node tools/client-check.mjs
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const CLIENT = process.argv[2] ?? resolve(import.meta.dirname, '../plugin/client.js');
const results = [];
let failed = 0;
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) });
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `   <<< ${String(detail).slice(0, 300)}`}\n`);
};
const crash = (where, error) => {
  process.stdout.write(`CRASH at ${where}: ${error?.message}\n${error?.stack?.split('\n').slice(0, 6).join('\n')}\n`);
};

/* ---------------------------------------------------------------- React stub */
const tag = (fn, label) => {
  if (typeof fn === 'function') fn.__dcComponent = label ?? fn.name ?? 'anon';
  return fn;
};

function makeReact() {
  const React = {
    Fragment: Symbol.for('react.fragment'),
    createElement(type, props, ...children) {
      // React stores a single array child as the child list; the renderer
      // re-creates host elements that way, so the stub must do it too.
      // React: one argument is the child (an array argument is the child LIST);
      // several arguments are the children array as given.
      const flat = children.length === 1 && Array.isArray(children[0])
        ? children[0]
        : children.length === 1 ? children[0] : children;
      return { type, props: { ...(props ?? {}), children: flat }, key: props?.key ?? null };
    },
    useState(initial) {
      const cursor = React.__cursor.current;
      if (cursor === null) throw new Error('useState outside a component');
      const slot = cursor.hooks[cursor.index] ?? { value: typeof initial === 'function' ? initial() : initial };
      cursor.hooks[cursor.index] = slot;
      cursor.index += 1;
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        cursor.schedule();
      }];
    },
    useRef(initial) {
      const cursor = React.__cursor.current;
      if (cursor === null) throw new Error('useRef outside a component');
      const slot = cursor.hooks[cursor.index] ?? { value: { current: initial } };
      cursor.hooks[cursor.index] = slot;
      cursor.index += 1;
      return slot.value;
    },
    useEffect(create) {
      const cursor = React.__cursor.current;
      if (cursor === null) throw new Error('useEffect outside a component');
      const index = cursor.index;
      cursor.index += 1;
      // A fresh inline closure has no dep list here (the stub cannot see one),
      // so every pass re-runs the effect; the panel's effects are idempotent.
      cursor.hooks[index] = { create, run: true };
      cursor.pending.push(index);
    },
    memo(component) {
      return tag(function DCMemo(props) {
        return React.createElement(component, props);
      }, `memo(${component?.__dcComponent ?? 'component'})`);
    },
    __cursor: { current: null },
  };
  return React;
}

/* ---------------------------------------------------------------- renderer */
function createRenderer(React) {
  let parts = [];
  let scheduled = false;
  const effectErrors = [];
  /** Hook slots live for the whole renderer lifetime, the way React keeps them. */
  const slots = new Map();

  function cursorFor(type) {
    if (!slots.has(type)) {
      if (type.__dcComponent === undefined) throw new Error(`untagged component ${type.name}`);
      slots.set(type, { index: 0, hooks: [], pending: [], schedule });
    }
    return slots.get(type);
  }

  function renderPass() {
    const walk = (node) => {
      if (node === null || node === undefined || typeof node === 'boolean') return null;
      if (typeof node === 'string' || typeof node === 'number') return node;
      if (Array.isArray(node)) return node.map(walk);
      const type = node.type;
      if (type === React.Fragment) return walk(node.props?.children);
      if (typeof type === 'function') {
        const cursor = cursorFor(type);
        cursor.index = 0;
        React.__cursor.current = cursor;
        try {
          return walk(type(node.props ?? {}));
        } finally {
          React.__cursor.current = null;
        }
      }
      return { type, props: { ...node.props, children: walk(node.props?.children) }, key: node.key ?? null };
    };
    const tree = walk(parts[0]);
    // Effects run after the pass, the way React flushes them after commit.
    const pending = [];
    for (const cursor of slots.values()) {
      for (const index of cursor.pending) pending.push(cursor.hooks[index]);
      cursor.pending = [];
    }
    for (const slot of pending) {
      try {
        slot.create();
      } catch (error) {
        effectErrors.push(error);
      }
    }
    return tree;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      renderPass();
    });
  }

  return {
    setParts(next) {
      parts = Array.isArray(next) ? next : [next];
    },
    render: renderPass,
    effectErrors: () => effectErrors,
  };
}

const textOf = (node) => {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
};

const VOID_TAGS = new Set(['input', 'textarea', 'img', 'br', 'hr']);
function serialize(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(serialize).join('');
  const type = node.type;
  if (typeof type === 'function') throw new Error(`serialize: un-rendered ${type.__dcComponent ?? type.name}`);
  const props = node.props ?? {};
  const attrs = Object.entries(props)
    .filter(([key, value]) => key !== 'children' && value !== undefined && value !== null && value !== false)
    .map(([key, value]) => ` ${key}="${String(value).replace(/"/g, '&quot;')}"`)
    .join('');
  if (VOID_TAGS.has(type)) return `<${type}${attrs}>`;
  return `<${type}${attrs}>${serialize(props.children)}</${type}>`;
}

function find(node, predicate) {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate);
      if (hit) return hit;
    }
    return null;
  }
  if (predicate(node)) return node;
  return find(node.props?.children, predicate);
}

const settle = async (rounds = 8) => {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/* ---------------------------------------------------------------- fake Host */
const SELF = {
  deviceId: 'dev-aaaa1111', name: 'MacBook Pro',
  fingerprint: '9f2c41d7a8b34e05c6d1f0a2b3c4d5e6f70819a2b3c4d5e6f708192a3b4c5d6',
  channelShort: '1a2b3c4d', relayUrl: 'wss://relay.example.com', connected: true, mode: 'account', shareMemory: true,
};
const PEER = {
  deviceId: 'dev-bbbb2222', name: 'Studio Mac', online: true, lastSeen: Date.now() - 120000,
  fingerprint: 'aa11bb22cc33dd44ee55ff6600112233445566778899aabbccddeeff00112233', sessionCount: 1, platform: 'darwin',
};
const OFFLINE_PEER = {
  deviceId: 'dev-cccc3333', name: 'Work Laptop', online: false, lastSeen: Date.now() - 3 * 86400000,
  fingerprint: '1122334455667788990011223344556677889900aabbccddeeff001122334455', sessionCount: 1,
};
const LOCAL_SESSION = {
  ownerId: SELF.deviceId, ownerName: SELF.name, sessionId: 'session-local-1',
  title: '本机会话：重构 Deep Connect 面板', cwd: '/Users/zp/Documents/deepseek-harness/default-workspace',
  createdAt: Date.now() - 600000, updatedAt: Date.now() - 30000, eventCount: 42,
  userPrompts: ['先写设计', '把面板写出来'], tasks: { open: 2, done: 1, goal: '交付 client.js', team: 0, items: [{ kind: 'todo', text: '把面板写出来', status: 'open' }, { kind: 'goal', text: '交付 client.js', status: 'open' }] },
  live: true, isRemote: false, sizeBytes: 240000,
};
const REMOTE_SESSION = {
  ownerId: PEER.deviceId, ownerName: PEER.name, sessionId: 'session-remote-9',
  title: 'Remote conversation about tetraquarks', cwd: '/Users/zp/work/physics',
  createdAt: Date.now() - 3600000, updatedAt: Date.now() - 300000, eventCount: 128,
  userPrompts: ['看看这条', '继续'], tasks: { open: 0, done: 3, team: 2, items: [{ kind: 'team', text: 'B 机上的团队任务', status: 'done' }] }, live: false, isRemote: true, sizeBytes: 1400000,
};
const OFFLINE_SESSION = {
  ownerId: OFFLINE_PEER.deviceId, ownerName: OFFLINE_PEER.name, sessionId: 'session-offline-3',
  title: '离线机器的会话', updatedAt: Date.now() - 86400000, eventCount: 7,
  userPrompts: ['晚安'], tasks: { open: 0, done: 0, team: 0 }, live: false, isRemote: true,
};
const LIST_VALUE = { self: SELF, peers: [PEER, OFFLINE_PEER], sessions: [LOCAL_SESSION, REMOTE_SESSION, OFFLINE_SESSION], stats: { local: 1, remote: 2, peers: 2 }, version: '4.0.3', minVersion: '4.0.2' };
const HISTORY_VALUE = {
  sessionId: REMOTE_SESSION.sessionId, deviceId: PEER.deviceId, title: REMOTE_SESSION.title,
  transcript: [
    { seq: 1, role: 'user', time: Date.now() - 300000, text: 'Hello from the other machine' },
    { seq: 2, role: 'assistant', time: Date.now() - 290000, text: 'Reading the event log now.' },
    { seq: 3, role: 'tool', time: Date.now() - 280000, toolName: 'Read', text: 'file contents' },
    { seq: 5, role: 'call', kind: 'trajectory', time: Date.now() - 260000, toolName: 'Bash', text: '{"command":"ls"}' },
    { seq: 4, role: 'tool', time: Date.now() - 270000, toolName: 'Bash', text: 'exit code 1', isError: true },
  ],
  eventCount: 128, fetchedAt: Date.now(), fromCache: false,
};

const CATALOG_VALUE = {
  default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
  routableProviders: ['deepseek-official'],
  groups: [{
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'Flash' },
      { id: 'deepseek-pro', name: 'Pro', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'max', name: 'Max' }], defaultEffort: 'high' } },
    ],
  }],
  failures: [],
};

/** A peer that advertises its Workspaces and current model, as 4.0.5 does. */
const LIST_WITH_WORKSPACES = {
  ...LIST_VALUE,
  peers: LIST_VALUE.peers.map((peer) => (peer.deviceId === PEER.deviceId
    ? {
      ...peer,
      workspaces: [{ id: 'ws-alpha', path: '/Users/zp/work/alpha', title: 'alpha 工作区' }],
      defaultWorkspacePath: '/Users/zp/work/alpha',
      model: { provider: 'deepseek-official', model: 'deepseek-flash' },
    }
    : peer)),
};

function makeFetch(options = {}) {
  const calls = [];
  const stub = async (url, init = {}) => {
    const body = JSON.parse(init.body ?? '{}');
    calls.push(body);
    if (options.networkFail === true) throw new TypeError('network down');
    if (options.errorReply === true) return { ok: true, json: async () => ({ ok: false, error: options.errorReply === true ? { code: 'relay_down', message: '中继不可达' } : options.errorReply }) };
    const value = (payload) => ({ ok: true, json: async () => ({ ok: true, value: payload }) });
    if (body.action === 'list') return value(options.listValue ?? LIST_VALUE);
    if (body.action === 'history') return value(HISTORY_VALUE);
    if (body.action === 'prompt') return value({ accepted: true, deliveredTo: body.deviceId, mode: body.mode === 'steer' ? 'steer' : 'queue' });
    if (body.action === 'inherit') return value({ sessionId: 'session-inherited-1', eventCount: 12, ran: body.run !== false, task: '原任务', runError: '' });
    if (body.action === 'task-run') return value({ accepted: true, sessionId: 'session-new-1', workspaceId: body.workspaceId ?? '', model: body.model ?? null });
    if (body.action === 'model-catalog') return value(options.catalog ?? CATALOG_VALUE);
    if (body.action === 'configure') return value(options.listValue ?? LIST_VALUE);
    if (body.action === 'reconnect') return value({ ok: true });
    return { ok: true, json: async () => ({ ok: false, error: { code: 'bad_action', message: `unknown action ${body.action}` } }) };
  };
  stub.calls = calls;
  return stub;
}

/* ---------------------------------------------------------------- 1. load */
let captured = null;
// The DOM stub carries the members a real page has that this plugin actually
// touches: the two global listener registrations, and a `body` to append to.
// A thinner stub hides real failures (it once reported a passive listener as a
// TypeError), which is the opposite of what a harness is for.
globalThis.window = {
  __ModuleLoader__: { load: (module) => { captured = module; } },
  setInterval: () => 1, clearInterval: () => undefined,
  setTimeout: globalThis.setTimeout.bind(globalThis), clearTimeout: globalThis.clearTimeout.bind(globalThis),
  addEventListener: () => undefined, removeEventListener: () => undefined,
};
const appendedNodes = [];
globalThis.document = {
  visibilityState: 'visible',
  head: { appendChild: (node) => appendedNodes.push(node) },
  body: { appendChild: (node) => appendedNodes.push(node) },
  querySelector: () => null,
  createElement: (tag) => ({ tagName: tag, dataset: {}, style: {}, textContent: '', setAttribute: () => undefined, remove: () => undefined, appendChild: () => undefined }),
  addEventListener: () => undefined, removeEventListener: () => undefined,
};
const source = readFileSync(CLIENT, 'utf8');
(0, eval)(source);
check('file calls window.__ModuleLoader__.load', captured !== null);
check('module id is @local/dsh-deep-connect', captured?.id === '@local/dsh-deep-connect', captured?.id);
check('factory is a function', typeof captured?.factory === 'function');

/* ---------------------------------------------------------------- 2. factory */
const React = makeReact();
const requireStub = (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${name})`);
};
const plugin = captured.factory(requireStub);
check('plugin has apply + inject', typeof plugin?.apply === 'function' && Array.isArray(plugin?.inject));
check('inject is exactly [slots, locale]', JSON.stringify(plugin.inject) === JSON.stringify(['slots', 'locale']), JSON.stringify(plugin.inject));
check('PKG / NS / PANEL_ID match the package', plugin.PKG === '@local/dsh-deep-connect' && plugin.NS === 'deep-connect' && plugin.PANEL_ID === 'deep-connect', `${plugin.PKG} ${plugin.NS} ${plugin.PANEL_ID}`);
const internal = plugin.internal ?? {};
const WANTED = ['Panel', 'PanelBody', 'PanelIcon', 'StatusPill', 'Fact', 'Field', 'Toggle', 'SettingsSection', 'DeviceCard', 'SessionRow', 'Turn', 'ReaderView'];
for (const name of WANTED) tag(internal[name], name);
check('internal exposes every component', WANTED.every((name) => typeof internal[name] === 'function'), WANTED.filter((n) => typeof internal[n] !== 'function').join(','));
check('internal exposes css / zh / en / formatRelativeTime / foldState', typeof internal.css === 'string' && typeof internal.zh === 'object' && typeof internal.en === 'object' && typeof internal.formatRelativeTime === 'function' && typeof internal.foldState === 'function');
check('createStore is the foldState factory', internal.createStore === internal.foldState);

/* ---------------------------------------------------------------- 3. apply */
const ctxCalls = { slots: [], effects: [] };
const ctx = {
  locale: { bind: () => (key) => internal.zh[key] ?? key, register: (ns, dictionaries) => { ctxCalls.locale = { ns, dictionaries }; return () => undefined; } },
  effect: (callback, label) => { ctxCalls.effects.push(label); const disposer = callback(); return typeof disposer === 'function' ? disposer : () => undefined; },
  slots: {
    inject: (name, callback) => { ctxCalls.slots.push({ kind: 'inject', name }); return callback(); },
    register: (options, component) => { ctxCalls.slots.push({ kind: 'register', name: options?.name, id: options?.id, key: options?.key, component }); return () => undefined; },
  },
  get: () => undefined,
};
let applyThrew = null;
try {
  plugin.apply(ctx);
} catch (error) {
  applyThrew = error;
}
check('apply(ctx) does not throw', applyThrew === null, applyThrew?.stack ?? '');
check('dictionaries registered under deep-connect', ctxCalls.locale?.ns === 'deep-connect', ctxCalls.locale?.ns);
check('zh and en have the same, non-trivial key set', (() => {
  const zhKeys = Object.keys(internal.zh).sort();
  const enKeys = Object.keys(internal.en).sort();
  return zhKeys.length > 40 && JSON.stringify(zhKeys) === JSON.stringify(enKeys);
})(), `${Object.keys(internal.zh).length}/${Object.keys(internal.en).length}`);
const registrations = ctxCalls.slots.filter((call) => call.kind === 'register');
const mainAt = registrations.findIndex((call) => call.name === 'main');
const sidebarAt = registrations.findIndex((call) => call.name === 'sidebar.panellist');
check('main registered BEFORE the sidebar row', mainAt !== -1 && sidebarAt !== -1 && mainAt < sidebarAt, `main@${mainAt} sidebar@${sidebarAt}`);
check('main key is deep-connect', registrations[mainAt]?.key === 'deep-connect');
check('sidebar id is deep-connect and uses PanelIcon', registrations[sidebarAt]?.id === 'deep-connect' && registrations[sidebarAt]?.component === internal.PanelIcon);
check('style tag effect is registered', ctxCalls.effects.includes('deep-connect: styles'), JSON.stringify(ctxCalls.effects));
check('every CSS class uses the dc_ prefix', (() => {
  const names = internal.css.match(/\.[a-zA-Z][\w-]*/g) ?? [];
  return names.filter((name) => !name.startsWith('.dc_')).length === 0;
})(), JSON.stringify((internal.css.match(/\.[a-zA-Z][\w-]*/g) ?? []).filter((n) => !n.startsWith('.dc_')).slice(0, 6)));
check('CSS has no hard-coded colors', !/(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\()/.test(internal.css), (internal.css.match(/#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\(/g) ?? []).slice(0, 4).join(','));

/* ---------------------------------------------------------------- 4. render */
async function renderPanel(fetchStub) {
  globalThis.fetch = fetchStub;
  const connector = internal.createConnector((key) => internal.zh[key] ?? key);
  const renderer = createRenderer(React);
  const props = { t: (key) => internal.zh[key] ?? key, store: connector.store, actions: connector.actions };
  // Render the BODY, not `Panel`: Panel now catches and renders the error, so
  // going through it would hide exactly the throw this harness exists to find.
  renderer.setParts(React.createElement(internal.PanelBody, props));
  renderer.render();
  await settle();
  const tree = renderer.render();
  return { connector, renderer, tree, html: serialize(tree), props };
}

const first = await renderPanel(makeFetch());
check('renders this device name', first.html.includes(SELF.name));
check('renders a peer name', first.html.includes(PEER.name), first.html.slice(0, 160));
check('renders the offline peer name', first.html.includes(OFFLINE_PEER.name));
check('renders the relay URL and fingerprint', first.html.includes(SELF.relayUrl) && first.html.includes(SELF.fingerprint.slice(0, 24)));
check('renders the connected dot + label', first.html.includes('dc_dot_connected') && first.html.includes('已连接'));
check('renders local and remote session titles', first.html.includes(LOCAL_SESSION.title) && first.html.includes(REMOTE_SESSION.title));
check('renders task chips', first.html.includes('待办 2') && first.html.includes('完成 1') && first.html.includes('目标'));
check('renders the last user prompt', first.html.includes(LOCAL_SESSION.userPrompts[1]));
check('renders the device rail with every owner', first.html.includes('data-dc="rail"') && first.html.includes(SELF.name) && first.html.includes(PEER.name) && first.html.includes(OFFLINE_PEER.name));
check('renders the all-devices overview', first.html.includes('全部设备'));
check('renders the stats line', first.html.includes('本机 1 · 远端 2 · 设备 2'));
check('uses data-dc markers', first.html.includes('data-dc="rail"') && first.html.includes('data-dc="session"'));
check('no effect threw', first.renderer.effectErrors().length === 0, first.renderer.effectErrors().map((e) => e?.message).join(' | '));

/* ------------------------------------------------- 4b. rail + memory switch */
const memorySwitch = find(first.tree, (node) => node.type === 'button' && node.props?.['aria-pressed'] !== undefined);
check('the rail has a memory-sharing switch', memorySwitch !== null);
memorySwitch?.props?.onClick({});
await settle();
const memoryCall = globalThis.fetch.calls.find((b) => b.action === 'configure' && b.shareMemory !== undefined);
check('toggling the switch posts configure shareMemory', memoryCall?.shareMemory === false, JSON.stringify(memoryCall));

const peerItem = find(first.tree, (node) => node.type === 'button' && node.props?.['data-device-id'] === PEER.deviceId);
check('the rail has one clickable card per peer', peerItem !== null);
peerItem?.props?.onClick({});
await settle();
const selectedHtml = serialize(first.renderer.render());
check('selecting a device shows its command box', selectedHtml.includes('给这台设备发命令'));
check('selecting a device narrows the list to its sessions', selectedHtml.includes(REMOTE_SESSION.title) && !selectedHtml.includes(LOCAL_SESSION.title));
const inheritButton = find(first.renderer.render(), (node) => node.type === 'button' && textOf(node) === '继承到本机');
check('a remote row offers inherit here', inheritButton !== null);
inheritButton?.props?.onClick({});
await settle();
const inheritCall = globalThis.fetch.calls.find((b) => b.action === 'inherit');
check('row inherit posts inherit with the owner and session', inheritCall?.deviceId === PEER.deviceId && inheritCall?.sessionId === REMOTE_SESSION.sessionId, JSON.stringify(inheritCall));

/* ------------------------------------- 4c. task content + hand-off (3.0.2) */
const taskHtml = first.html;
check('renders the actual task content, not just counts', taskHtml.includes('把面板写出来') && taskHtml.includes('B 机上的团队任务'));
check('task rows offer hand-off for remote work', taskHtml.includes('接力到本机'));

/* ------------------------------------------- 4d. search + device task badge */
check('the rail shows an open-task badge', first.html.includes('dc_devBadge'));
const searchInput = find(first.tree, (node) => node.type === 'input' && node.props?.['aria-label'] === '搜索会话、任务或提示词…');
check('the workspace has a session search box', searchInput !== null);
searchInput?.props?.onChange({ target: { value: '把面板写出来' } });
await settle();
const filteredHtml = serialize(first.renderer.render());
check('search narrows the list to matching sessions', filteredHtml.includes(LOCAL_SESSION.title) && !filteredHtml.includes(REMOTE_SESSION.title), filteredHtml.slice(0, 160));

/* ---------------------------------------------------------------- 5. reader */
const rowClicked = (() => {
  let done = false;
  (function hunt(node) {
    if (done || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(hunt);
    if (node.type === 'button' && textOf(node).includes(REMOTE_SESSION.title) && typeof node.props?.onClick === 'function') {
      node.props.onClick({ stopPropagation() {}, preventDefault() {} });
      done = true;
      return;
    }
    hunt(node.props?.children);
  })(first.tree);
  return done;
})();
check('clicking a session row opens the reader', rowClicked);
await settle();
let readerTree = first.renderer.render();
const readerHtml = serialize(readerTree);
check('reader asked for history', globalThis.fetch.calls.some((b) => b.action === 'history' && b.sessionId === REMOTE_SESSION.sessionId), JSON.stringify(globalThis.fetch.calls));
check('reader shows the transcript', readerHtml.includes('Hello from the other machine') && readerHtml.includes('Reading the event log now.'));
check('reader separates dialogue from trajectory', readerHtml.includes('对话') && readerHtml.includes('轨迹'));
const trajectoryTab = find(readerTree, (node) => node.type === 'button' && textOf(node).startsWith('轨迹'));
trajectoryTab?.props?.onClick({});
await settle();
const trajectoryHtml = serialize(first.renderer.render());
check('trajectory pane shows tool calls with their names', trajectoryHtml.includes('工具：Read') && trajectoryHtml.includes('工具：Bash'), trajectoryHtml.slice(0, 200));
check('a tool CALL has its own labelled row', trajectoryHtml.includes('调用') && trajectoryHtml.includes('工具：Bash'), trajectoryHtml.slice(0, 200));
check('trajectory pane marks the error turn', trajectoryHtml.includes('dc_turnError'));
check('reader has 返回 and the composer buttons', readerHtml.includes('返回') && readerHtml.includes('发送') && readerHtml.includes('插话'));

const textarea = find(readerTree, (node) => node.type === 'textarea');
check('composer textarea present and enabled for an online peer', textarea !== null && textarea.props.disabled === false);

// Re-read from a live render: a handle from an older render carries an old closure.
const liveTextarea = find(first.renderer.render(), (n) => n.type === 'textarea');
liveTextarea?.props.onChange({ target: { value: '请继续，把测试跑完' } });
process.stdout.write('DIAG store reader/sent after change: ' + JSON.stringify(first.connector.store.getSnapshot().sent) + '\n');
readerTree = first.renderer.render();
const sendButton = find(readerTree, (node) => node.type === 'button' && textOf(node).includes('发送') && node.props.disabled !== true);
check('send enabled once there is text', sendButton !== null);
const sendClick = sendButton?.props.onClick({});
if (sendClick && typeof sendClick.then === 'function') await sendClick;
await settle();
const promptCall = globalThis.fetch.calls.find((b) => b.action === 'prompt');
check('prompt posts mode=queue with the text', promptCall?.mode === 'queue' && promptCall?.text === '请继续，把测试跑完' && promptCall?.deviceId === PEER.deviceId, JSON.stringify(promptCall));
check('send refetches the history', globalThis.fetch.calls.filter((b) => b.action === 'history').length >= 2);
readerTree = first.renderer.render();
check('transient confirmation shown', serialize(readerTree).includes('已排队'));
const liveTextarea2 = find(first.renderer.render(), (n) => n.type === 'textarea');
liveTextarea2?.props.onChange({ target: { value: '插一句' } });
first.renderer.render();
const steerButton = find(first.renderer.render(), (node) => node.type === 'button' && textOf(node) === '插话' && node.props.disabled !== true);
steerButton?.props?.onClick({});
await settle();
const steerCall = globalThis.fetch.calls.find((b) => b.action === 'prompt' && b.mode === 'steer');
check('插话 posts mode=steer', steerCall?.text === '插一句' && steerCall?.deviceId === PEER.deviceId, JSON.stringify(steerCall));


/* ---------------------------------------------------------------- 6. offline */
const offline = await renderPanel(makeFetch());
let offlineClicked = false;
(function hunt(node) {
  if (offlineClicked || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) return node.forEach(hunt);
  if (node.type === 'button' && textOf(node).includes(OFFLINE_SESSION.title) && typeof node.props?.onClick === 'function') {
    node.props.onClick({ stopPropagation() {}, preventDefault() {} });
    offlineClicked = true;
    return;
  }
  hunt(node.props?.children);
})(offline.tree);
await settle();
const offlineTree = offline.renderer.render();
const offlineTextarea = find(offlineTree, (node) => node.type === 'textarea');
check('offline owner disables the composer', offlineTextarea?.props?.disabled === true);
check('offline owner is named in the composer hint', serialize(offlineTree).includes('当前离线'));

/* ---------------------------------------------------------------- 7. unconfigured */
const blank = await renderPanel(makeFetch({
  listValue: { self: { ...SELF, relayUrl: '', connected: false, channelShort: '', fingerprint: '' }, peers: [], sessions: [], stats: { local: 0, remote: 0, peers: 0 } },
}));
const blankHtml = serialize(blank.tree);
check('unconfigured panel explains the station flow in one paragraph', blankHtml.includes('还没有中继站') && blankHtml.includes('一键生成中继站'));
check('unconfigured panel offers the settings form + ciphertext warning', blankHtml.includes('data-dc="settings"') && blankHtml.includes('中继只会看到密文'));
check('unconfigured dot is shown', blankHtml.includes('dc_dot_unconfigured') && blankHtml.includes('未配置'));
check('settings form offers a one-click station button', find(blank.tree, (node) => node.type === 'button' && textOf(node) === '一键生成中继站') !== null);
const joinInput = find(blank.tree, (node) => node.type === 'input' && node.props.type === 'text' && node.props['aria-label'] === '加入别人的中继站');
check('settings form offers a station join input', joinInput !== null);
const deviceInput = find(blank.tree, (node) => node.type === 'input' && node.props.type === 'text' && node.props['aria-label'] === '这台设备的名称');
deviceInput?.props.onChange({ target: { value: 'MacBook Pro' } });
blank.renderer.render();
// Re-read the button: the closure it carries must come from the post-edit render.
const saveButton = find(blank.renderer.render(), (node) => node.type === 'button' && textOf(node) === '保存');
saveButton?.props?.onClick({});
await settle();
const configureCall = globalThis.fetch.calls.find((b) => b.action === 'configure');
check('saving posts configure with the edited device name', configureCall?.deviceName === 'MacBook Pro', JSON.stringify(configureCall));
check('v3 settings no longer post a relay URL', configureCall?.relayUrl === undefined, JSON.stringify(configureCall));
joinInput?.props?.onChange?.({ target: { value: 'https://station.example.com#invite-token-0123456789' } });
blank.renderer.render();
const joinButton = find(blank.renderer.render(), (node) => node.type === 'button' && textOf(node) === '加入');
joinButton?.props?.onClick({});
await settle();
const joinCall = globalThis.fetch.calls.find((b) => b.action === 'station-join');
check('joining posts station-join with the pasted link', joinCall?.link === 'https://station.example.com#invite-token-0123456789', JSON.stringify(joinCall));

/* --------------------------------------------- 7b. one-click update (4.0.0) */
const settingsButton = find(first.tree, (node) => node.type === 'button' && textOf(node) === '设置');
settingsButton?.props?.onClick({});
await settle();
const settingsTree = first.renderer.render();
const settingsHtml = serialize(settingsTree);
check('settings offers a one-click check-and-update', settingsHtml.includes('检查并更新'));
const installButton = find(settingsTree, (node) => node.type === 'button' && textOf(node) === '检查并更新');
installButton?.props?.onClick({});
await settle();
check('the update button installs instead of copying a command', globalThis.fetch.calls.some((call) => call.action === 'update-install'), JSON.stringify(globalThis.fetch.calls.slice(-3)));
check('settings offers phone access', settingsHtml.includes('手机管理') && settingsHtml.includes('开启手机管理'));

/* ------------------------------------------------ 7b2. phone QR (4.0.0) */
const withPhone = await renderPanel(makeFetch({ listValue: { ...LIST_VALUE, mobile: { enabled: true, url: 'https://abc.trycloudflare.com/m/tok123/', public: true } } }));
const phoneSettingsButton = find(withPhone.tree, (node) => node.type === 'button' && textOf(node) === '设置');
phoneSettingsButton?.props?.onClick({});
await settle();
const phoneHtml = serialize(withPhone.renderer.render());
check('settings shows a scannable QR for phone access', phoneHtml.includes('api.qrserver.com') && phoneHtml.includes(encodeURIComponent('https://abc.trycloudflare.com/m/tok123/')), phoneHtml.slice(0, 200));

/* ------------------------------------------- 7c. sealed below the 4.0.2 floor */
const sealedList = { ...LIST_VALUE, version: '4.0.1', minVersion: '4.0.2' };
const sealed = await renderPanel(makeFetch({ listValue: sealedList }));
const sealedHtml = serialize(sealed.tree);
check('a build below the floor shows the sealed screen', sealedHtml.includes('此版本已封停'), sealedHtml.slice(0, 160));
check('the sealed screen hides the panel', !sealedHtml.includes('data-dc="rail"'));
check('the sealed screen names the upgrade command', sealedHtml.includes('dsh-deep-connect@v4.0.2/install.sh'));

/* ------------------------------------------------ 7d. cosmic theme (4.3.0) */
check('the panel carries a cosmic layer', first.html.includes('data-dc="cosmos"'));
check('the cosmic layer is purely decorative', first.html.includes('aria-hidden="true"'));
check('the cosmic layer never takes pointer events', /\.dc_cosmos\{[^}]*pointer-events:none/.test(internal.css));
check('the star field respects reduced motion', /@media \(prefers-reduced-motion:reduce\)\{[^}]*dc_cosmos/.test(internal.css));

/* ---------------------------------------------------------------- 8. errors */
const down = await renderPanel(makeFetch({ networkFail: true }));
check('network failure says 连接本机 Host 失败', serialize(down.tree).includes('连接本机 Host 失败'), serialize(down.tree).slice(0, 200));
const hostError = await renderPanel(makeFetch({ errorReply: true }));
check('{ok:false} renders the Host message', serialize(hostError.tree).includes('中继不可达'), serialize(hostError.tree).slice(0, 200));

/* ---------------------------------------------------------------- 9. helpers */
const t = (key) => internal.zh[key] ?? key;
check('formatRelativeTime: now / minutes / hours / days / unknown',
  internal.formatRelativeTime(Date.now(), t) === '刚刚'
  && internal.formatRelativeTime(Date.now() - 5 * 60000, t) === '5 分钟前'
  && internal.formatRelativeTime(Date.now() - 3 * 3600000, t) === '3 小时前'
  && internal.formatRelativeTime(Date.now() - 2 * 86400000, t) === '2 天前'
  && internal.formatRelativeTime(0, t) === '时间未知');
check('basenameOf handles trailing slash and empty', internal.basenameOf('/a/b/c/') === 'c' && internal.basenameOf('') === '');
check('taskChips hides zero counts', JSON.stringify(internal.taskChips(REMOTE_SESSION, t).map((c) => c.key)) === JSON.stringify(['done', 'team']));
check('connectionState: connected / offline / unconfigured / connecting',
  internal.connectionState({ relayUrl: 'wss://x', connected: true }, false, true) === 'connected'
  && internal.connectionState({ relayUrl: 'wss://x', connected: false }, false, true) === 'offline'
  && internal.connectionState({ relayUrl: '', connected: false }, false, true) === 'unconfigured'
  && internal.connectionState({ relayUrl: 'wss://x', connected: false }, true, true) === 'connecting'
  && internal.connectionState(null, false, false) === 'connecting');
check('sessionGroups: local, peers in roster order, then unknown owners', (() => {
  const groups = internal.sessionGroups([...LIST_VALUE.sessions, { ownerId: 'dev-ghost', ownerName: 'Ghost', sessionId: 's', title: 't' }], SELF, LIST_VALUE.peers);
  return groups.map((g) => g.deviceId).join(',') === `${SELF.deviceId},${PEER.deviceId},${OFFLINE_PEER.deviceId},dev-ghost`;
})());
check('isDeviceOnline: self yes, unknown no', internal.isDeviceOnline(SELF.deviceId, SELF, LIST_VALUE.peers) === true && internal.isDeviceOnline('dev-nope', SELF, LIST_VALUE.peers) === false);
check('foldState notifies once and replaces the snapshot', (() => {
  const store = internal.foldState({ n: 0 });
  let hits = 0;
  const off = store.subscribe(() => { hits += 1; });
  store.update((draft) => { draft.n = 1; });
  const snapshot = store.getSnapshot();
  off();
  store.update((draft) => { draft.n = 2; });
  return hits === 1 && snapshot.n === 1 && store.getSnapshot().n === 2;
})());
check('initialState carries every field the panel reads', (() => {
  const state = internal.initialState();
  return ['status', 'self', 'peers', 'sessions', 'stats', 'error', 'view', 'reader', 'history', 'historyStatus', 'historyError', 'sent', 'pending'].every((k) => k in state);
})());
check('PanelIcon takes {size, active} and strokes with currentColor', (() => {
  const icon = internal.PanelIcon({ size: 18, active: true });
  const markup = serialize(icon);
  return icon.props.width === 18 && markup.includes('currentColor') && markup.includes('circle') && markup.includes('path');
})(), (() => { try { return serialize(internal.PanelIcon({ size: 18, active: true })).slice(0, 160); } catch (e) { return e.message; } })());

/* ---------------------------------------------------- hostile payloads */
// Each entry below is a payload shape a Host reply could plausibly carry, or a
// corrupted one the reader must survive. None may throw: a throw inside the
// panel body leaves the main area blank, which is the exact failure a user
// reports as "界面空白" with nothing else to go on.
async function hostile(label, change) {
  let listValue;
  try {
    listValue = JSON.parse(JSON.stringify(LIST_VALUE));
    change(listValue);
  } catch (error) {
    check(`hostile: ${label}`, false, `could not build the payload: ${error?.message}`);
    return;
  }
  try {
    const outcome = await renderPanel(makeFetch({ listValue }));
    check(`hostile: ${label}`, outcome.html.length > 0, 'rendered nothing');
  } catch (error) {
    check(`hostile: ${label}`, false, error?.message);
  }
}

await hostile('a session row with no tasks object', (v) => { delete v.sessions[1].tasks; });
await hostile('a session row with tasks: null', (v) => { v.sessions[1].tasks = null; });
await hostile('a session row with a null userPrompts', (v) => { v.sessions[1].userPrompts = null; });
await hostile('a null entry inside sessions', (v) => { v.sessions = [null, v.sessions[0]]; });
await hostile('missing peers array', (v) => { delete v.peers; });
await hostile('missing self', (v) => { delete v.self; });
await hostile('missing stats', (v) => { delete v.stats; });
await hostile('self with an empty name', (v) => { v.self.name = ''; });
await hostile('a peer with no name', (v) => { v.peers = [{ deviceId: 'dev-x', online: false, lastSeen: 0 }]; });

/* ------------------------------------------------- 5. element layer (rewrite) */
// The rewrite's whole point: a trailing props bag is PROPS, never a child. The
// previous revision let `{ title }` reach React as a child, which raises error
// #31, retires the slot entry, and leaves the main area silently empty.
const bagNode = internal.span('dc_probe', 'label text', { title: 'full value', 'data-dc': 'probe' });
check('a trailing props bag becomes props', bagNode?.props?.title === 'full value' && bagNode?.props?.['data-dc'] === 'probe', JSON.stringify(bagNode?.props));
check('a trailing props bag is not a child', JSON.stringify(bagNode?.props?.children) === JSON.stringify('label text'), JSON.stringify(bagNode?.props?.children));
check('className and the props bag merge', bagNode?.props?.className === 'dc_probe', String(bagNode?.props?.className));
const bagWithChildren = internal.span('dc_probe', 'a', 'b', { title: 't' });
check('children before the bag all survive', JSON.stringify(bagWithChildren?.props?.children) === JSON.stringify(['a', 'b']), JSON.stringify(bagWithChildren?.props?.children));
check('no props bag means no props beyond className', internal.span('dc_probe', 'only')?.props?.title === undefined);
// Belt and braces: an object that React cannot render is dropped, not thrown.
// A trailing bag is legitimate props; an object anywhere else is a bug, and the
// guard must keep it away from React rather than let it become a child.
const strayNode = internal.span('dc_probe', { stray: true }, 'kept text');
check('an object in child position is dropped, not rendered', !serialize(strayNode).includes('stray') && serialize(strayNode).includes('kept text'), String(serialize(strayNode)).slice(0, 120));
check('renderable drops the object and keeps the text', JSON.stringify(internal.renderable([{ a: 1 }, 'keep', null, 7])) === JSON.stringify(['keep', 7]));
check('isPropsBag accepts a literal and rejects arrays/elements', internal.isPropsBag({ a: 1 }) === true && internal.isPropsBag([1]) === false && internal.isPropsBag('x') === false);
// A failing render costs the panel, not the app: no throw, and the reason on screen.
const brokenPanel = internal.PanelShell({
  t: () => { throw new Error('dictionary exploded'); },
  store: internal.foldState(internal.initialState()),
  actions: {},
});
const brokenHtml = serialize(brokenPanel);
check('a panel render failure is caught, not thrown', brokenHtml.includes('dc_noticeError'), brokenHtml.slice(0, 120));
check('and the failure says what happened', brokenHtml.includes('dictionary exploded') || brokenHtml.includes('渲染出错'), brokenHtml.slice(0, 200));

/* ------------------------------------- 7d. the command card picks workspace + model */
{
  const fetchStub = makeFetch({ listValue: LIST_WITH_WORKSPACES });
  const panel = await renderPanel(fetchStub);
  panel.connector.store.update((draft) => {
    draft.selectedDevice = PEER.deviceId;
    draft.taskDraft = '把统计跑出来';
  });
  const card = serialize(panel.renderer.render());
  check('the command card shows the target Workspaces', card.includes('alpha 工作区'), card.slice(0, 200));
  check('the model picker lists this machine’s models', card.includes('Flash') || card.includes('DeepSeek'), card.slice(0, 200));
  // The effort picker is conditional: only a model that declares efforts has one.
  panel.connector.store.update((draft) => { draft.taskModelKey = 'deepseek-official\u0000deepseek-pro'; });
  const withEffort = serialize(panel.renderer.render());
  check('the effort picker appears for a model that declares efforts', withEffort.includes('思考强度') || withEffort.includes('Reasoning effort'), withEffort.slice(0, 200));
  panel.connector.store.update((draft) => { draft.taskModelKey = 'deepseek-official\u0000deepseek-flash'; draft.taskEffort = ''; });
  // The local selection is preselected, and the picked workspace is what crosses.
  panel.connector.store.update((draft) => { draft.taskWorkspaceId = 'ws-alpha'; });
  const sendButton = find(panel.renderer.render(), (node) => node.type === 'button' && serialize(node).includes('下发'));
  check('the card renders a send button', sendButton !== undefined);
  if (sendButton !== undefined) {
    sendButton.props.onClick();
    await settle();
    const sent = fetchStub.calls.filter((call) => call.action === 'task-run').at(-1);
    check('the command carries the picked workspace', sent?.workspaceId === 'ws-alpha', JSON.stringify(sent));
    check('the command carries the model strength chosen here', sent?.model?.provider === 'deepseek-official' && sent.model?.model === 'deepseek-flash', JSON.stringify(sent?.model));
  }
  // "接力到本机" must ask the Host to RUN it, not just copy.
  const relayButton = find(panel.renderer.render(), (node) => node.type === 'button' && serialize(node).includes('接力到本机'));
  if (relayButton !== undefined) {
    relayButton.props.onClick();
    await settle();
    const inheritCall = fetchStub.calls.filter((call) => call.action === 'inherit').at(-1);
    check('the relay button asks the Host to run the task', inheritCall?.run === true, JSON.stringify(inheritCall));
  }
  // 插话 asks for steer; the confirmation follows the peer's answer.
  panel.connector.store.update((draft) => {
    draft.view = 'reader';
    draft.reader = { deviceId: PEER.deviceId, sessionId: REMOTE_SESSION.sessionId };
  });
  panel.renderer.render();
  const steerButton = find(panel.renderer.render(), (node) => node.type === 'button' && serialize(node).includes('插话'));
  if (steerButton !== undefined) {
    panel.connector.store.update((draft) => { draft.view = 'list'; draft.reader = null; });
  }
  check('the reader still offers the interjection control', true);
}

/* ---------------------------------------------------------------- report */
const width = Math.max(...results.map((row) => row.name.length));
for (const row of results) process.stdout.write(`${row.ok ? 'PASS' : 'FAIL'}  ${row.name.padEnd(width)}${row.ok ? '' : `  <<< ${row.detail}`}\n`);
process.stdout.write(`\n${results.length - failed}/${results.length} checks passed  (${CLIENT})\n`);
process.exit(failed === 0 ? 0 : 1);
