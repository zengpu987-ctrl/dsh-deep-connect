/**
 * Browser half of the Deep Connect bundle — rewritten from scratch.
 *
 * One sidebar entry, `deep-connect`, opens a full-page view over the Host half's
 * frozen command API (`deep-connect/DESIGN.md` §5): this machine's identity and
 * relay state, the peer roster, every known session index (local and remote), a
 * reader for one conversation's full transcript, and a composer that hands a new
 * prompt to the machine that owns the session. Only React from the boot module
 * table and `--dsw-*` theme tokens are used, so the panel follows the app's
 * language and both themes.
 *
 * The browser never talks to the relay: every request goes to the local Host on
 * the same origin, which owns the socket, the keys, and the cache.
 *
 * Three rules this file follows, each learned from a real failure:
 *
 * 1. **A props bag is never a child.** `span('dc_value', text, { title: text })`
 *    is the shape this module reads as markup; the element layer below pulls the
 *    trailing bag out as props. The previous revision passed it straight to React,
 *    which throws error #31 ("objects are not valid as a React child"); a throw
 *    inside a slot entry retires the entry, so the whole panel silently vanished
 *    and the sidebar button opened an empty main area.
 * 2. **Children are sanitized, not trusted.** Anything React cannot render is
 *    dropped with a warning, so no future call site can reproduce rule 1's crash.
 * 3. **Registration never throws.** A client entry that fails to activate is
 *    escalated by the desktop shell to a fatal "web boot" screen, which empties
 *    the entire window; a failing panel must cost only the panel.
 */
window.__ModuleLoader__.load({
	id: '@local/dsh-deep-connect',
	factory: (require) => {
		const React = require('react');
		/** This package's name, used for the style tag's ownership marker. */
		const PKG = '@local/dsh-deep-connect';
		/** Dictionary namespace owned by this plugin. */
		const NS = 'deep-connect';
		/** Sidebar entry id; the same id keys the layout's `main` entry. */
		const PANEL_ID = 'deep-connect';
		/** The Host half's single command route, under the authenticated `/api` channel. */
		const API_URL = '/api/deep-connect/api';
		/** Required services (cordis fiber inject): exactly the two the panel uses. */
		const inject = ['slots', 'locale'];
		/** How often a mounted, visible panel re-reads the roster and indices. */
		const POLL_MS = 5000;
		/** How long the reader's "sent" confirmation stays on screen. */
		const SENT_MS = 2600;
		/** `React.useMemo` when the host provides it; the offline stub does not. */
		const useMemo = typeof React.useMemo === 'function' ? React.useMemo : (factory) => factory();

		//#region element layer
		/** Whether a value is a React element, without depending on one React copy. */
		const isElement = (value) => {
			if (value === null || typeof value !== 'object') return false;
			if (typeof React.isValidElement === 'function') return React.isValidElement(value);
			if (value.$$typeof !== undefined) return true;
			return value.props !== undefined && (typeof value.type === 'string' || typeof value.type === 'function');
		};

		/** Whether a value is the plain props bag this module allows as a last argument. */
		const isPropsBag = (value) => {
			if (value === null || typeof value !== 'object' || Array.isArray(value) || isElement(value)) return false;
			const prototype = Object.getPrototypeOf(value);
			return prototype === Object.prototype || prototype === null;
		};

		/**
		 * Keep only what React can render. An object that reaches React as a child
		 * raises error #31, which a slot entry answers by retiring itself — the
		 * failure this module exists to make impossible — so a stray object is
		 * dropped and reported rather than thrown.
		 * @param input - the candidate children of one element.
		 * @returns the renderable ones, in order.
		 */
		function renderable(input) {
			const out = [];
			for (const child of input) {
				if (child === undefined || child === null || typeof child === 'boolean') continue;
				if (typeof child === 'string' || typeof child === 'number' || isElement(child) || Array.isArray(child)) {
					out.push(child);
					continue;
				}
				try {
					globalThis.console?.warn?.(`[${PKG}] dropped a non-renderable child: ${String(child)}`);
				} catch {
					/* logging must never throw */
				}
			}
			return out;
		}

		/** A raw element: an explicit props object and children. */
		const h = (tag, props, ...children) => React.createElement(tag, props ?? null, ...renderable(children));
		/** A component element: an explicit props object and children. */
		const el = (component, props, ...children) => React.createElement(component, props ?? null, ...renderable(children));
		/** An SVG element: a name, attributes, and its shape children. */
		const svg = (name, attrs, ...shapes) => React.createElement(name, attrs, ...renderable(shapes));
		/** Class-name joiner; drops the falsy branches instead of printing them. */
		const cx = (...names) => names.filter(Boolean).join(' ');
		const oneOf = (map, key, fallback) => map[key] ?? fallback;

		/**
		 * The text/badge family the layout below is written in. The LAST argument may
		 * be a props bag; every argument before it is a child. Taking the bag out here
		 * is what keeps `{ title }`, `{ key }` and `{ role }` out of React's children.
		 * @param tag - the HTML tag.
		 * @param className - the class name, or null for none.
		 * @param rest - children, optionally followed by one props bag.
		 */
		function element(tag, className, ...rest) {
			const bag = rest.length > 0 && isPropsBag(rest[rest.length - 1]) ? rest.pop() : null;
			const props = { ...(className === null || className === undefined ? {} : { className }), ...(bag ?? {}) };
			return React.createElement(tag, props, ...renderable(rest));
		}
		const div = (className, ...rest) => element('div', className, ...rest);
		const span = (className, ...rest) => element('span', className, ...rest);
		const para = (className, text) => element('p', className, text);
		const pre = (className, text) => element('pre', className, text);
		const list = (className, key, children) => h('ul', { className, 'data-dc': key }, children);
		const button = (className, label, onClick, props = {}) => h('button', { type: 'button', className, onClick, ...props }, label);
		//#endregion

		//#region store
		/**
		 * Create the panel's snapshot store. The whole live state lives in one
		 * plain object that `update` replaces (never mutates), so a subscriber can
		 * cheaply tell whether anything changed.
		 * @param initial - the first snapshot.
		 */
		function foldState(initial) {
			let snapshot = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => snapshot,
				subscribe(listener) {
					listeners.add(listener);
					return () => { listeners.delete(listener); };
				},
				/** Publish one snapshot; nested values must be replaced, not edited. */
				update(mutate) {
					const draft = { ...snapshot };
					mutate(draft);
					snapshot = draft;
					for (const listener of [...listeners]) listener();
				},
			};
		}

		/**
		 * The panel's first snapshot: every field the views read, so no view has to
		 * cope with `undefined`. `status` starts at `loading` and becomes `ready` or
		 * `error` once the first `list` answers.
		 */
		function initialState() {
			return {
				status: 'loading',
				/** The `self` object of the last `list`/`configure` reply. */
				self: null,
				/** Every peer the Host knows about. */
				peers: [],
				/** Every session index entry: this machine's rows and the peers'. */
				sessions: [],
				/** The Host's counters, when it sent them. */
				stats: null,
				/** Last command-route failure, already localized. */
				error: null,
				/** `list` | `settings` | `reader` — the main view's mode. */
				view: 'list',
				/** The reader's `{ deviceId, sessionId }`, or null. */
				reader: null,
				/** The last `history` payload, plus its own status and error. */
				history: null,
				historyStatus: 'idle',
				historyError: null,
				/** `{ text, mode, at }` of the last accepted command, for the confirmation. */
				sent: null,
				/** A `reconnect`/`configure`/`prompt` command is in flight. */
				pending: false,
			};
		}
		//#endregion

		//#region helpers
		/** Human-readable relative time in the app's language, e.g. `3 分钟前`. */
		function formatRelativeTime(timestamp, t) {
			const value = Number(timestamp);
			if (!Number.isFinite(value) || value <= 0) return t('timeUnknown');
			const delta = Date.now() - value;
			if (delta < 60_000) return t('timeNow');
			if (delta < 3_600_000) return t('timeMinutes').replace('{n}', String(Math.max(1, Math.round(delta / 60_000))));
			if (delta < 86_400_000) return t('timeHours').replace('{n}', String(Math.max(1, Math.round(delta / 3_600_000))));
			if (delta < 7 * 86_400_000) return t('timeDays').replace('{n}', String(Math.max(1, Math.round(delta / 86_400_000))));
			const date = new Date(value);
			return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
		}

		/** Short byte size for the session meta line; empty when the Host sent none. */
		function formatBytes(bytes) {
			const value = Number(bytes);
			if (!Number.isFinite(value) || value <= 0) return '';
			if (value < 1024) return `${value} B`;
			if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
			if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
			return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
		}

		/** Last path segment of a working directory — a row has room for one. */
		function basenameOf(cwd) {
			if (typeof cwd !== 'string' || cwd === '') return '';
			const parts = cwd.replace(/[/\\]+$/, '').split(/[/\\]/);
			return parts[parts.length - 1] ?? '';
		}

		/** Truncate a device id or fingerprint; the `title` attribute keeps the rest. */
		function shortOf(value, length) {
			const text = typeof value === 'string' ? value : '';
			return text === '' || text.length <= length ? text : `${text.slice(0, length)}…`;
		}

		/** Message text of a thrown value. */
		function messageOf(error, t) {
			const message = error instanceof Error && typeof error.message === 'string' ? error.message : '';
			return message === '' ? t('errorUnknown') : message;
		}

		/** One turn's body text; the Host already rendered it to plain text. */
		const turnText = (turn) => (typeof turn?.text === 'string' ? turn.text : '');

		/** Device-id -> Peer map, for the dot, the cards, and the composer. */
		function peerMap(peers) {
			const map = new Map();
			for (const peer of Array.isArray(peers) ? peers : []) {
				if (peer !== null && typeof peer === 'object' && typeof peer.deviceId === 'string') map.set(peer.deviceId, peer);
			}
			return map;
		}

		/** Numbers out of a reply are untrusted: coerce, defaulting to 0. */
		const count = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

		/**
		 * Fold one session index entry into the chips a row shows. Only non-zero
		 * counts produce a chip, so a quiet conversation stays a two-line row.
		 * A malformed `tasks` value must not throw during render.
		 */
		function taskChips(entry, t) {
			const candidate = entry === null || entry === undefined ? undefined : entry.tasks;
			const tasks = candidate !== null && typeof candidate === 'object' ? candidate : {};
			const chips = [];
			if (count(tasks.open) > 0) chips.push({ key: 'open', text: t('chipOpen').replace('{n}', String(count(tasks.open))) });
			if (count(tasks.done) > 0) chips.push({ key: 'done', text: t('chipDone').replace('{n}', String(count(tasks.done))) });
			if (typeof tasks.goal === 'string' && tasks.goal !== '') chips.push({ key: 'goal', text: t('chipGoal') });
			if (count(tasks.team) > 0) chips.push({ key: 'team', text: t('chipTeam').replace('{n}', String(count(tasks.team))) });
			return chips;
		}

		/**
		 * Whether a device's composer may be used. A session is always written by
		 * exactly one machine (DESIGN.md §7), so an offline owner means "queued at
		 * best" — the panel says so instead of pretending the prompt ran.
		 */
		function isDeviceOnline(deviceId, self, peers) {
			if (self !== null && deviceId === self.deviceId) return true;
			return peerMap(peers).get(deviceId)?.online === true;
		}

		/**
		 * Group the flat session list into the sections the panel renders: this
		 * machine first, then one section per peer in roster order (even an empty
		 * one — a device that has synced nothing yet is worth showing), then any
		 * owner the roster has not heard of.
		 */
		function sessionGroups(sessions, self, peers) {
			const byOwner = new Map();
			for (const entry of Array.isArray(sessions) ? sessions : []) {
				if (entry === null || typeof entry !== 'object') continue;
				const owner = typeof entry.ownerId === 'string' && entry.ownerId !== '' ? entry.ownerId : '';
				if (!byOwner.has(owner)) byOwner.set(owner, []);
				byOwner.get(owner).push(entry);
			}
			const groups = [];
			const take = (deviceId, name, isRemote, online) => {
				groups.push({
					deviceId,
					name,
					isRemote,
					online,
					sessions: byOwner.get(deviceId) ?? [],
				});
				byOwner.delete(deviceId);
			};
			const selfId = typeof self?.deviceId === 'string' ? self.deviceId : '';
			if (selfId !== '') take(selfId, typeof self.name === 'string' && self.name !== '' ? self.name : selfId, false, true);
			for (const peer of Array.isArray(peers) ? peers : []) {
				const id = typeof peer?.deviceId === 'string' ? peer.deviceId : '';
				if (id === '') continue;
				take(id, typeof peer.name === 'string' && peer.name !== '' ? peer.name : id, true, peer.online === true);
			}
			for (const [id, rest] of byOwner) {
				const named = typeof rest[0]?.ownerName === 'string' && rest[0].ownerName !== '';
				groups.push({ deviceId: id, name: named ? rest[0].ownerName : id === '' ? '?' : id, isRemote: true, online: false, sessions: rest });
			}
			return groups;
		}

		/**
		 * Which of the four connection labels the header shows. The Host reports one
		 * boolean, so the in-flight states are tracked here: `pending` covers "a
		 * command is waiting on the relay" and "the first `list` has not answered
		 * yet"; an empty relay URL is the one state the reply describes explicitly.
		 */
		function connectionState(self, pending, everLoaded) {
			if (self !== null && (typeof self.relayUrl !== 'string' || self.relayUrl === '')) return 'unconfigured';
			if (pending) return 'connecting';
			if (self !== null && self.connected === true) return 'connected';
			if (self !== null) return 'offline';
			return everLoaded ? 'offline' : 'connecting';
		}

		/** Dictionary keys of the four connection states. */
		const STATE_KEYS = {
			connected: 'stateConnected', connecting: 'stateConnecting', offline: 'stateOffline', unconfigured: 'stateUnconfigured',
		};
		/** Dictionary keys of the transcript's turn roles (anything else is `system`). */
		const ROLE_KEYS = {
			user: 'roleUser', assistant: 'roleAssistant', tool: 'roleTool', developer: 'roleDeveloper',
		};
		//#endregion

		//#region locales
		/** Chinese dictionary; every key exists in `en` too (checked offline). */
		const zh = {
			panel: 'Deep Connect',
			title: 'Deep Connect 互联',
			subtitle: '同一账号的多台机器互见会话，中继只见密文',
			refresh: '刷新',
			reconnect: '重新连接',
			settings: '设置',
			close: '收起',
			save: '保存',
			saving: '保存中…',
			saved: '已保存',
			stateConnected: '已连接',
			stateConnecting: '正在连接',
			stateOffline: '未连接',
			stateUnconfigured: '未配置',
			thisDevice: '本机',
			nameFallback: '未命名',
			fingerprint: '密钥指纹',
			fingerprintHint: '两台机器上的指纹必须一模一样，才说明它们推出了同一把密钥。',
			relay: '中继地址',
			relayUnset: '未设置中继地址',
			statsLine: '本机 {local} · 远端 {remote} · 设备 {peers}',
			devices: '设备',
			devicesEmpty: '还没有发现其他设备。两台机器都填好同一个中继地址、并登录同一个 DeepSeek 账号后，这里会出现对方。',
			online: '在线',
			offline: '离线',
			lastSeen: '最近在线 {time}',
			sessionCount: '{n} 条会话',
			sessions: '会话',
			sessionsEmpty: '还没有可见的会话索引。',
			groupEmpty: '这台设备还没有同步过来的会话。',
			openReader: '打开对话',
			eventCount: '{n} 条事件',
			chipOpen: '待办 {n}',
			chipDone: '完成 {n}',
			chipGoal: '目标',
			chipTeam: '团队 {n}',
			live: '进行中',
			back: '返回',
			readerLoading: '正在读取对话…',
			readerEmpty: '这条对话没有可显示的正文。',
			readerError: '读取对话失败',
			readerFromCache: '来自本机缓存',
			readerFetched: '刚刚读取',
			readerEvents: '共 {n} 条事件',
			roleUser: '用户',
			roleAssistant: '助手',
			roleTool: '工具',
			roleSystem: '系统',
			roleDeveloper: '开发者',
			toolName: '工具：{name}',
			expandTurn: '展开',
			collapseTurn: '收起',
			composerPlaceholder: '输入要发给这条对话的内容…',
			send: '发送',
			steer: '插话',
			sending: '发送中…',
			sentQueue: '已排队，将由 {name} 执行',
			sentSteer: '已插话到运行中的对话',
			composerOffline: '{name} 当前离线，无法投喂：等它上线后再发送。',
			composerHint: '发送 = 排队下一条；插话 = 送进正在运行的这一轮。',
			settingsTitle: '连接设置',
			settingsRelay: '中继地址',
			settingsRelayHint: '例如 wss://relay.example.com，两端必须填同一个。',
			settingsToken: '访问令牌（可选）',
			settingsTokenHint: '中继要求鉴权时填写；留空则不改动已保存的令牌。',
			settingsSecret: '共享口令（可选）',
			settingsSecretHint: '留空则由当前登录的 DeepSeek 账号在本机推导密钥；两端都填同一口令可换成口令模式。',
			settingsDeviceName: '这台设备的名称',
			settingsDeviceNameHint: '对方在设备列表里看到的名字。',
			settingsAutoIndex: '自动同步索引',
			settingsAutoIndexHint: '本机会话变化时，把索引加密后广播给同账号的其它机器。',
			settingsAutoConnect: '开机自动连接',
			settingsAutoConnectHint: 'DSH 启动后自动连上中继，不必手动点「重新连接」。',
			settingsCipher: '中继只会看到密文：它拿到的是一条哈希过的频道号和一串 AES-256-GCM 密文，推不出密钥，也读不到对话正文。',
			settingsNotice: '密钥指纹是两端核对身份的唯一依据：只有一致，才说明两台机器推出了同一把密钥。',
			unconfiguredTitle: '还没有连接中继',
			unconfiguredBody: '这里还没有可以显示的数据。先在两台机器上都填入同一个中继地址，并确认两台机器登录的是同一个 DeepSeek 账号：账号相同 → 两边各自在本机推出同一把密钥 → 中继只负责转交密文。填好并保存后，本页会在几秒内出现对方的设备与会话索引。',
			errorUnknown: '未知错误',
			errorLoad: '读取互联状态失败',
			errorNetwork: '连接本机 Host 失败',
			errorSend: '发送失败',
			retry: '重试',
			loading: '正在读取互联状态…',
			timeUnknown: '时间未知',
			timeNow: '刚刚',
			timeMinutes: '{n} 分钟前',
			timeHours: '{n} 小时前',
			timeDays: '{n} 天前',
		};
		/** English dictionary. */
		const en = {
			panel: 'Deep Connect',
			title: 'Deep Connect',
			subtitle: 'Machines on one account see each other; the relay sees ciphertext',
			refresh: 'Refresh',
			reconnect: 'Reconnect',
			settings: 'Settings',
			close: 'Close',
			save: 'Save',
			saving: 'Saving…',
			saved: 'Saved',
			stateConnected: 'Connected',
			stateConnecting: 'Connecting',
			stateOffline: 'Offline',
			stateUnconfigured: 'Not configured',
			thisDevice: 'This machine',
			nameFallback: 'Untitled',
			fingerprint: 'Key fingerprint',
			fingerprintHint: 'The fingerprints must match exactly on both machines — that is the proof they derived the same key.',
			relay: 'Relay URL',
			relayUnset: 'No relay URL yet',
			statsLine: '{local} local · {remote} remote · {peers} devices',
			devices: 'Devices',
			devicesEmpty: 'No other device yet. Give both machines the same relay URL and sign both in to the same DeepSeek account, and the other one appears here.',
			online: 'Online',
			offline: 'Offline',
			lastSeen: 'last seen {time}',
			sessionCount: '{n} sessions',
			sessions: 'Sessions',
			sessionsEmpty: 'No session index to show yet.',
			groupEmpty: 'This device has not synced any session here yet.',
			openReader: 'Open conversation',
			eventCount: '{n} events',
			chipOpen: '{n} open',
			chipDone: '{n} done',
			chipGoal: 'Goal',
			chipTeam: 'Team {n}',
			live: 'Live',
			back: 'Back',
			readerLoading: 'Reading the conversation…',
			readerEmpty: 'This conversation has no readable body.',
			readerError: 'Could not read the conversation',
			readerFromCache: 'from this machine’s cache',
			readerFetched: 'just fetched',
			readerEvents: '{n} events in total',
			roleUser: 'User',
			roleAssistant: 'Assistant',
			roleTool: 'Tool',
			roleSystem: 'System',
			roleDeveloper: 'Developer',
			toolName: 'Tool: {name}',
			expandTurn: 'Expand',
			collapseTurn: 'Collapse',
			composerPlaceholder: 'Type what this conversation should receive…',
			send: 'Send',
			steer: 'Interject',
			sending: 'Sending…',
			sentQueue: 'Queued; {name} will run it',
			sentSteer: 'Interjected into the running turn',
			composerOffline: '{name} is offline right now — wait until it is back before sending.',
			composerHint: 'Send queues the next turn; Interject reaches the turn that is running now.',
			settingsTitle: 'Connection settings',
			settingsRelay: 'Relay URL',
			settingsRelayHint: 'For example wss://relay.example.com — both machines must use the same one.',
			settingsToken: 'Access token (optional)',
			settingsTokenHint: 'Only when the relay requires one; leaving it empty keeps the stored token.',
			settingsSecret: 'Shared passphrase (optional)',
			settingsSecretHint: 'Empty derives the key on this machine from the signed-in DeepSeek account; type the same passphrase on both machines to switch to passphrase mode.',
			settingsDeviceName: 'Name of this device',
			settingsDeviceNameHint: 'The name the other machine shows in its device list.',
			settingsAutoIndex: 'Sync the index automatically',
			settingsAutoIndexHint: 'When this machine’s sessions change, broadcast the encrypted index to the machines on the same account.',
			settingsAutoConnect: 'Connect on startup',
			settingsAutoConnectHint: 'Reach the relay as soon as DSH starts, without pressing Reconnect.',
			settingsCipher: 'The relay only ever sees ciphertext: a hashed channel id and AES-256-GCM frames. It cannot derive the key and cannot read a conversation.',
			settingsNotice: 'The key fingerprint is the only proof of identity: only a match means both machines derived the same key.',
			unconfiguredTitle: 'No relay configured yet',
			unconfiguredBody: 'There is nothing to show yet. Put the same relay URL on both machines and make sure both are signed in to the same DeepSeek account: same account → each machine derives the same key locally → the relay only forwards ciphertext. Save it below and the other machine’s devices and session index appear here within seconds.',
			errorUnknown: 'Unknown error',
			errorLoad: 'Could not read the connection state',
			errorNetwork: 'Could not reach the local Host',
			errorSend: 'Could not send',
			retry: 'Retry',
			loading: 'Reading the connection state…',
			timeUnknown: 'unknown time',
			timeNow: 'just now',
			timeMinutes: '{n} min ago',
			timeHours: '{n} h ago',
			timeDays: '{n} d ago',
		};
		//#endregion

		//#region subscription
		/**
		 * Subscribe one component to a store with `useSyncExternalStore` where it
		 * exists, and with a state/effect pair where it does not (the offline stub).
		 * @param store - the store from {@link foldState}.
		 */
		function useSnapshot(store) {
			if (typeof React.useSyncExternalStore === 'function') {
				return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			}
			const [snapshot, setSnapshot] = React.useState(() => store.getSnapshot());
			React.useEffect(() => store.subscribe(() => setSnapshot(store.getSnapshot())), [store]);
			return snapshot;
		}
		//#endregion

		//#region connector
		/**
		 * The Host's command channel: one `fetch` helper, one poll, and the actions
		 * the panel calls. State lives in the store; this object owns I/O and life
		 * cycle only.
		 * @param t - the bound dictionary lookup.
		 */
		function createConnector(t) {
			const store = foldState(initialState());
			/** Every fetch still in flight, so unmount can cut them. */
			const controllers = new Set();
			let disposed = false;
			/** Whether the first `list` answer has arrived; see `connectionState`. */
			let everLoaded = false;
			/** The poll in flight, so a slow round is never stacked on itself. */
			let listInFlight = null;

			/**
			 * POST one JSON command and unwrap the frozen envelope. A `{ok:false}`
			 * reply carries the Host's own message; a transport failure gets the
			 * localized "could not reach the local Host" line, because the two need
			 * different words on screen.
			 */
			async function request(body) {
				const controller = typeof AbortController === 'function' ? new AbortController() : null;
				if (controller !== null) controllers.add(controller);
				let response;
				try {
					response = await fetch(API_URL, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(body),
						...(controller === null ? {} : { signal: controller.signal }),
					});
				} catch (error) {
					if (controller !== null) controllers.delete(controller);
					// A deliberate abort is not a failure the user should read about.
					if (error instanceof Error && error.name === 'AbortError') throw error;
					throw new Error(t('errorNetwork'));
				}
				if (controller !== null) controllers.delete(controller);
				let payload;
				try {
					payload = await response.json();
				} catch {
					throw new Error(t('errorUnknown'));
				}
				if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
					const detail = payload !== null && typeof payload === 'object' ? payload.error : null;
					const message = typeof detail?.message === 'string' && detail.message !== ''
						? detail.message
						: typeof detail?.code === 'string' && detail.code !== '' ? detail.code : '';
					throw new Error(message === '' ? t('errorUnknown') : message);
				}
				return payload.value !== null && typeof payload.value === 'object' ? payload.value : {};
			}

			/**
			 * Publish one `list`-shaped value. `configure` answers with the same
			 * shape, so it reuses this instead of issuing a second read.
			 */
			function publish(value) {
				everLoaded = true;
				store.update((draft) => {
					draft.status = 'ready';
					draft.self = value.self !== null && typeof value.self === 'object' ? value.self : null;
					draft.peers = Array.isArray(value.peers) ? value.peers.filter((peer) => peer !== null && typeof peer === 'object') : [];
					draft.sessions = Array.isArray(value.sessions) ? value.sessions.filter((row) => row !== null && typeof row === 'object') : [];
					draft.stats = value.stats !== null && typeof value.stats === 'object' ? value.stats : null;
					draft.error = null;
				});
			}

			/**
			 * Read the roster and every session index.
			 * @param quiet - keep the current view; the 5 s poll uses it so a list
			 *   the user is reading never flashes a loading state.
			 */
			async function load(quiet = false) {
				if (disposed) return undefined;
				if (listInFlight !== null) return listInFlight;
				if (!quiet) store.update((draft) => {
					if (draft.status !== 'ready') draft.status = 'loading';
				});
				listInFlight = request({ action: 'list' })
					.then((value) => {
						if (!disposed) publish(value);
					})
					.catch((error) => {
						if (disposed || (error instanceof Error && error.name === 'AbortError')) return;
						store.update((draft) => {
							// A failed poll keeps the last good list on screen and only
							// adds the error line: the data is still the best we have.
							if (draft.status !== 'ready') draft.status = 'error';
							draft.error = messageOf(error, t);
						});
					})
					.finally(() => {
						listInFlight = null;
					});
				return listInFlight;
			}

			/** Ask the Host for one conversation's full transcript. */
			async function loadHistory(deviceId, sessionId) {
				if (disposed || typeof deviceId !== 'string' || deviceId === '' || typeof sessionId !== 'string' || sessionId === '') return;
				store.update((draft) => {
					draft.historyStatus = 'loading';
					draft.historyError = null;
					draft.history = null;
				});
				try {
					const value = await request({ action: 'history', deviceId, sessionId });
					if (disposed) return;
					// The reader may have moved on while this was in flight.
					const current = store.getSnapshot().reader;
					if (current === null || current.deviceId !== deviceId || current.sessionId !== sessionId) return;
					store.update((draft) => {
						draft.history = value;
						draft.historyStatus = 'ready';
						draft.historyError = null;
					});
				} catch (error) {
					if (disposed || (error instanceof Error && error.name === 'AbortError')) return;
					store.update((draft) => {
						draft.historyStatus = 'error';
						draft.historyError = messageOf(error, t);
					});
				}
			}

			/** Open the reader on one row and fetch its transcript. */
			function openReader(entry) {
				const deviceId = typeof entry?.ownerId === 'string' ? entry.ownerId : '';
				const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : '';
				if (deviceId === '' || sessionId === '') return;
				store.update((draft) => {
					draft.view = 'reader';
					draft.reader = { deviceId, sessionId };
					draft.history = null;
					draft.historyStatus = 'loading';
					draft.historyError = null;
					draft.sent = null;
				});
				void loadHistory(deviceId, sessionId);
			}

			/** Refetch the open reader's transcript (used after a successful send). */
			function reloadHistory() {
				const reader = store.getSnapshot().reader;
				return reader === null ? Promise.resolve() : loadHistory(reader.deviceId, reader.sessionId);
			}

			/** Leave the reader for the session list. */
			function closeReader() {
				store.update((draft) => {
					draft.view = 'list';
					draft.reader = null;
					draft.history = null;
					draft.historyStatus = 'idle';
					draft.historyError = null;
					draft.sent = null;
				});
			}

			/** Show or hide the settings section. */
			function toggleSettings() {
				store.update((draft) => {
					draft.view = draft.view === 'settings' ? 'list' : 'settings';
					draft.sent = null;
				});
			}

			/**
			 * Persist a settings change. Empty optional fields are omitted rather
			 * than sent blank: `configure` is a patch, and sending `token: ''` would
			 * erase a token the user never meant to touch.
			 * @param patch - the form's values.
			 * @returns whether the Host accepted the change.
			 */
			async function configure(patch) {
				const body = { action: 'configure' };
				if (typeof patch?.relayUrl === 'string') body.relayUrl = patch.relayUrl;
				if (typeof patch?.token === 'string' && patch.token !== '') body.token = patch.token;
				if (typeof patch?.secret === 'string' && patch.secret !== '') body.secret = patch.secret;
				if (typeof patch?.deviceName === 'string') body.deviceName = patch.deviceName;
				if (typeof patch?.autoIndex === 'boolean') body.autoIndex = patch.autoIndex;
				if (typeof patch?.autoConnect === 'boolean') body.autoConnect = patch.autoConnect;
				store.update((draft) => { draft.pending = true; });
				try {
					const value = await request(body);
					if (disposed) return false;
					publish(value);
					store.update((draft) => {
						draft.pending = false;
						draft.sent = { text: t('saved'), mode: 'system', at: Date.now() };
					});
					return true;
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => {
						draft.pending = false;
						draft.error = messageOf(error, t);
					});
					return false;
				}
			}

			/** Ask the Host to rebuild its relay connection, then re-read. */
			async function reconnect() {
				store.update((draft) => {
					draft.pending = true;
					draft.error = null;
				});
				try {
					await request({ action: 'reconnect' });
				} catch (error) {
					if (!disposed) store.update((draft) => { draft.error = messageOf(error, t); });
				}
				if (disposed) return;
				store.update((draft) => { draft.pending = false; });
				await load(true);
			}

			/**
			 * Deliver one prompt to the conversation open in the reader. `queue`
			 * adds the next turn; `steer` pushes into the turn running right now.
			 * The OWNING machine executes it, which is why an offline owner
			 * disables the composer instead.
			 * @returns whether the Host accepted it.
			 */
			async function sendPrompt(text, mode) {
				const reader = store.getSnapshot().reader;
				const body = typeof text === 'string' ? text.trim() : '';
				if (reader === null || body === '') return false;
				store.update((draft) => {
					draft.pending = true;
					draft.error = null;
				});
				try {
					const value = await request({
						action: 'prompt',
						deviceId: reader.deviceId,
						sessionId: reader.sessionId,
						text: body,
						mode: mode === 'steer' ? 'steer' : 'queue',
					});
					if (disposed) return false;
					const { self, peers } = store.getSnapshot();
					const owner = reader.deviceId === self?.deviceId
						? (typeof self?.name === 'string' && self.name !== '' ? self.name : t('thisDevice'))
						: (peerMap(peers).get(reader.deviceId)?.name ?? reader.deviceId);
					store.update((draft) => {
						draft.pending = false;
						draft.sent = { text: mode === 'steer' ? t('sentSteer') : t('sentQueue').replace('{name}', owner), mode, at: Date.now() };
						if (typeof value.deliveredTo === 'string' && value.deliveredTo !== '') draft.sent.deliveredTo = value.deliveredTo;
					});
					await reloadHistory();
					return true;
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => {
						draft.pending = false;
						draft.error = `${t('errorSend')} · ${messageOf(error, t)}`;
					});
					return false;
				}
			}

			return {
				store,
				actions: { load, openReader, closeReader, reloadHistory, toggleSettings, configure, reconnect, sendPrompt },
				/** Whether this controller can still publish (the poll reads it). */
				isDisposed: () => disposed,
				dispose() {
					disposed = true;
					for (const controller of [...controllers]) {
						try {
							controller.abort();
						} catch {
							/* an already-finished request has nothing to abort */
						}
					}
					controllers.clear();
				},
			};
		}
		//#endregion

		//#region views
		/** The connection dot plus its one-line status. */
		function StatusPill({ state, t }) {
			return span(cx('dc_dot', `dc_dot_${state}`), span('dc_dotCore', null), span('dc_dotLabel', t(oneOf(STATE_KEYS, state, 'stateOffline'))));
		}

		/** One labelled definition line: device name, relay URL, fingerprint. */
		function Fact({ label, value, title, mono }) {
			return span('dc_fact', span('dc_factLabel', label), span(cx('dc_factValue', mono === true && 'dc_mono'), value, { title: title ?? value }));
		}

		/** One text input with its label and hint. */
		function Field({ t, name, hint, value, placeholder, onChange }) {
			return h(
				'label',
				{ className: 'dc_field' },
				span('dc_fieldLabel', t(name)),
				h('input', {
					className: 'dc_input', type: 'text', value, placeholder: placeholder ?? '',
					'aria-label': t(name), onChange: (event) => onChange(event.target.value),
				}),
				span('dc_fieldHint', t(hint)),
			);
		}

		/** One labelled checkbox. */
		function Toggle({ t, name, hint, value, onChange }) {
			return h(
				'label',
				{ className: 'dc_check' },
				h('input', { type: 'checkbox', checked: value, onChange: (event) => onChange(event.target.checked) }),
				span('dc_checkText', span('dc_checkLabel', t(name)), span('dc_fieldHint', t(hint))),
			);
		}

		/**
		 * The settings section, rendered inline so the unconfigured empty state
		 * can offer exactly the same fields without a second implementation.
		 */
		function SettingsSection({ t, self, pending, onSave }) {
			const [relayUrl, setRelayUrl] = React.useState(typeof self?.relayUrl === 'string' ? self.relayUrl : '');
			const [token, setToken] = React.useState('');
			const [secret, setSecret] = React.useState('');
			const [deviceName, setDeviceName] = React.useState(typeof self?.name === 'string' ? self.name : '');
			const [autoIndex, setAutoIndex] = React.useState(true);
			const [autoConnect, setAutoConnect] = React.useState(true);
			const fingerprint = typeof self?.fingerprint === 'string' ? self.fingerprint : '';
			return h(
				'section',
				{ className: 'dc_settings', 'data-dc': 'settings' },
				h('h2', { className: 'dc_sectionTitle' }, t('settingsTitle')),
				div(
					'dc_settingsGrid',
					el(Field, { t, name: 'settingsRelay', hint: 'settingsRelayHint', value: relayUrl, placeholder: 'wss://relay.example.com', onChange: setRelayUrl }),
					el(Field, { t, name: 'settingsToken', hint: 'settingsTokenHint', value: token, onChange: setToken }),
					el(Field, { t, name: 'settingsSecret', hint: 'settingsSecretHint', value: secret, onChange: setSecret }),
					el(Field, { t, name: 'settingsDeviceName', hint: 'settingsDeviceNameHint', value: deviceName, onChange: setDeviceName }),
				),
				div(
					'dc_settingsRow',
					el(Toggle, { t, name: 'settingsAutoIndex', hint: 'settingsAutoIndexHint', value: autoIndex, onChange: setAutoIndex }),
					el(Toggle, { t, name: 'settingsAutoConnect', hint: 'settingsAutoConnectHint', value: autoConnect, onChange: setAutoConnect }),
				),
				div('dc_settingsRow dc_settingsRowEnd', button('dc_primary', pending ? t('saving') : t('save'), () => onSave({
					relayUrl, token, secret, deviceName, autoIndex, autoConnect,
				}), { disabled: pending })),
				para('dc_note', t('settingsCipher')),
				h(
					'p',
					{ className: 'dc_note dc_noteStrong' },
					`${t('settingsNotice')} `,
					// The fingerprint is the one value the user compares across
					// machines, so it is printed in full rather than truncated.
					fingerprint === '' ? null : span('dc_mono dc_fingerprint', fingerprint, { 'data-dc': 'fingerprint', title: fingerprint }),
				),
			);
		}

		/** One device card in the roster. */
		function DeviceCard({ peer, t }) {
			const name = typeof peer?.name === 'string' && peer.name !== '' ? peer.name : String(peer?.deviceId ?? '');
			const id = typeof peer?.deviceId === 'string' ? peer.deviceId : '';
			const online = peer?.online === true;
			const fingerprint = typeof peer?.fingerprint === 'string' ? peer.fingerprint : '';
			return h(
				'li',
				{ className: cx('dc_device', online && 'dc_deviceOnline'), 'data-dc': 'device' },
				span('dc_deviceTop', span('dc_deviceName', name, { title: name }), span(cx('dc_badge', online && 'dc_badgeOk'), online ? t('online') : t('offline'))),
				span(
					'dc_deviceMeta',
					span('dc_mono', shortOf(id, 18), { title: id }),
					span(null, t('sessionCount').replace('{n}', String(count(peer?.sessionCount)))),
					span(null, t('lastSeen').replace('{time}', formatRelativeTime(peer?.lastSeen, t))),
					typeof peer?.platform === 'string' && peer.platform !== '' ? span(null, peer.platform) : null,
				),
				fingerprint === '' ? null : span('dc_deviceMeta', span('dc_deviceMetaLabel', t('fingerprint')), span('dc_mono dc_fingerprint', shortOf(fingerprint, 24), { title: fingerprint })),
			);
		}

		/** One session row: title, meta, task chips, and the last user prompt. */
		function SessionRow({ entry, t, onOpen }) {
			const title = typeof entry?.title === 'string' && entry.title !== '' ? entry.title : t('nameFallback');
			const prompts = Array.isArray(entry?.userPrompts) ? entry.userPrompts.filter((line) => typeof line === 'string' && line !== '') : [];
			const preview = prompts.length > 0 ? prompts[prompts.length - 1] : '';
			const cwd = basenameOf(entry?.cwd);
			const size = formatBytes(entry?.sizeBytes);
			const sessionId = typeof entry?.sessionId === 'string' ? entry.sessionId : '';
			return h(
				'li',
				{ className: 'dc_row', 'data-dc': 'session' },
				button(
					'dc_rowOpen',
					[
						span(
							'dc_rowTop',
							span('dc_rowTitle', title, { title }),
							entry?.live === true ? span('dc_badge dc_badgeLive', t('live')) : null,
							taskChips(entry, t).map((chip) => span('dc_chip', chip.text, { key: chip.key })),
						),
						span(
							'dc_rowMeta',
							span(null, formatRelativeTime(entry?.updatedAt, t)),
							span('dc_mono', shortOf(sessionId, 14), { title: sessionId }),
							span(null, t('eventCount').replace('{n}', String(count(entry?.eventCount)))),
							cwd === '' ? null : span('dc_mono', cwd, { title: entry?.cwd }),
							size === '' ? null : span(null, size),
						),
						preview === '' ? null : span('dc_rowPreview', preview),
					],
					() => onOpen(entry),
					{ title: t('openReader'), 'aria-label': `${t('openReader')}: ${title}` },
				),
			);
		}

		/** One turn of the transcript; tool turns collapse, every turn keeps its role. */
		function Turn({ turn, t, open, onToggle }) {
			const role = typeof turn?.role === 'string' ? turn.role : 'system';
			const time = span('dc_turnTime', formatRelativeTime(turn?.time, t));
			if (role !== 'tool') {
				return h(
					'li',
					{ className: `dc_turn dc_turn_${role}`, 'data-dc': 'turn' },
					span('dc_turnHead', span('dc_turnRole', t(oneOf(ROLE_KEYS, role, 'roleSystem'))), time),
					pre('dc_turnBody', turnText(turn)),
				);
			}
			const name = typeof turn?.toolName === 'string' && turn.toolName !== '' ? t('toolName').replace('{name}', turn.toolName) : '';
			return h(
				'li',
				{ className: cx('dc_turn dc_turnTool', turn?.isError === true && 'dc_turnError'), 'data-dc': 'turn' },
				button(
					'dc_turnHead',
					[span('dc_turnRole', t('roleTool')), name === '' ? null : span('dc_mono dc_turnToolName', name), time, span('dc_turnChevron', open ? '▾' : '▸')],
					() => onToggle(),
					{ 'aria-expanded': open ? 'true' : 'false', title: open ? t('collapseTurn') : t('expandTurn') },
				),
				// A transcript is mostly tool noise, so the body waits for a click.
				open ? pre('dc_turnBody', turnText(turn)) : null,
			);
		}

		/**
		 * The reader: the session's title, its full transcript, and the composer
		 * that hands a prompt to the machine owning the conversation.
		 */
		function ReaderView({ t, state, onBack, onSend }) {
			// One open/closed flag per turn key, so collapsing is per tool call.
			const [openTools, setOpenTools] = React.useState({});
			const [draft, setDraft] = React.useState('');
			const history = state.history !== null && typeof state.history === 'object' ? state.history : null;
			const reader = state.reader !== null && typeof state.reader === 'object' ? state.reader : null;
			const owner = reader === null ? '' : reader.deviceId;
			const online = owner !== '' && isDeviceOnline(owner, state.self, state.peers);
			const ownerName = owner === ''
				? ''
				: owner === state.self?.deviceId
					? (typeof state.self?.name === 'string' && state.self.name !== '' ? state.self.name : t('thisDevice'))
					: (peerMap(state.peers).get(owner)?.name ?? owner);
			const title = typeof history?.title === 'string' && history.title !== '' ? history.title : t('nameFallback');
			const transcript = Array.isArray(history?.transcript) ? history.transcript : [];
			const busy = state.pending === true;
			// The confirmation is transient: it disappears on its own timer.
			const sent = state.sent !== null && typeof state.sent === 'object' && Date.now() - Number(state.sent.at ?? 0) < SENT_MS ? state.sent : null;
			const sessionId = typeof reader?.sessionId === 'string' ? reader.sessionId : '';
			const offlineNote = t('composerOffline').replace('{name}', ownerName);
			const composed = async (mode, reset) => {
				const accepted = await onSend(draft, mode);
				if (accepted === true) reset();
			};
			const body = state.historyStatus === 'loading'
				? div('dc_loading', t('readerLoading'))
				: state.historyStatus === 'error'
					? div('dc_errorText', `${t('readerError')} · ${state.historyError ?? ''}`)
					: transcript.length === 0
						? div('dc_empty', t('readerEmpty'))
						: list('dc_turns', 'transcript', transcript.map((turn, index) => {
							const key = `turn:${turn?.seq ?? index}`;
							return el(Turn, {
								key,
								turn,
								t,
								open: openTools[key] === true,
								onToggle: () => setOpenTools((current) => ({ ...current, [key]: current[key] !== true })),
							});
						}));
			return h(
				'section',
				{ className: 'dc_reader', 'data-dc': 'reader' },
				h(
					'header',
					{ className: 'dc_readerHead' },
					button('dc_ghost', `← ${t('back')}`, () => onBack()),
					span(
						'dc_readerHeadText',
						span('dc_readerTitle', title, { title }),
						span(
							'dc_readerMeta',
							span(null, ownerName),
							span('dc_mono', shortOf(sessionId, 18), { title: sessionId }),
							history === null ? null : span(null, t('readerEvents').replace('{n}', String(count(history.eventCount ?? transcript.length)))),
							history === null ? null : span(null, history.fromCache === true ? t('readerFromCache') : t('readerFetched')),
						),
					),
				),
				div('dc_scroll', body),
				div(
					'dc_composer',
					h('textarea', {
						className: 'dc_textarea', value: draft, rows: 3, disabled: !online,
						placeholder: online ? t('composerPlaceholder') : offlineNote,
						'aria-label': t('composerPlaceholder'),
						onChange: (event) => setDraft(event.target.value),
					}),
					div(
						'dc_composerRow',
						span('dc_fieldHint', online ? t('composerHint') : offlineNote),
						span(
							'dc_composerActions',
							sent === null ? null : span('dc_sent', sent.text, { role: 'status' }),
							button('dc_ghost', t('steer'), () => void composed('steer', () => setDraft('')), { disabled: !online || busy || draft.trim() === '' }),
							button('dc_primary', busy ? t('sending') : t('send'), () => void composed('queue', () => setDraft('')), { disabled: !online || busy || draft.trim() === '' }),
						),
					),
				),
			);
		}

		/** The panel's actual render. Kept separate so `Panel` can contain a throw. */
		function PanelBody(props) {
			const { t, store } = props;
			/**
			 * The actions arrive either nested (the offline check passes
			 * `{ actions }`) or spread flat onto the props, which is what the slot's
			 * `inject` produces. Accepting both keeps one component working in both.
			 */
			const actions = props.actions ?? props;
			/** `useStore` is optional so the offline check can pass a plain store. */
			const state = props.useStore !== undefined ? props.useStore((snapshot) => snapshot) : useSnapshot(store);

			/**
			 * Poll the Host while the panel is mounted and the page is visible.
			 * Both guards matter: an unmounted panel must not keep a timer alive,
			 * and a hidden page must not keep waking the Host — the visibility
			 * listener refreshes once on the way back instead.
			 */
			React.useEffect(() => {
				if (typeof document === 'undefined') return undefined;
				let timer = null;
				const tick = () => {
					if (document.visibilityState === 'visible') void actions.load(true);
				};
				const onVisible = () => {
					if (document.visibilityState === 'visible') tick();
				};
				if (typeof window !== 'undefined' && typeof window.setInterval === 'function') timer = window.setInterval(tick, POLL_MS);
				document.addEventListener('visibilitychange', onVisible);
				return () => {
					if (timer !== null && typeof window !== 'undefined') window.clearInterval(timer);
					document.removeEventListener('visibilitychange', onVisible);
				};
			}, [actions]);

			/** The first read, and a fresh read whenever the panel remounts. */
			React.useEffect(() => {
				void actions.load(false);
			}, [actions]);

			/** Retire the "sent" confirmation without waiting for the next poll. */
			React.useEffect(() => {
				if (state.sent === null || typeof window === 'undefined' || typeof window.setTimeout !== 'function') return undefined;
				const timer = window.setTimeout(() => store.update((draft) => { draft.sent = null; }), SENT_MS);
				return () => window.clearTimeout(timer);
			}, [state.sent, store]);

			const self = state.self !== null && typeof state.self === 'object' ? state.self : null;
			const pills = connectionState(self, state.pending === true, state.status !== 'loading');
			const relayUrl = typeof self?.relayUrl === 'string' && self.relayUrl !== '' ? self.relayUrl : t('relayUnset');
			const fingerprint = typeof self?.fingerprint === 'string' ? self.fingerprint : '';
			// A machine with no name of its own still needs a label in the header.
			const deviceName = typeof self?.name === 'string' && self.name !== '' ? self.name : t('thisDevice');
			const sessions = Array.isArray(state.sessions) ? state.sessions : [];
			const peers = Array.isArray(state.peers) ? state.peers : [];
			const stats = state.stats !== null && typeof state.stats === 'object' ? state.stats : null;
			const groups = useMemo(() => sessionGroups(sessions, self, peers), [sessions, self, peers]);
			// The empty state is the honest answer to "there is nothing to show":
			// no relay configured AND nothing ever arrived. A configured but silent
			// relay keeps the lists, which carry their own "nothing here yet" lines.
			const unconfigured = state.status === 'ready' && String(self?.relayUrl ?? '') === '' && peers.length === 0 && sessions.length === 0;

			const header = h(
				'header',
				{ className: 'dc_head', 'data-window-drag': true },
				div(
					'dc_headMain',
					h('h1', { className: 'dc_title' }, t('title')),
					span(
						'dc_headFacts',
						el(Fact, { label: t('thisDevice'), value: deviceName }),
						el(Fact, { label: t('relay'), value: relayUrl, title: String(self?.relayUrl ?? '') }),
						el(Fact, { label: t('fingerprint'), value: fingerprint === '' ? '—' : shortOf(fingerprint, 24), title: fingerprint, mono: true }),
					),
					el(StatusPill, { state: pills, t }),
				),
				div(
					'dc_headActions',
					button('dc_ghost', t('reconnect'), () => void actions.reconnect(), { disabled: state.pending === true }),
					button(cx('dc_ghost', state.view === 'settings' && 'dc_ghostOn'), state.view === 'settings' ? t('close') : t('settings'), () => actions.toggleSettings()),
					button(
						'dc_iconBtn',
						svg(
							'svg',
							{ width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
							svg('path', { d: 'M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.6v4h-4', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }),
						),
						() => void actions.load(false),
						{ title: t('refresh'), 'aria-label': t('refresh') },
					),
				),
			);
			const errorLine = state.error === null
				? null
				: div(
					'dc_notice dc_noticeError',
					span('dc_errorText', `${t('errorLoad')} · ${state.error}`),
					button('dc_link', t('retry'), () => void actions.load(false)),
				);
			const settings = el(SettingsSection, { t, self, pending: state.pending === true, onSave: (patch) => void actions.configure(patch) });
			const groupsView = groups.map((group) => h(
				'section',
				{ className: 'dc_section', key: `group:${group.deviceId}`, 'data-dc': 'group' },
				h(
					'h2',
					{ className: 'dc_sectionTitle' },
					group.isRemote ? group.name : `${t('thisDevice')} · ${group.name}`,
					span(cx('dc_badge', group.online && 'dc_badgeOk'), group.online ? t('online') : t('offline')),
					span('dc_sectionCount', String(group.sessions.length)),
				),
				group.sessions.length === 0
					? para('dc_empty', t('groupEmpty'))
					: list('dc_rows', null, group.sessions.map((entry) => el(SessionRow, {
						key: `row:${group.deviceId}:${entry?.sessionId ?? ''}`,
						entry,
						t,
						onOpen: actions.openReader,
					}))),
			));

			if (state.view === 'reader') {
				return h('section', { className: 'dc_root', 'data-dc': 'panel' }, header, errorLine, el(ReaderView, { t, state, onBack: actions.closeReader, onSend: actions.sendPrompt }));
			}
			if (state.status === 'loading' && self === null) {
				return h('section', { className: 'dc_root', 'data-dc': 'panel' }, header, errorLine, div('dc_loading', t('loading')));
			}
			if (unconfigured) {
				return h(
					'section',
					{ className: 'dc_root', 'data-dc': 'panel' },
					header,
					errorLine,
					div(
						'dc_scroll',
						div('dc_blank', h('h2', { className: 'dc_blankTitle' }, t('unconfiguredTitle')), para('dc_blankBody', t('unconfiguredBody')), para('dc_note', t('subtitle'))),
						settings,
					),
				);
			}
			return h(
				'section',
				{ className: 'dc_root', 'data-dc': 'panel' },
				header,
				errorLine,
				div(
					'dc_scroll',
					stats === null ? null : para('dc_note', t('statsLine')
						.replace('{local}', String(count(stats.local)))
						.replace('{remote}', String(count(stats.remote)))
						.replace('{peers}', String(count(stats.peers ?? peers.length)))),
					state.view === 'settings' ? settings : null,
					h(
						'section',
						{ className: 'dc_section' },
						h('h2', { className: 'dc_sectionTitle' }, t('devices'), span('dc_sectionCount', String(peers.length))),
						peers.length === 0
							? para('dc_empty', t('devicesEmpty'))
							: list('dc_devices', 'devices', peers.map((peer) => el(DeviceCard, { key: String(peer?.deviceId ?? ''), peer, t }))),
					),
					h(
						'section',
						{ className: 'dc_section' },
						h('h2', { className: 'dc_sectionTitle' }, t('sessions'), span('dc_sectionCount', String(sessions.length))),
						sessions.length === 0 ? para('dc_empty', t('sessionsEmpty')) : groupsView,
					),
				),
			);
		}

		/**
		 * What the panel shows when it cannot render at all. Dependency-free on
		 * purpose: literal text and inline styles, so a broken dictionary, a missing
		 * service or a malformed reply cannot turn "the panel failed" into "the app
		 * is empty".
		 */
		function renderFailure(error) {
			const message = error instanceof Error ? `${error.message}` : String(error);
			try {
				globalThis.console?.error?.(`[${PKG}] panel render failed: ${message}`);
			} catch {
				/* logging must never throw */
			}
			return element(
				'section',
				'dc_root',
				div(
					'dc_notice dc_noticeError',
					span('dc_errorText', `Deep Connect 渲染出错 · ${message}`),
					span('dc_errorText', '这一段是本插件自报的错误；应用其余部分不受影响，把这一行连同控制台报错一起反馈即可。'),
				),
				{ 'data-dc': 'panel' },
			);
		}

		/** The plain wrapper: one render attempt, the failure notice on a throw. */
		function PanelShell(props) {
			try {
				return PanelBody(props);
			} catch (error) {
				return renderFailure(error);
			}
		}

		/**
		 * A React error boundary is a class component, and only a boundary catches a
		 * throw raised *inside React's own render* (a `try` around a render call
		 * cannot). The offline stub has no class components, so the boundary is built
		 * only where they exist and {@link PanelShell} covers the rest.
		 */
		const PanelBoundary = typeof React.Component === 'function'
			? class DeepConnectBoundary extends React.Component {
				constructor(props) {
					super(props);
					this.state = { error: null };
				}
				static getDerivedStateFromError(error) {
					return { error };
				}
				componentDidCatch(error) {
					try {
						globalThis.console?.error?.(`[${PKG}] panel render failed: ${error instanceof Error ? error.message : String(error)}`);
					} catch {
						/* logging must never throw */
					}
				}
				render() {
					return this.state.error === null
						? React.createElement(PanelBody, this.props)
						: renderFailure(this.state.error);
				}
			}
			: null;

		/** The Deep Connect panel: header, settings, devices, sessions, reader. */
		function Panel(props) {
			return PanelBoundary === null ? PanelShell(props) : React.createElement(PanelBoundary, props);
		}

		/**
		 * Sidebar icon: a globe with a link arc across it, sized by the sidebar.
		 * @param props - the sidebar's `size` and `active` flag.
		 */
		function PanelIcon({ size, active }) {
			const edge = Number.isFinite(size) && size > 0 ? size : 20;
			const width = active === true ? 1.7 : 1.4;
			return svg(
				'svg',
				{ width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
				// The globe: one circle, a meridian, and the equator.
				svg('circle', { cx: 12, cy: 12, r: 8.4, stroke: 'currentColor', strokeWidth: width }),
				svg('path', { d: 'M3.6 12h16.8M12 3.6c2.4 2.4 3.6 5.3 3.6 8.4S14.4 18 12 20.4C9.6 18 8.4 15.1 8.4 12S9.6 6 12 3.6Z', stroke: 'currentColor', strokeWidth: width * 0.8, strokeLinecap: 'round' }),
				// The link: two interlocking arcs, so the glyph reads as "connected".
				svg('path', { d: 'M14.6 16.9a3.1 3.1 0 0 1 0-4.4l1.7-1.7a3.1 3.1 0 0 1 4.4 4.4l-.6.6M9.4 7.1a3.1 3.1 0 0 1 0 4.4l-1.7 1.7a3.1 3.1 0 0 1-4.4-4.4l.6-.6', stroke: 'currentColor', strokeWidth: width, strokeLinecap: 'round' }),
			);
		}
		//#endregion

		//#region styles
		/**
		 * Every rule this panel owns, in one string. Colors are theme tokens only,
		 * so both themes and any future accent follow the app for free. All class
		 * names carry the `dc_` prefix to keep them out of anyone else's way.
		 */
		const css = [
			// Root and header.
			'.dc_root{box-sizing:border-box;height:100%;min-height:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);flex-direction:column;display:flex;position:relative}.dc_root *{box-sizing:border-box}.dc_head{flex:none;justify-content:space-between;align-items:flex-start;gap:12px;padding:14px 20px 10px;display:flex}[data-platform=darwin] .dc_head{padding-top:calc(14px + var(--dsh-frame-top-clearance,0px))}',
			'.dc_headMain{flex-direction:column;gap:4px;min-width:0;display:flex}.dc_title{margin:0;font-size:14px;font-weight:500;line-height:20px}.dc_headFacts{align-items:center;gap:14px;flex-wrap:wrap;display:flex}.dc_fact{align-items:baseline;gap:5px;min-width:0;display:flex}',
			'.dc_factLabel{color:var(--dsw-alias-label-caption);flex:none;font-size:11px;line-height:16px}.dc_factValue{color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;max-width:32vw;font-size:11px;line-height:16px;overflow:hidden}.dc_mono{font-family:var(--ds-font-family-code,monospace);font-variant-numeric:tabular-nums}.dc_headActions{-webkit-app-region:no-drag;align-items:center;gap:8px;flex:none;display:flex}',
			// Buttons and links.
			'.dc_ghost{height:28px;padding:0 12px;border-radius:var(--dsw-radius-lg);border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0;font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}.dc_ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dc_ghost:disabled{cursor:default;opacity:.45}.dc_ghostOn{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}',
			'.dc_primary{height:28px;padding:0 14px;border-radius:var(--dsw-radius-lg);border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);font:inherit;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap}.dc_primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-button-primary-fill))}.dc_primary:disabled{cursor:default;opacity:.45}.dc_iconBtn{border:0;border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;justify-content:center;align-items:center;width:28px;height:28px;padding:0;display:flex}',
			'.dc_iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.dc_link{color:var(--dsw-alias-link,var(--dsw-alias-label-tertiary));cursor:pointer;background:0 0;border:0;border-radius:var(--dsw-radius-sm);padding:2px 4px;font:inherit;font-size:12px;line-height:18px}.dc_link:hover{background:var(--dsw-alias-interactive-bg-hover)}',
			// The connection dot: green / amber / red / grey.
			'.dc_dot{border-radius:999px;background:var(--dsw-alias-bg-layer-2);align-items:center;gap:6px;width:fit-content;padding:2px 10px 2px 8px;display:flex}.dc_dotCore{border-radius:999px;flex:none;width:8px;height:8px;background:var(--dsw-alias-label-caption)}.dc_dotLabel{font-size:11.5px;line-height:16px}.dc_dot_connected .dc_dotCore{background:var(--dsw-alias-state-success-primary)}',
			'.dc_dot_connected .dc_dotLabel{color:var(--dsw-alias-state-success-primary)}.dc_dot_connecting .dc_dotCore{background:var(--dsw-alias-state-warn-primary);animation:dc_pulse 1.4s ease-in-out infinite}.dc_dot_connecting .dc_dotLabel{color:var(--dsw-alias-state-warn-primary)}.dc_dot_offline .dc_dotCore{background:var(--dsw-alias-state-error-primary)}',
			'.dc_dot_offline .dc_dotLabel{color:var(--dsw-alias-state-error-primary)}.dc_dot_unconfigured .dc_dotCore{background:var(--dsw-alias-label-caption)}.dc_dot_unconfigured .dc_dotLabel{color:var(--dsw-alias-label-caption)}@keyframes dc_pulse{0%,100%{opacity:1}50%{opacity:.35}}',
			'@media (prefers-reduced-motion:reduce){.dc_dot_connecting .dc_dotCore{animation:none}}',
			// Notices, empty states, and section scaffolding.
			'.dc_notice{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);align-items:center;gap:8px;margin:0 20px 8px;padding:8px 12px;font-size:12px;line-height:18px;display:flex}.dc_noticeError{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}.dc_errorText{word-break:break-word}.dc_scroll{flex:1;min-height:0;flex-direction:column;gap:16px;padding:6px 20px 20px;display:flex;overflow-y:auto}',
			'.dc_loading,.dc_empty{color:var(--dsw-alias-label-caption);padding:18px 4px;font-size:13px;line-height:20px}.dc_note{color:var(--dsw-alias-label-caption);margin:0;font-size:12px;line-height:18px}.dc_noteStrong{color:var(--dsw-alias-label-tertiary)}.dc_blank{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:8px;max-width:720px;padding:18px 20px;display:flex}',
			'.dc_blankTitle{margin:0;font-size:14px;font-weight:500;line-height:20px}.dc_blankBody{color:var(--dsw-alias-label-secondary);margin:0;font-size:13px;line-height:21px}.dc_section{flex-direction:column;gap:8px;display:flex}.dc_sectionTitle{color:var(--dsw-alias-label-secondary);align-items:center;gap:8px;margin:0;font-size:12px;font-weight:500;line-height:18px;display:flex}',
			'.dc_sectionCount{color:var(--dsw-alias-label-caption);font-size:11px;font-variant-numeric:tabular-nums}.dc_devices,.dc_rows,.dc_turns{flex-direction:column;gap:6px;margin:0;padding:0;list-style:none;display:flex}',
			// Device cards and their badges.
			'.dc_device{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:3px;padding:9px 12px;display:flex}.dc_deviceOnline{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 30%,var(--dsw-alias-border-l1))}.dc_deviceTop{align-items:center;gap:8px;min-width:0;display:flex}.dc_deviceName{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:13px;line-height:18px;overflow:hidden}',
			'.dc_deviceMeta{color:var(--dsw-alias-label-caption);align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;line-height:16px;display:flex}.dc_fingerprint{color:var(--dsw-alias-label-tertiary);word-break:break-all}.dc_badge{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);flex:none;padding:0 6px;font-size:11px;line-height:18px}.dc_badgeOk{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}',
			'.dc_badgeLive{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent)}.dc_chip{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-tertiary);flex:none;padding:0 6px;font-size:10.5px;line-height:17px}',
			// Session rows.
			'.dc_row{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);display:flex}.dc_row:hover{background:var(--dsw-alias-interactive-bg-hover)}.dc_rowOpen{text-align:left;background:0 0;border:0;flex-direction:column;flex:1;gap:3px;min-width:0;padding:8px 12px;font:inherit;cursor:pointer;display:flex}.dc_rowTop{align-items:center;gap:8px;min-width:0;display:flex}',
			'.dc_rowTitle{color:var(--dsw-alias-label-primary);text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-size:13px;line-height:18px;overflow:hidden}.dc_rowMeta{color:var(--dsw-alias-label-caption);align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;line-height:16px;display:flex}.dc_rowPreview{color:var(--dsw-alias-label-tertiary);text-overflow:ellipsis;white-space:nowrap;max-width:100%;font-size:11.5px;line-height:16px;overflow:hidden}',
			// The settings form.
			'.dc_settings{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill,var(--dsw-alias-bg-layer-1));flex-direction:column;gap:12px;padding:14px 16px;display:flex}.dc_settingsGrid{flex-wrap:wrap;gap:12px;display:flex}.dc_field{flex-direction:column;gap:4px;flex:1 1 240px;min-width:0;display:flex}.dc_fieldLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}',
			'.dc_fieldHint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px}.dc_input{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);width:100%;outline:0;padding:6px 10px;font:inherit;font-size:13px;line-height:20px}.dc_input::placeholder{color:var(--dsw-alias-label-caption)}.dc_input:focus{border-color:var(--dsw-alias-border-l3)}',
			'.dc_settingsRow{align-items:flex-start;gap:16px;flex-wrap:wrap;display:flex}.dc_settingsRowEnd{justify-content:flex-end}.dc_check{align-items:flex-start;gap:8px;display:flex;cursor:pointer}.dc_check input{margin-top:3px;accent-color:var(--dsw-alias-brand-primary)}',
			'.dc_checkText{flex-direction:column;gap:1px;display:flex}.dc_checkLabel{color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px}',
			// The reader and its turns.
			'.dc_reader{flex-direction:column;flex:1;gap:10px;min-height:0;padding:0 20px 16px;display:flex}.dc_readerHead{align-items:flex-start;gap:10px;flex:none;display:flex}.dc_readerHeadText{flex-direction:column;gap:2px;min-width:0;display:flex}.dc_readerTitle{color:var(--dsw-alias-label-primary);font-size:13.5px;font-weight:500;line-height:19px;word-break:break-word}',
			'.dc_readerMeta{color:var(--dsw-alias-label-caption);align-items:center;gap:10px;flex-wrap:wrap;font-size:11px;line-height:16px;display:flex}.dc_turn{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);flex-direction:column;display:flex;overflow:hidden}.dc_turnHead{background:0 0;border:0;color:var(--dsw-alias-label-caption);align-items:center;gap:8px;width:100%;padding:6px 10px;font:inherit;font-size:11px;line-height:16px;display:flex;text-align:left}button.dc_turnHead{cursor:pointer}',
			'button.dc_turnHead:hover{background:var(--dsw-alias-interactive-bg-hover)}.dc_turnRole{color:var(--dsw-alias-label-secondary);font-weight:500}.dc_turnToolName{flex:1;min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.dc_turnTime{margin-left:auto;font-variant-numeric:tabular-nums}',
			'.dc_turnChevron{color:var(--dsw-alias-label-tertiary);flex:none;margin-left:4px}.dc_turnBody{color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;margin:0;padding:8px 12px 10px;font-family:var(--ds-font-family-code,monospace);font-size:11.5px;line-height:17px;max-height:340px;overflow:auto}.dc_turn_user{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,var(--dsw-alias-border-l1))}.dc_turn_user .dc_turnBody{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,transparent)}',
			'.dc_turn_assistant .dc_turnRole{color:var(--dsw-alias-brand-primary)}.dc_turnTool{background:var(--dsw-alias-bg-layer-2)}.dc_turnError{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,transparent)}.dc_turnError .dc_turnRole,.dc_turnError .dc_turnBody{color:var(--dsw-alias-state-error-primary)}',
			// The composer.
			'.dc_composer{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:8px;flex:none;padding:10px 12px;display:flex}.dc_textarea{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary);resize:vertical;width:100%;min-height:64px;outline:0;padding:7px 10px;font:inherit;font-size:13px;line-height:20px}.dc_textarea::placeholder{color:var(--dsw-alias-label-caption)}.dc_textarea:disabled{opacity:.55;cursor:not-allowed}',
			'.dc_textarea:focus{border-color:var(--dsw-alias-border-l3)}.dc_composerRow{justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;display:flex}.dc_composerActions{align-items:center;gap:8px;flex:none;display:flex}.dc_sent{color:var(--dsw-alias-state-success-primary);font-size:11.5px;line-height:16px}',
			'.dc_ghost:focus-visible,.dc_primary:focus-visible,.dc_link:focus-visible,.dc_iconBtn:focus-visible,.dc_rowOpen:focus-visible,.dc_turnHead:focus-visible,.dc_input:focus-visible,.dc_textarea:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}',
			'@media (max-width:720px){.dc_factValue{max-width:60vw}.dc_head{flex-wrap:wrap}}',
		].join('');
		//#endregion

		//#region plugin body
		/**
		 * Register the sidebar entry, its `main` view, its dictionaries and its
		 * styles. Never throws: a client entry that fails to activate is reported by
		 * the boot supervision and escalates to a fatal empty window, so a failure
		 * here registers the smallest possible seat instead.
		 * @param ctx - the browser plugin context.
		 */
		function apply(ctx) {
			try {
				registerPanel(ctx);
			} catch (error) {
				try {
					ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, () => renderFailure(error)));
				} catch {
					/* even the fallback seat is unavailable; there is nothing more to do */
				}
			}
		}

		/**
		 * The real registration path, kept separate so `apply` can contain its
		 * failure.
		 * @param ctx - the browser plugin context.
		 */
		function registerPanel(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'deep-connect: dictionaries');
			ctx.effect(() => {
				const selector = `style[data-plugin-css="${PKG}/deep-connect.css"]`;
				document.querySelector(selector)?.remove();
				const tag = document.createElement('style');
				tag.dataset.plugin = PKG;
				tag.dataset.pluginCss = `${PKG}/deep-connect.css`;
				tag.textContent = css;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, 'deep-connect: styles');
			const connector = createConnector(t);
			ctx.effect(() => () => connector.dispose(), 'deep-connect: connector');
			ctx.slots.inject('main', () => ctx.slots.register({
				name: 'main',
				key: PANEL_ID,
				locale: NS,
				inject: () => ({ store: connector.store, ...connector.actions }),
			}, Panel));
			ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
				name: 'sidebar.panellist',
				id: PANEL_ID,
				order: 0,
				label: () => t('panel'),
				locale: NS,
			}, PanelIcon));
		}
		//#endregion

		/** Helpers the offline check script drives directly; the page never reads them. */
		const internal = {
			PKG, NS, PANEL_ID, API_URL, POLL_MS, SENT_MS, zh, en, css,
			foldState, createStore: foldState, initialState,
			formatRelativeTime, formatBytes, basenameOf, shortOf, messageOf, turnText, taskChips, count,
			peerMap, isDeviceOnline, sessionGroups, connectionState, STATE_KEYS, ROLE_KEYS,
			createConnector, useSnapshot,
			StatusPill, Fact, Field, Toggle, SettingsSection, DeviceCard, SessionRow, Turn, ReaderView,
			Panel, PanelBody, PanelShell, renderFailure, PanelIcon,
			/** Element-layer seams, so the offline check can pin the props-bag rule. */
			element, div, span, svg, button, isPropsBag, renderable,
		};
		return { PKG, NS, PANEL_ID, inject, apply, internal };
	},
});
