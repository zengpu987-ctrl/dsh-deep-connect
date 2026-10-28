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
				/** Which device the workspace is showing; '' means this machine. */
				selectedDevice: '',
				/** The command being typed for another device. */
				taskDraft: '',
				/** Session/task search in the main pane. */
				query: '',
				/** The Workspace of the TARGET device this command should land in; '' = its default. */
				taskWorkspaceId: '',
				/** `provider\u0000model` chosen here for the target's run; '' = its default. */
				taskModelKey: '',
				/** Reasoning effort id for the chosen model; '' = the model's default. */
				taskEffort: '',
				/** This machine's routable models, for the model-strength picker. */
				modelCatalog: null,
				/** The reader's `{ deviceId, sessionId }`, or null. */
				reader: null,
				/** `dialogue` | `trajectory` in the reader. */
				readerPane: 'dialogue',
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

		/** Numeric semver comparison, mirrored from the Host so the gate is local. */
function compareVersions(a, b) {
	const parse = (value) => String(value).replace(/^v/i, '').split(/[-+.]/).map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));
	const left = parse(a);
	const right = parse(b);
	const length = Math.max(left.length, right.length);
	for (let index = 0; index < length; index += 1) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
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

		/** Flatten the Host's model catalog into picker rows. */
		function modelRows(catalog) {
			const rows = [];
			const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
			for (const group of groups) {
				for (const model of Array.isArray(group?.models) ? group.models : []) {
					const id = String(model?.id ?? '');
					const provider = String(group?.id ?? '');
					if (id === '' || provider === '') continue;
					rows.push({
						key: `${provider}\u0000${id}`,
						label: `${String(model?.name ?? id)} · ${String(group?.name ?? provider)}`,
						efforts: Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : [],
						defaultEffort: typeof model?.reasoning?.defaultEffort === 'string' ? model.reasoning.defaultEffort : '',
					});
				}
			}
			return rows;
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
			user: 'roleUser', assistant: 'roleAssistant', tool: 'roleTool', call: 'roleCall', developer: 'roleDeveloper', system: 'roleSystem',
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
			roleCall: '调用',
			roleSystem: '系统',
			roleDeveloper: '开发者',
			gateTitle: '此版本已封停',
			gateBody: 'v{current} 低于最低可用版本 v{min}，面板与互联功能已停用。请升级到最新版后再启动。',
			gateCommand: '升级命令',
			gateCopy: '复制命令',
			paneDialogue: '对话',
			paneTrajectory: '轨迹',
			paneEmptyDialogue: '这条对话还没有对话内容。',
			paneEmptyTrajectory: '这条对话还没有工具轨迹。',
			liveHint: '实时跟随对方进程',
			liveOn: '实时',
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
			inherit: '继承到本机',
			inheriting: '正在继承…',
			inheritedToast: '已继承为本机会话 {id}（{n} 条事件），刷新会话列表即可继续',
			inheritHint: '继承 = 把这条会话的完整事件复制成一条本机会话，用本机模型和工具接着干；原会话仍留在 {name} 上。',
			syncDone: '全文已同步 {n}/{m}',
			syncRunning: '正在同步全文…',
			updateInstall: '检查并更新',
			updating: '正在更新…',
			updatedRestart: '已更新到 v{version}，重启 Harness 后生效',
			upToDateAlready: '已是最新版本 v{version}',
			mobileTitle: '手机管理（微信扫码）',
			mobileEnable: '开启手机管理',
			mobileDisable: '关闭手机管理',
			mobileHint: '开启后本机提供一个手机管理页，用微信扫下面的二维码即可查看设备、任务并下发命令。',
			mobileQrHint: '二维码指向 {url}',
			mobilePublic: '公网可达（附件隧道）',
			mobileLanOnly: '仅同一局域网可扫',
			stationLeave: '退出中继站',
			stationLeaveHint: '退出后本机不再连接这个中继站，下次启动也不会自动加入。',
			proBadge: 'Pro',
			stationTitle: '中继站',
			stationIntro: '一台设备生成中继站，把链接发给其它设备，粘贴进来点「加入」即可互通。链接里带着邀请令牌，谁拿到链接谁就能加入。',
			stationGenerate: '一键生成中继站',
			stationGenerating: '正在生成中继站…（首次大约十几秒）',
			stationLink: '邀请链接',
			stationCopy: '复制链接',
			stationCopied: '已复制',
			stationPublic: '公网可达（Cloudflare 隧道）',
			stationLan: '仅同一局域网可加入（没找到 cloudflared）',
			stationHosted: '本机正在托管这个中继站',
			stationJoined: '已加入 {url}',
			stationStop: '停止中继站',
			stationStopped: '中继站已停止',
			stationJoinTitle: '加入别人的中继站',
			stationJoinPlaceholder: '把另一台设备生成的链接粘贴到这里',
			stationJoin: '加入',
			stationJoining: '正在加入…',
			stationHint: '链接就是邀请：请通过可信渠道发送，拿到链接的人都能加入。',
			updateTitle: '版本更新',
			updateAvailable: '有新版本 v{latest}（当前 v{current}）',
			updateCommand: '升级命令',
			updateCheck: '检查更新',
			updateChecking: '正在检查…',
			updateUpToDate: '已是最新版本 v{current}',
			updateUnknown: '暂时无法检查更新（{error}）',
			updateCopy: '复制命令',
			railTitle: '设备',
			railHint: '点设备卡片查看它上面的任务；开关控制本机是否把对话正文共享给中继站。',
			memoryShare: '记忆共享',
			memoryOff: '未共享',
			memoryOnHint: '本机对话正文会同步给同站设备，并允许它们继承。',
			memoryOffHint: '只广播标题与任务计数，对端拉不到正文，也无法继承。',
			tasksTitle: '任务与状态',
			noTasks: '这台设备没有任务记录。',
			taskOpen: '待办 {n}',
			taskDone: '完成 {n}',
			taskGoal: '目标 {n}',
			taskTeam: '团队 {n}',
			deviceCommand: '给这台设备发命令',
			deviceCommandPlaceholder: '例如：跑一下昨天的数据统计，把结果放在桌面',
			deviceCommandHint: '命令会在那台设备的指定工作区里新建一条会话执行；工作区和模型强度都由本机选。',
			deviceCommandSend: '下发',
			commandWorkspace: '对端工作区',
			commandWorkspaceHint: '命令落在这台设备的这个工作区；「默认」用它的默认目录。',
			commandWorkspaceDefault: '默认（对端默认目录）',
			commandWorkspaceDefaultTag: '默认',
			commandModel: '模型强度',
			commandModelHint: '模型强度由本机决定：要求对端按这个模型执行；「默认」用对端自己的模型。',
			commandModelDefault: '默认（对端自己的模型）',
			commandEffort: '思考强度',
			commandEffortDefault: '模型默认',
			taskSent: '命令已下发，对方正在执行',
			inheritRow: '继承到本机',
			relayTask: '接力到本机',
			taskContent: '任务内容',
			taskRelayed: '已继承到本机会话 {id}',
			taskRelayedRunning: '已接力到本机会话 {id}，正在本机执行',
			taskRelayedRunFailed: '已接力到本机会话 {id}，但本机启动执行失败：{error}',
			taskMore: '还有 {n} 项',
			deviceSessions: '会话 {n}',
			selectDevice: '选择左侧设备查看任务',
			allDevices: '全部设备',
			searchPlaceholder: '搜索会话、任务或提示词…',
			searchEmpty: '没有匹配的会话。',
			searchCount: '{n}/{m} 条',
			devOpenTasks: '{n} 项待办',
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
			unconfiguredTitle: '还没有中继站',
			unconfiguredBody: '在一台设备上点「一键生成中继站」，把生成的链接复制到另一台设备的「加入别人的中继站」里，两边就会出现在同一个中继站里。链接就是邀请：请通过可信渠道发送，拿到链接的人都能加入。',
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
			roleCall: 'Call',
			roleSystem: 'System',
			roleDeveloper: 'Developer',
			gateTitle: 'This version is sealed',
			gateBody: 'v{current} is below the minimum v{min}; the panel and interconnect are disabled. Upgrade before starting again.',
			gateCommand: 'Upgrade command',
			gateCopy: 'Copy command',
			paneDialogue: 'Dialogue',
			paneTrajectory: 'Trajectory',
			paneEmptyDialogue: 'No dialogue yet.',
			paneEmptyTrajectory: 'No tool trajectory yet.',
			liveHint: 'Follow the peer in real time',
			liveOn: 'Live',
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
			inherit: 'Inherit here',
			inheriting: 'Inheriting…',
			inheritedToast: 'Inherited as local session {id} ({n} events) — refresh the session list to continue it',
			inheritHint: 'Inherit copies this conversation’s full event log into a new local session so this machine’s model and tools continue the work; the original stays on {name}.',
			syncDone: 'Bodies synced {n}/{m}',
			syncRunning: 'Syncing conversation bodies…',
			updateInstall: 'Check and update',
			updating: 'Updating…',
			updatedRestart: 'Updated to v{version}; restart Harness to apply',
			upToDateAlready: 'Already up to date (v{version})',
			mobileTitle: 'Phone access (WeChat QR)',
			mobileEnable: 'Enable phone access',
			mobileDisable: 'Disable phone access',
			mobileHint: 'Enables a small management page for phones; scan the QR with WeChat to see devices and tasks and to send commands.',
			mobileQrHint: 'The QR points at {url}',
			mobilePublic: 'Publicly reachable (extra tunnel)',
			mobileLanOnly: 'LAN only',
			stationLeave: 'Leave station',
			stationLeaveHint: 'Leaves this station; it will not rejoin automatically on the next start.',
			proBadge: 'Pro',
			stationTitle: 'Relay station',
			stationIntro: 'One device creates a station and sends the link; every other device pastes it and clicks Join. The invite token lives in the link, so whoever holds the link can join.',
			stationGenerate: 'Create a relay station',
			stationGenerating: 'Creating the station… (about ten seconds)',
			stationLink: 'Invite link',
			stationCopy: 'Copy link',
			stationCopied: 'Copied',
			stationPublic: 'Reachable from anywhere (Cloudflare tunnel)',
			stationLan: 'LAN only (cloudflared not found)',
			stationHosted: 'This machine is hosting the station',
			stationJoined: 'Joined {url}',
			stationStop: 'Stop station',
			stationStopped: 'Station stopped',
			stationJoinTitle: 'Join a station',
			stationJoinPlaceholder: 'Paste the link another device generated',
			stationJoin: 'Join',
			stationJoining: 'Joining…',
			stationHint: 'The link is the invitation: send it over a channel you trust; anyone with it can join.',
			updateTitle: 'Updates',
			updateAvailable: 'v{latest} is available (you have v{current})',
			updateCommand: 'Upgrade command',
			updateCheck: 'Check for updates',
			updateChecking: 'Checking…',
			updateUpToDate: 'Up to date (v{current})',
			updateUnknown: 'Could not check for updates ({error})',
			updateCopy: 'Copy command',
			railTitle: 'Devices',
			railHint: 'Pick a device to see its tasks; the switch controls whether this machine shares conversation bodies with the station.',
			memoryShare: 'Share memory',
			memoryOff: 'not shared',
			memoryOnHint: 'This machine shares conversation bodies and allows inheritance.',
			memoryOffHint: 'Only titles and task counts are broadcast; peers cannot fetch bodies or inherit.',
			tasksTitle: 'Tasks and status',
			noTasks: 'This device has no task records.',
			taskOpen: '{n} open',
			taskDone: '{n} done',
			taskGoal: '{n} goals',
			taskTeam: '{n} team',
			deviceCommand: 'Send a command to this device',
			deviceCommandPlaceholder: 'e.g. run yesterday’s stats and drop the results on the Desktop',
			deviceCommandHint: 'The command creates a session in the workspace you pick ON THAT DEVICE; both the workspace and the model strength are chosen here.',
			deviceCommandSend: 'Send',
			commandWorkspace: 'Target workspace',
			commandWorkspaceHint: 'Where the command lands on that device; “default” is its own default directory.',
			commandWorkspaceDefault: 'Default (target’s own directory)',
			commandWorkspaceDefaultTag: 'default',
			commandModel: 'Model strength',
			commandModelHint: 'The model strength is decided here: that device is told to run with this model; “default” leaves it to the target.',
			commandModelDefault: 'Default (target’s own model)',
			commandEffort: 'Reasoning effort',
			commandEffortDefault: 'Model default',
			taskSent: 'Command delivered — the other machine is running it',
			inheritRow: 'Inherit here',
			relayTask: 'Relay here',
			taskContent: 'Task content',
			taskRelayed: 'Inherited as local session {id}',
			taskRelayedRunning: 'Relayed to local session {id} — running on this machine',
			taskRelayedRunFailed: 'Relayed to local session {id}, but starting it here failed: {error}',
			taskMore: '{n} more',
			deviceSessions: '{n} sessions',
			selectDevice: 'Pick a device on the left to see its tasks',
			allDevices: 'All devices',
			searchPlaceholder: 'Search sessions, tasks or prompts…',
			searchEmpty: 'No matching sessions.',
			searchCount: '{n}/{m}',
			devOpenTasks: '{n} open',
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
			unconfiguredTitle: 'No relay station yet',
			unconfiguredBody: 'On one device click “Create a relay station”, then paste the link into “Join a station” on the other device; both end up in the same station. The link is the invitation — send it over a channel you trust.',
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
					draft.version = typeof value.version === 'string' ? value.version : '';
					draft.minVersion = typeof value.minVersion === 'string' ? value.minVersion : '4.0.2';
					draft.station = value.station !== null && typeof value.station === 'object' ? value.station : null;
					draft.mobile = value.mobile !== null && typeof value.mobile === 'object' ? value.mobile : null;
					draft.update = value.update !== null && typeof value.update === 'object' ? value.update : null;
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
						// One catalog read per panel mount: the model-strength picker
						// needs this machine's routable models, and the Host caches it.
						if (!disposed && store.getSnapshot().modelCatalog === null) void loadModelCatalog();
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

			/**
			 * Read this machine's routable models once, for the "模型强度由本机决定"
			 * picker. A deployment with no catalog simply offers no override.
			 */
			async function loadModelCatalog() {
				try {
					const value = await request({ action: 'model-catalog' });
					if (disposed) return;
					store.update((draft) => {
						draft.modelCatalog = value !== null && typeof value === 'object' ? value : null;
						// "模型强度由本机决定" starts from THIS machine's own current
						// selection, not from whatever the target happens to use. The
						// empty option still means "leave it to the target".
						if (String(draft.taskModelKey ?? '') === '') {
							const selection = value?.default;
							const provider = String(selection?.provider ?? '');
							const model = String(selection?.model ?? '');
							if (provider !== '' && model !== '') draft.taskModelKey = `${provider}\u0000${model}`;
						}
						if (String(draft.taskEffort ?? '') === '' && typeof value?.default?.reasoningEffort === 'string') {
							draft.taskEffort = value.default.reasoningEffort;
						}
					});
				} catch {
					// The picker then falls back to "use the target's default".
				}
			}

			/** Split a `provider\u0000model` key back into a wire selection. */
			function selectionFromKey(key, effort) {
				const raw = String(key ?? '');
				const at = raw.indexOf('\u0000');
				if (at <= 0) return undefined;
				const provider = raw.slice(0, at);
				const model = raw.slice(at + 1);
				if (provider === '' || model === '') return undefined;
				const reasoningEffort = String(effort ?? '');
				return { provider, model, ...(reasoningEffort === '' ? {} : { reasoningEffort }) };
			}

			/** Ask the Host for one conversation's full transcript. */
			async function loadHistory(deviceId, sessionId, options = {}) {				if (disposed || typeof deviceId !== 'string' || deviceId === '' || typeof sessionId !== 'string' || sessionId === '') return;
				const silent = options.silent === true;
				if (!silent) {
					store.update((draft) => {
						draft.historyStatus = 'loading';
						draft.historyError = null;
						draft.history = null;
					});
				}
				try {
					const value = await request({ action: 'history', deviceId, sessionId, ...(options.fresh === true ? { fresh: true } : {}) });
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
					draft.readerPane = 'dialogue';
					draft.history = null;
					draft.historyStatus = 'loading';
					draft.historyError = null;
					draft.sent = null;
				});
				void loadHistory(deviceId, sessionId);
			}

			/** Refetch the open reader's transcript (used after a successful send). */
			function reloadHistory(fresh) {
				const reader = store.getSnapshot().reader;
				return reader === null ? Promise.resolve() : loadHistory(reader.deviceId, reader.sessionId, { fresh: fresh === true, silent: fresh === true });
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
				if (typeof patch?.shareMemory === 'boolean') body.shareMemory = patch.shareMemory;
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
						// The peer reports what it actually admitted: an interjection
						// that landed in the running turn and one that became the
						// next turn must never read the same.
						const effective = value?.mode === 'steer' ? 'steer' : 'queue';
						draft.sent = {
							text: effective === 'steer'
								? t('sentSteer')
								: t('sentQueue').replace('{name}', owner),
							mode: effective,
							at: Date.now(),
						};
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

			/**
			 * Inherit the open (remote) conversation as a new local session.
			 *
			 * The Host asks the owner for its raw event log and writes a fresh
			 * local session from it; the owner's conversation is untouched.
			 * @returns whether the Host created the local session.
			 */
			async function inheritSession() {
				const reader = store.getSnapshot().reader;
				if (reader === null) return false;
				store.update((draft) => {
					draft.pending = true;
					draft.error = null;
					draft.sent = null;
				});
				try {
					// "继承" is the copy half: keep the transcript here for reading and
					// manual continuation. Running the task here is "接力", below.
					const value = await request({ action: 'inherit', deviceId: reader.deviceId, sessionId: reader.sessionId, run: false });
					if (disposed) return false;
					const id = typeof value.sessionId === 'string' ? value.sessionId : '';
					store.update((draft) => {
						draft.pending = false;
						draft.sent = {
							text: t('inheritedToast').replace('{id}', shortOf(id, 22)).replace('{n}', String(count(value.eventCount ?? 0))),
							mode: 'system',
							at: Date.now(),
							inherited: id,
						};
					});
					// The new session is local; rebuild the merged view so it appears.
					await load(true);
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

			/** Focus one device in the workspace. */
			function selectDevice(deviceId) {
				store.update((draft) => { draft.selectedDevice = typeof deviceId === 'string' ? deviceId : ''; });
			}

			/**
			 * Send a work command to another machine's DSH.
			 *
			 * The Workspace and the model strength are the choices made HERE: the
			 * target runs the command in the picked workspace of its own machine
			 * and adopts the selected model, or the pickers' fallbacks.
			 */
			async function runTask(deviceId, text) {
				const body = typeof text === 'string' ? text.trim() : '';
				if (deviceId === '' || body === '') return false;
				const snapshot = store.getSnapshot();
				const workspaceId = String(snapshot.taskWorkspaceId ?? '');
				const model = selectionFromKey(snapshot.taskModelKey, snapshot.taskEffort);
				store.update((draft) => { draft.pending = true; draft.error = null; });
				try {
					const value = await request({
						action: 'task-run',
						deviceId,
						text: body,
						...(workspaceId === '' ? {} : { workspaceId }),
						...(model === undefined ? {} : { model }),
					});
					if (disposed) return false;
					const peer = peerMap(store.getSnapshot().peers).get(deviceId);
					const place = (peer?.workspaces ?? []).find((workspace) => workspace.id === value?.workspaceId);
					const applied = value?.model !== null && typeof value?.model === 'object' ? value.model : model;
					const detail = [
						place?.title ?? place?.path ?? (workspaceId === '' ? t('commandWorkspaceDefault') : ''),
						applied?.model ?? t('commandModelDefault'),
					].filter((part) => typeof part === 'string' && part !== '').join(' · ');
					store.update((draft) => {
						draft.pending = false;
						draft.sent = {
							text: detail === '' ? t('taskSent') : `${t('taskSent')} · ${detail}`,
							mode: 'system',
							at: Date.now(),
						};
					});
					await load(true);
					return typeof value?.sessionId === 'string';
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => { draft.pending = false; draft.error = messageOf(error, t); });
					return false;
				}
			}

			/**
			 * Inherit one remote session straight from its row, and (for "接力") run
			 * it on this machine.
			 * @param options.run - false copies only; true admits one prompt into the
			 *   new local session so this machine actually does the work.
			 */
			async function inheritRow(deviceId, sessionId, options = {}) {
				if (deviceId === '' || sessionId === '') return false;
				const run = options.run === true;
				store.update((draft) => { draft.pending = true; draft.error = null; });
				try {
					const value = await request({ action: 'inherit', deviceId, sessionId, run });
					if (disposed) return false;
					const localId = String(value?.sessionId ?? '');
					const runError = typeof value?.runError === 'string' ? value.runError : '';
					store.update((draft) => {
						draft.pending = false;
						draft.selectedDevice = draft.self?.deviceId ?? '';
						draft.sent = run
							? {
								text: runError === ''
									? t('taskRelayedRunning').replace('{id}', shortOf(localId, 22))
									: t('taskRelayedRunFailed').replace('{id}', shortOf(localId, 22)).replace('{error}', runError),
								mode: 'system',
								at: Date.now(),
							}
							: { text: t('taskRelayed').replace('{id}', shortOf(localId, 22)), mode: 'system', at: Date.now() };
						if (runError !== '') draft.error = runError;
					});
					await load(true);
					return true;
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => { draft.pending = false; draft.error = messageOf(error, t); });
					return false;
				}
			}

			/** Flip this machine's memory-sharing switch. */
			async function toggleMemory() {
				const current = store.getSnapshot().self?.shareMemory;
				return configure({ shareMemory: current !== true });
			}

			/** Check GitHub and install a newer release in place. */
			async function installUpdate() {
				store.update((draft) => { draft.pending = true; draft.error = null; });
				try {
					const value = await request({ action: 'update-install' });
					if (disposed) return false;
					store.update((draft) => {
						draft.pending = false;
						draft.sent = {
							text: value?.updated === true
								? t('updatedRestart').replace('{version}', String(value.version ?? ''))
								: t('upToDateAlready').replace('{version}', String(value?.version ?? '')),
							mode: 'system',
							at: Date.now(),
						};
					});
					await load(true);
					return true;
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => { draft.pending = false; draft.error = messageOf(error, t); });
					return false;
				}
			}

			/** Turn the phone page on or off. */
			async function toggleMobile(on) {
				store.update((draft) => { draft.pending = true; draft.error = null; });
				try {
					const value = await request({ action: on ? 'mobile-enable' : 'mobile-disable' });
					if (disposed) return false;
					const view = value.view !== null && typeof value.view === 'object' ? value.view : null;
					if (view !== null) publish(view);
					store.update((draft) => { draft.pending = false; });
					return true;
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => { draft.pending = false; draft.error = messageOf(error, t); });
					return false;
				}
			}

			/** Generate a station here, then adopt the returned view. */
			async function createStation() {
				store.update((draft) => { draft.pending = true; draft.error = null; });
				try {
					const value = await request({ action: 'station-create' });
					if (disposed) return false;
					const view = value.view !== null && typeof value.view === 'object' ? value.view : null;
					if (view !== null) publish(view);
					store.update((draft) => {
						draft.pending = false;
						draft.sent = { text: t('stationHosted'), mode: 'system', at: Date.now() };
					});
					return true;
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => { draft.pending = false; draft.error = messageOf(error, t); });
					return false;
				}
			}

			/** Join a station from a pasted invite link. */
			async function joinStation(link) {
				const text = typeof link === 'string' ? link.trim() : '';
				if (text === '') return false;
				store.update((draft) => { draft.pending = true; draft.error = null; });
				try {
					const value = await request({ action: 'station-join', link: text });
					if (disposed) return false;
					const view = value.view !== null && typeof value.view === 'object' ? value.view : null;
					if (view !== null) publish(view);
					const base = typeof value.station?.baseUrl === 'string' ? value.station.baseUrl : '';
					store.update((draft) => {
						draft.pending = false;
						draft.sent = { text: t('stationJoined').replace('{url}', base), mode: 'system', at: Date.now() };
					});
					return true;
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => { draft.pending = false; draft.error = messageOf(error, t); });
					return false;
				}
			}

			/** Stop hosting and go back to the unconfigured state. */
			async function stopStation() {
				store.update((draft) => { draft.pending = true; draft.error = null; });
				try {
					const value = await request({ action: 'station-stop' });
					if (disposed) return false;
					if (value !== null && typeof value === 'object') publish(value);
					store.update((draft) => {
						draft.pending = false;
						draft.sent = { text: t('stationStopped'), mode: 'system', at: Date.now() };
					});
					return true;
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => { draft.pending = false; draft.error = messageOf(error, t); });
					return false;
				}
			}

			/** Ask the Host to look for a newer release, then refresh the view. */
			async function checkUpdate(force) {
				store.update((draft) => { draft.pending = true; draft.error = null; });
				try {
					await request({ action: 'update-check', force: force === true });
					if (disposed) return false;
					store.update((draft) => { draft.pending = false; });
					await load(true);
					return true;
				} catch (error) {
					if (disposed) return false;
					store.update((draft) => { draft.pending = false; draft.error = messageOf(error, t); });
					return false;
				}
			}

			return {
				store,
				actions: { load, openReader, closeReader, reloadHistory, toggleSettings, configure, reconnect, sendPrompt, inheritSession, createStation, joinStation, stopStation, checkUpdate, selectDevice, runTask, inheritRow, toggleMemory, installUpdate, toggleMobile },
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
		function SettingsSection({ t, self, station, update, version, mobile, pending, onSave, onGenerate, onJoin, onStop, onCheckUpdate, onInstallUpdate, onToggleMobile, onLeaveStation }) {
			const [deviceName, setDeviceName] = React.useState(typeof self?.name === 'string' ? self.name : '');
			const [autoIndex, setAutoIndex] = React.useState(true);
			const [autoConnect, setAutoConnect] = React.useState(true);
			const [joinLink, setJoinLink] = React.useState('');
			const [copied, setCopied] = React.useState('');
			const fingerprint = typeof self?.fingerprint === 'string' ? self.fingerprint : '';
			const link = typeof station?.link === 'string' ? station.link : '';
			const role = typeof station?.role === 'string' ? station.role : '';
			const running = station?.running === true;
			const reach = station?.public === true ? t('stationPublic') : t('stationLan');
			const copy = async (text, key) => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(key);
				} catch {
					setCopied('');
				}
			};
			const updateOutdated = update?.outdated === true;
			return h(
				'section',
				{ className: 'dc_settings', 'data-dc': 'settings' },
				h('h2', { className: 'dc_sectionTitle' }, t('settingsTitle')),
				div(
					'dc_station',
					h('h3', { className: 'dc_stationTitle' }, t('stationTitle'), span('dc_badge', `v${version ?? ''}`, { title: t('proBadge') })),
					para('dc_fieldHint', t('stationIntro')),
					link === ''
						? button('dc_primary', pending ? t('stationGenerating') : t('stationGenerate'), () => void onGenerate(), { disabled: pending })
						: div(
							'dc_stationLink',
							span('dc_fieldLabel', t('stationLink')),
							h('input', { className: 'dc_input dc_mono', type: 'text', value: link, readOnly: true, 'aria-label': t('stationLink') }),
							div(
								'dc_stationRow',
								button('dc_ghost', copied === 'link' ? t('stationCopied') : t('stationCopy'), () => void copy(link, 'link')),
								role === 'host' && running ? button('dc_ghost', t('stationStop'), () => void onStop()) : null,
								link === '' ? null : button('dc_ghost', t('stationLeave'), () => void onLeaveStation(), { title: t('stationLeaveHint') }),
								span('dc_fieldHint', reach),
							),
						),
					link === '' ? para('dc_fieldHint', t('stationHint')) : null,
					h('h3', { className: 'dc_stationTitle' }, t('stationJoinTitle')),
					div(
						'dc_stationRow',
						h('input', {
							className: 'dc_input', type: 'text', value: joinLink,
							placeholder: t('stationJoinPlaceholder'), 'aria-label': t('stationJoinTitle'),
							onChange: (event) => setJoinLink(event.target.value),
						}),
						button('dc_primary', pending ? t('stationJoining') : t('stationJoin'), () => void onJoin(joinLink), { disabled: pending || joinLink.trim() === '' }),
					),
				),
				div('dc_settingsGrid', el(Field, { t, name: 'settingsDeviceName', hint: 'settingsDeviceNameHint', value: deviceName, onChange: setDeviceName })),
				div(
					'dc_settingsRow',
					el(Toggle, { t, name: 'settingsAutoIndex', hint: 'settingsAutoIndexHint', value: autoIndex, onChange: setAutoIndex }),
					el(Toggle, { t, name: 'settingsAutoConnect', hint: 'settingsAutoConnectHint', value: autoConnect, onChange: setAutoConnect }),
				),
				div('dc_settingsRow dc_settingsRowEnd', button('dc_primary', pending ? t('saving') : t('save'), () => onSave({ deviceName, autoIndex, autoConnect }), { disabled: pending })),
				h('h3', { className: 'dc_stationTitle' }, t('updateTitle')),
				updateOutdated
					? div(
						'dc_update',
						span('dc_updateText', t('updateAvailable').replace('{latest}', String(update?.latest ?? '')).replace('{current}', String(update?.current ?? version ?? ''))),
						span('dc_fieldLabel', t('updateCommand')),
						h('input', { className: 'dc_input dc_mono', type: 'text', value: String(update?.command ?? ''), readOnly: true }),
						div(
							'dc_stationRow',
							button('dc_ghost', copied === 'update' ? t('stationCopied') : t('updateCopy'), () => void copy(String(update?.command ?? ''), 'update')),
							button('dc_ghost', pending ? t('updating') : t('updateInstall'), () => void onInstallUpdate?.(), { disabled: pending }),
						),
					)
					: div(
						'dc_stationRow',
						span('dc_fieldHint', update?.error !== undefined && update?.error !== '' ? t('updateUnknown').replace('{error}', String(update.error)) : t('updateUpToDate').replace('{current}', String(update?.current ?? version ?? ''))),
						button('dc_ghost', pending ? t('updating') : t('updateInstall'), () => void onInstallUpdate?.(), { disabled: pending }),
					),
				h('h3', { className: 'dc_stationTitle' }, t('mobileTitle')),
				mobile?.enabled === true
					? div(
						'dc_mobile',
						h('img', {
							className: 'dc_qr',
							src: `https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(String(mobile.url ?? ''))}`,
							alt: t('mobileQrHint').replace('{url}', String(mobile.url ?? '')),
							width: 180, height: 180,
						}),
						h('input', { className: 'dc_input dc_mono', type: 'text', value: String(mobile.url ?? ''), readOnly: true, 'aria-label': t('mobileTitle') }),
						div(
							'dc_stationRow',
							span('dc_fieldHint', mobile.public === true ? t('mobilePublic') : t('mobileLanOnly')),
							button('dc_ghost', t('mobileDisable'), () => void onToggleMobile?.(false), { disabled: pending }),
						),
						span('dc_fieldHint', t('mobileHint')),
					)
					: div(
						'dc_stationRow',
						span('dc_fieldHint', t('mobileHint')),
						button('dc_ghost', t('mobileEnable'), () => void onToggleMobile?.(true), { disabled: pending }),
					),
				para('dc_note', t('settingsCipher')),
				h(
					'p',
					{ className: 'dc_note dc_noteStrong' },
					`${t('settingsNotice')} `,
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
		function SessionRow({ entry, t, onOpen, onInherit }) {
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
				typeof onInherit === 'function'
					? button('dc_rowAction', t('inheritRow'), () => onInherit(entry), { title: t('inheritHint') })
					: null,
			);
		}

		/** One turn of the transcript; tool turns collapse, every turn keeps its role. */
		function Turn({ turn, t, open, onToggle }) {
			const role = typeof turn?.role === 'string' ? turn.role : 'system';
			const time = span('dc_turnTime', formatRelativeTime(turn?.time, t));
			if (role !== 'tool' && role !== 'call') {
				return h(
					'li',
					{ className: `dc_turn dc_turn_${role}`, 'data-dc': 'turn' },
					span('dc_turnHead', span('dc_turnRole', t(oneOf(ROLE_KEYS, role, 'roleSystem'))), time),
					pre('dc_turnBody', turnText(turn)),
				);
			}
			const name = typeof turn?.toolName === 'string' && turn.toolName !== '' ? t('toolName').replace('{name}', turn.toolName) : '';
			const roleLabel = role === 'call' ? t('roleCall') : t('roleTool');
			return h(
				'li',
				{ className: cx('dc_turn dc_turnTool', turn?.isError === true && 'dc_turnError'), 'data-dc': 'turn' },
				button(
					'dc_turnHead',
					[span('dc_turnRole', roleLabel), name === '' ? null : span('dc_mono dc_turnToolName', name), time, span('dc_turnChevron', open ? '▾' : '▸')],
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
		function ReaderView({ t, state, onBack, onSend, onInherit, onPane }) {
			// One open/closed flag per turn key, so collapsing is per tool call.
			const [openTools, setOpenTools] = React.useState({});
			const [draft, setDraft] = React.useState('');
			const history = state.history !== null && typeof state.history === 'object' ? state.history : null;
			const reader = state.reader !== null && typeof state.reader === 'object' ? state.reader : null;
			const owner = reader === null ? '' : reader.deviceId;
			const online = owner !== '' && isDeviceOnline(owner, state.self, state.peers);
			const remote = owner !== '' && owner !== state.self?.deviceId;
			const ownerName = owner === ''
				? ''
				: owner === state.self?.deviceId
					? (typeof state.self?.name === 'string' && state.self.name !== '' ? state.self.name : t('thisDevice'))
					: (peerMap(state.peers).get(owner)?.name ?? owner);
			const title = typeof history?.title === 'string' && history.title !== '' ? history.title : t('nameFallback');
			const allTurns = Array.isArray(history?.transcript) ? history.transcript : [];
			const pane = state.readerPane === 'trajectory' ? 'trajectory' : 'dialogue';
			const isTrajectory = (turn) => (typeof turn?.kind === 'string' ? turn.kind === 'trajectory' : ['tool', 'call', 'system', 'developer'].includes(String(turn?.role ?? '')));
			const transcript = allTurns.filter((turn) => (pane === 'trajectory' ? isTrajectory(turn) : !isTrajectory(turn)));
			const busy = state.pending === true;
			// The confirmation is transient: it disappears on its own timer.
			const sent = state.sent !== null && typeof state.sent === 'object' && Date.now() - Number(state.sent.at ?? 0) < SENT_MS ? state.sent : null;
			const sessionId = typeof reader?.sessionId === 'string' ? reader.sessionId : '';
			const offlineNote = t('composerOffline').replace('{name}', ownerName);
			const composed = async (mode, reset) => {
				const accepted = await onSend(draft, mode);
				if (accepted === true) reset();
			};
			const tabs = div(
				'dc_tabs',
				button(cx('dc_tab', pane === 'dialogue' && 'dc_tabOn'), `${t('paneDialogue')} ${count(allTurns.filter((turn) => !isTrajectory(turn)).length)}`, () => onPane?.('dialogue')),
				button(cx('dc_tab', pane === 'trajectory' && 'dc_tabOn'), `${t('paneTrajectory')} ${count(allTurns.filter(isTrajectory).length)}`, () => onPane?.('trajectory')),
				online && remote ? span('dc_badge dc_badgeLive', t('liveOn'), { title: t('liveHint') }) : null,
			);
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
				history === null || !Array.isArray(history?.tasks?.items) || history.tasks.items.length === 0
					? null
					: div(
						'dc_readerTasks',
						span('dc_fieldLabel', t('taskContent')),
						span('dc_taskItems', history.tasks.items.map((item, index) => span(
							cx('dc_taskLine', item?.status === 'done' && 'dc_taskLineDone'),
							span('dc_taskDot'),
							span('dc_taskText', String(item?.text ?? ''), { title: String(item?.text ?? '') }),
							{ key: `rt:${index}` },
						))),
					),
				tabs,
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
							remote ? button('dc_ghost', busy ? t('inheriting') : t('inherit'), () => void onInherit(), { disabled: busy || !online, title: t('inheritHint').replace('{name}', ownerName) }) : null,
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

			/** While a remote reader is open, follow the owning machine. */
			React.useEffect(() => {
				if (state.view !== 'reader' || state.reader === null) return undefined;
				const remote = state.reader.deviceId !== state.self?.deviceId;
				if (!remote || typeof window === 'undefined' || typeof window.setInterval !== 'function') return undefined;
				const timer = window.setInterval(() => {
					if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
					void actions.reloadHistory(true);
				}, 2500);
				return () => window.clearInterval(timer);
			}, [state.view, state.reader, state.self, actions]);

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
			// The empty state is the honest answer to "there is nothing to show":
			// no relay configured AND nothing ever arrived. A configured but silent
			// relay keeps the lists, which carry their own "nothing here yet" lines.
			const unconfigured = state.status === 'ready' && String(self?.relayUrl ?? '') === '' && peers.length === 0 && sessions.length === 0;
			// v4.0.2 floor: a build older than the minimum gets one sealed screen,
			// not a panel. The Host enforces the same rule server-side.
			const belowFloor = typeof state.version === 'string' && state.version !== ''
				&& compareVersions(state.version, String(state.minVersion ?? '4.0.2')) < 0;

			if (belowFloor) {
				const upgrade = `curl -fsSL https://cdn.jsdelivr.net/gh/zengpu987-ctrl/dsh-deep-connect@v${String(state.minVersion ?? '4.0.2') || '4.0.2'}/install.sh | bash`;
				return h(
					'section',
					{ className: 'dc_root', 'data-dc': 'panel' },
					div(
						'dc_scroll',
						div(
							'dc_blank',
							h('h2', { className: 'dc_blankTitle' }, t('gateTitle')),
							para('dc_blankBody', t('gateBody').replace('{current}', String(state.version)).replace('{min}', String(state.minVersion ?? '4.0.2'))),
							span('dc_fieldLabel', t('gateCommand')),
							h('input', { className: 'dc_input dc_mono', type: 'text', value: upgrade, readOnly: true }),
							para('dc_note', upgrade),
						),
					),
				);
			}
			const header = h(
				'header',
				{ className: 'dc_head', 'data-window-drag': true },
				div(
					'dc_headMain',
					h(
						'h1',
						{ className: 'dc_title' },
						t('title'),
						span('dc_badge dc_badgePro', `v${state.version ?? ''} ${t('proBadge')}`, { title: t('proBadge') }),
						state.update?.outdated === true
							? span('dc_badge dc_badgeUpdate', t('updateAvailable').replace('{latest}', String(state.update.latest ?? '')).replace('{current}', String(state.update.current ?? state.version ?? '')), { title: t('updateTitle') })
							: null,
					),
					span(
						'dc_headFacts',
						el(Fact, { label: t('thisDevice'), value: deviceName }),
						el(Fact, { label: t('stationTitle'), value: relayUrl, title: String(self?.relayUrl ?? '') }),
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
			const settings = el(SettingsSection, {
				t,
				self,
				station: state.station,
				update: state.update,
				version: state.version,
				mobile: state.mobile,
				pending: state.pending === true,
				onSave: (patch) => void actions.configure(patch),
				onGenerate: () => void actions.createStation(),
				onJoin: (link) => void actions.joinStation(link),
				onStop: () => void actions.stopStation(),
				onCheckUpdate: (force) => void actions.checkUpdate(force),
				onInstallUpdate: () => void actions.installUpdate(),
				onToggleMobile: (on) => void actions.toggleMobile(on),
				onLeaveStation: () => void actions.stopStation(),
			});
			// ---- v3.0.2 workspace: device rail on the left, tasks on the right ----
			const deviceList = [
				{
					deviceId: typeof self?.deviceId === 'string' ? self.deviceId : '',
					name: deviceName,
					online: true,
					isRemote: false,
					shareMemory: self?.shareMemory !== false,
					sessionCount: sessions.filter((row) => row.isRemote !== true).length,
				},
				...peers.map((peer) => ({
					deviceId: String(peer?.deviceId ?? ''),
					name: typeof peer?.name === 'string' && peer.name !== '' ? peer.name : String(peer?.deviceId ?? '').slice(0, 8),
					online: peer?.online === true,
					isRemote: true,
					shareMemory: peer?.shareMemory !== false,
					lastSeen: Number(peer?.lastSeen ?? 0),
					sessionCount: sessions.filter((row) => row.ownerId === peer?.deviceId).length,
					// The command card picks a Workspace of THAT machine and shows the
					// model it is currently on, so the peer's own advertisement has to
					// survive this projection — dropping it silently emptied the picker.
					workspaces: Array.isArray(peer?.workspaces) ? peer.workspaces : [],
					defaultWorkspacePath: typeof peer?.defaultWorkspacePath === 'string' ? peer.defaultWorkspacePath : '',
					model: peer?.model !== null && typeof peer?.model === 'object' ? peer.model : undefined,
				})),
			];
			for (const device of deviceList) {
				device.openTasks = sessions
					.filter((row) => String(row?.ownerId ?? '') === device.deviceId)
					.reduce((total, row) => total + Number(row?.tasks?.open ?? 0), 0);
			}
			// '' means the overview: every device's sessions in one list. Clicking a
			// device card narrows it to that machine's tasks.
			const selectedDevice = state.selectedDevice === ''
				? null
				: deviceList.find((device) => device.deviceId === state.selectedDevice) ?? null;
			const selectedSessions = selectedDevice === null
				? sessions
				: sessions.filter((row) => String(row?.ownerId ?? '') === selectedDevice.deviceId);
			const query = String(state.query ?? '').trim().toLowerCase();
			const visibleSessions = query === ''
				? selectedSessions
				: selectedSessions.filter((row) => {
					const haystack = [
						row?.title,
						row?.sessionId,
						...(Array.isArray(row?.userPrompts) ? row.userPrompts : []),
						...(Array.isArray(row?.tasks?.items) ? row.tasks.items.map((item) => item?.text) : []),
					].filter((part) => typeof part === 'string').join(' ').toLowerCase();
					return haystack.includes(query);
				});
			const taskTotals = selectedSessions.reduce((total, row) => {
				const tasks = row?.tasks !== null && typeof row?.tasks === 'object' ? row.tasks : {};
				total.open += Number(tasks.open ?? 0);
				total.done += Number(tasks.done ?? 0);
				if (tasks.goal !== undefined && tasks.goal !== '') total.goal += 1;
				total.team += Number(tasks.team ?? 0);
				return total;
			}, { open: 0, done: 0, goal: 0, team: 0 });
			const rail = h(
				'aside',
				{ className: 'dc_rail', 'data-dc': 'rail' },
				h('h2', { className: 'dc_railTitle' }, t('railTitle')),
				span(
					'dc_memory',
					span('dc_memoryLabel', t('memoryShare')),
					button(
						cx('dc_switch', self?.shareMemory !== false && 'dc_switchOn'),
						span('dc_switchKnob'),
						() => void actions.toggleMemory(),
						{ 'aria-pressed': self?.shareMemory !== false, title: self?.shareMemory !== false ? t('memoryOnHint') : t('memoryOffHint') },
					),
					span('dc_fieldHint', self?.shareMemory !== false ? t('memoryOnHint') : t('memoryOffHint')),
				),
				list(
					'dc_devices',
					'device',
					[h(
						'li',
						{ key: 'dev:all', className: 'dc_devItemWrap' },
						button(
							cx('dc_devItem', state.selectedDevice === '' && 'dc_devItemOn'),
							[
								span('dc_devDot dc_devDotOn'),
								span('dc_devName', t('allDevices')),
								span('dc_devMeta', t('deviceSessions').replace('{n}', String(count(sessions.length)))),
							],
							() => actions.selectDevice(''),
							{ 'data-device-id': '', title: t('allDevices') },
						),
					)].concat(deviceList.map((device) => h(
						'li',
						{ key: `dev:${device.deviceId}`, className: 'dc_devItemWrap' },
						button(
							cx('dc_devItem', device.deviceId === selectedDevice?.deviceId && 'dc_devItemOn', device.online && 'dc_devItemOnline'),
							[
								span(cx('dc_devDot', device.online ? 'dc_devDotOn' : 'dc_devDotOff')),
								span('dc_devName', device.name, { title: device.name }),
								span('dc_devMeta', t('deviceSessions').replace('{n}', String(count(device.sessionCount)))),
								device.openTasks > 0 ? span('dc_devBadge', String(device.openTasks), { title: t('devOpenTasks').replace('{n}', String(device.openTasks)) }) : null,
								device.isRemote === false ? span('dc_badge', t('thisDevice')) : null,
								device.shareMemory === false ? span('dc_badge dc_badgeWarn', t('memoryOff')) : null,
							],
							() => actions.selectDevice(device.deviceId),
							{ 'data-device-id': device.deviceId, title: device.name },
						),
					))),
				),
			);
			const selectedGroups = h(
					'section',
					{ className: 'dc_section dc_detail', key: `detail:${selectedDevice?.deviceId ?? 'all'}`, 'data-dc': 'detail' },
					h(
						'h2',
						{ className: 'dc_sectionTitle' },
						selectedDevice === null ? t('allDevices') : selectedDevice.name,
						selectedDevice === null ? null : span(cx('dc_badge', selectedDevice.online && 'dc_badgeOk'), selectedDevice.online ? t('online') : t('offline')),
						selectedDevice?.isRemote === false ? span('dc_badge', t('thisDevice')) : null,
						selectedDevice?.shareMemory === false ? span('dc_badge dc_badgeWarn', t('memoryOff')) : null,
					),
					div(
						'dc_taskBoard',
						span('dc_taskChips',
							span('dc_chip dc_chipOpen', t('taskOpen').replace('{n}', String(taskTotals.open))),
							span('dc_chip dc_chipDone', t('taskDone').replace('{n}', String(taskTotals.done))),
							taskTotals.goal > 0 ? span('dc_chip', t('taskGoal').replace('{n}', String(taskTotals.goal))) : null,
							taskTotals.team > 0 ? span('dc_chip', t('taskTeam').replace('{n}', String(taskTotals.team))) : null,
						),
					),
					selectedSessions.length === 0
						? null
						: div(
							'dc_searchRow',
							h('input', {
								className: 'dc_input dc_search', type: 'search', value: state.query ?? '',
								placeholder: t('searchPlaceholder'), 'aria-label': t('searchPlaceholder'),
								onChange: (event) => store.update((draft) => { draft.query = event.target.value; }),
							}),
							span('dc_fieldHint', t('searchCount').replace('{n}', String(visibleSessions.length)).replace('{m}', String(selectedSessions.length))),
						),
					visibleSessions.filter((row) => Array.isArray(row?.tasks?.items) && row.tasks.items.length > 0).length === 0
						? null
						: list(
							'dc_taskList',
							'task',
							visibleSessions.filter((row) => Array.isArray(row?.tasks?.items) && row.tasks.items.length > 0).map((row) => h(
								'li',
								{ className: 'dc_taskItem', key: `task:${row.sessionId}` },
								span('dc_taskHead',
									span('dc_taskTitle', String(row.title ?? row.sessionId ?? ''), { title: String(row.title ?? '') }),
									String(row.ownerId ?? '') !== String(self?.deviceId ?? '')
										? button('dc_link', t('relayTask'), () => void actions.inheritRow(String(row.ownerId ?? ''), String(row.sessionId ?? ''), { run: true }), { disabled: state.pending === true })
										: null,
								),
								span('dc_taskItems',
									(row.tasks.items ?? []).map((item, index) => span(
										cx('dc_taskLine', item?.status === 'done' && 'dc_taskLineDone'),
										span('dc_taskDot'),
										span('dc_taskText', String(item?.text ?? ''), { title: String(item?.text ?? '') }),
										{ key: `item:${index}` },
									)),
								),
							)),
						),
					selectedDevice?.isRemote === true
						? (() => {
							// The WORKSPACE and the MODEL STRENGTH are chosen here, on the
							// machine a human is typing on: the target runs the command in
							// the picked workspace of its own machine and adopts the
							// selected model rather than quietly using its own.
							const workspaces = Array.isArray(selectedDevice.workspaces) ? selectedDevice.workspaces : [];
							const picker = modelRows(state.modelCatalog);
							const chosen = picker.find((row) => row.key === state.taskModelKey);
							const efforts = chosen === undefined ? [] : chosen.efforts;
							return div(
								'dc_command',
								span('dc_fieldLabel', t('deviceCommand')),
								div(
									'dc_commandRow',
									h('input', {
										className: 'dc_input', type: 'text', value: state.taskDraft ?? '',
										placeholder: t('deviceCommandPlaceholder'),
										'aria-label': t('deviceCommand'),
										onChange: (event) => store.update((draft) => { draft.taskDraft = event.target.value; }),
									}),
									button('dc_primary', state.pending === true ? t('sending') : t('deviceCommandSend'), () => {
										const text = String(store.getSnapshot().taskDraft ?? '').trim();
										if (text === '') return;
										void actions.runTask(selectedDevice.deviceId, text).then((ok) => {
											if (ok) store.update((draft) => { draft.taskDraft = ''; });
										});
									}, { disabled: state.pending === true || String(state.taskDraft ?? '').trim() === '' }),
								),
								div(
									'dc_commandRow',
									h('select', {
										className: 'dc_input dc_select', value: state.taskWorkspaceId ?? '',
										'aria-label': t('commandWorkspace'), title: t('commandWorkspaceHint'),
										onChange: (event) => store.update((draft) => { draft.taskWorkspaceId = event.target.value; }),
									},
										h('option', { key: 'w:auto', value: '' }, t('commandWorkspaceDefault')),
										...workspaces.map((workspace) => h('option', { key: `w:${String(workspace.id)}`, value: String(workspace.id) },
											String(workspace.title || workspace.path) +
											(String(workspace.path) === String(selectedDevice.defaultWorkspacePath) ? ` · ${t('commandWorkspaceDefaultTag')}` : ''))),
									),
									h('select', {
										className: 'dc_input dc_select', value: state.taskModelKey ?? '',
										'aria-label': t('commandModel'), title: t('commandModelHint'),
										onChange: (event) => store.update((draft) => { draft.taskModelKey = event.target.value; draft.taskEffort = ''; }),
									},
										h('option', { key: 'm:auto', value: '' }, t('commandModelDefault')),
										...picker.map((row) => h('option', { key: `m:${row.key}`, value: row.key }, row.label)),
									),
									efforts.length === 0 ? null : h('select', {
										className: 'dc_input dc_select', value: state.taskEffort ?? '',
										'aria-label': t('commandEffort'),
										onChange: (event) => store.update((draft) => { draft.taskEffort = event.target.value; }),
									},
										h('option', { key: 'e:auto', value: '' }, t('commandEffortDefault')),
										...efforts.map((effort) => h('option', { key: `e:${String(effort.id)}`, value: String(effort.id) }, String(effort.name ?? effort.id))),
									),
								),
								span('dc_fieldHint', t('deviceCommandHint')),
							);
						})()
						: null,
					selectedSessions.length === 0
						? para('dc_empty', t('groupEmpty'))
						: visibleSessions.length === 0
							? para('dc_empty', t('searchEmpty'))
							: list('dc_rows', null, visibleSessions.map((entry) => el(SessionRow, {
							key: `row:${selectedDevice?.deviceId ?? entry?.ownerId ?? ''}:${entry?.sessionId ?? ''}`,
							entry,
							t,
							onOpen: actions.openReader,
							onInherit: (selectedDevice === null ? entry.isRemote === true : selectedDevice.isRemote === true && selectedDevice.shareMemory !== false)
								? (row) => void actions.inheritRow(String(row?.ownerId ?? selectedDevice?.deviceId ?? ''), String(row?.sessionId ?? ''))
								: null,
						}))),
				);
			const workspace = h(
				'div',
				{ className: 'dc_workspace' },
				rail,
				h('main', { className: 'dc_main', 'data-dc': 'main' }, selectedGroups),
			);

			if (state.view === 'reader') {
				return h('section', { className: 'dc_root', 'data-dc': 'panel' }, header, errorLine, el(ReaderView, { t, state, onBack: actions.closeReader, onSend: actions.sendPrompt, onInherit: actions.inheritSession, onPane: (pane) => store.update((draft) => { draft.readerPane = pane === 'trajectory' ? 'trajectory' : 'dialogue'; }) }));
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
				state.view === 'settings'
					? div('dc_scroll', settings)
					: div(
						'dc_body',
						stats === null ? null : para('dc_note dc_bodyNote', t('statsLine')
							.replace('{local}', String(count(stats.local)))
							.replace('{remote}', String(count(stats.remote)))
							.replace('{peers}', String(count(stats.peers ?? peers.length)))),
						workspace,
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
		 * Sidebar icon: one computer linked to another. Two monitors side by side,
		 * joined by a dashed line with a lock dot in the middle.
		 * @param props - the sidebar's `size` and `active` flag.
		 */
		function PanelIcon({ size, active }) {
			const edge = Number.isFinite(size) && size > 0 ? size : 20;
			const width = active === true ? 1.7 : 1.4;
			const stroke = 'currentColor';
			return svg(
				'svg',
				{ width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
				// Left machine: screen, neck, stand.
				svg('rect', { x: 1.4, y: 5.2, width: 8.2, height: 6.2, rx: 1.1, stroke, strokeWidth: width }),
				svg('path', { d: 'M6 11.4v3.2M3.1 14.6h5.8', stroke, strokeWidth: width, strokeLinecap: 'round' }),
				// Right machine.
				svg('rect', { x: 14.4, y: 5.2, width: 8.2, height: 6.2, rx: 1.1, stroke, strokeWidth: width }),
				svg('path', { d: 'M19 11.4v3.2M16.1 14.6h5.8', stroke, strokeWidth: width, strokeLinecap: 'round' }),
				// The link: a dashed line with the lock dot in the middle.
				svg('path', { d: 'M9.7 8.3h4.6', stroke, strokeWidth: width, strokeLinecap: 'round', strokeDasharray: '1.4 1.3' }),
				svg('circle', { cx: 12, cy: 8.3, r: 1.7, fill: stroke }),
				svg('path', { d: 'M2.2 18.2h19.6', stroke, strokeWidth: width * 0.8, strokeLinecap: 'round', opacity: 0.45 }),
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
			// v3.0.2 workspace: a device rail on the left, tasks on the right.
			'.dc_body{flex-direction:column;min-height:0;flex:1;display:flex}.dc_bodyNote{flex:none;margin:0 20px 6px}.dc_workspace{min-height:0;flex:1;gap:0;display:flex}.dc_rail{flex:none;width:216px;border-right:.5px solid var(--dsw-alias-border-l1);flex-direction:column;gap:8px;padding:10px 12px;display:flex;overflow:auto}',
			'.dc_railTitle{color:var(--dsw-alias-label-caption);text-transform:uppercase;letter-spacing:.04em;margin:0 0 2px;font-size:11px;font-weight:500;line-height:16px}.dc_memory{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:4px;padding:8px 10px;display:flex}.dc_memoryLabel{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
			'.dc_switch{border:0;border-radius:999px;background:var(--dsw-alias-border-l3);cursor:pointer;flex:none;width:34px;height:20px;padding:2px;display:flex;align-items:center;transition:background .15s}.dc_switchKnob{background:var(--dsw-alias-label-primary-inverted, var(--dsw-alias-bg-base));border-radius:999px;width:16px;height:16px;transition:transform .15s;display:block}.dc_switchOn{background:var(--dsw-alias-state-success-primary)}.dc_switchOn .dc_switchKnob{transform:translateX(14px)}',
			'.dc_devices{flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;display:flex}.dc_devItemWrap{margin:0;padding:0}.dc_devItem{width:100%;border:.5px solid transparent;border-radius:var(--dsw-radius-lg);background:0 0;color:var(--dsw-alias-label-secondary);text-align:left;cursor:pointer;align-items:center;gap:7px;padding:7px 9px;font:inherit;font-size:12.5px;line-height:18px;display:flex}.dc_devItem:hover{background:var(--dsw-alias-interactive-bg-hover)}.dc_devItemOn{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-label-primary)}.dc_devDot{border-radius:999px;flex:none;width:8px;height:8px;background:var(--dsw-alias-label-caption)}.dc_devDotOn{background:var(--dsw-alias-state-success-primary)}.dc_devDotOff{background:var(--dsw-alias-state-error-primary)}.dc_devName{text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;overflow:hidden}.dc_devMeta{color:var(--dsw-alias-label-caption);flex:none;font-size:10.5px}',
			'.dc_main{min-width:0;flex:1;padding:10px 16px;overflow:auto}.dc_detail{gap:6px}.dc_taskBoard{flex-wrap:wrap;gap:6px;display:flex}.dc_taskChips{flex-wrap:wrap;gap:6px;display:flex}.dc_chipOpen{color:var(--dsw-alias-state-warn-primary)}.dc_chipDone{color:var(--dsw-alias-state-success-primary)}.dc_badgeWarn{color:var(--dsw-alias-state-warn-primary)}',
			'.dc_mobile{flex-direction:column;align-items:flex-start;gap:8px;display:flex}.dc_qr{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);width:180px;height:180px}',
			'.dc_taskList{flex-direction:column;gap:6px;margin:8px 0 10px;padding:0;list-style:none;display:flex}.dc_taskItem{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:3px;padding:8px 10px;display:flex}.dc_taskHead{align-items:center;gap:8px;display:flex}.dc_taskTitle{color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1;font-size:12px;line-height:18px;overflow:hidden}.dc_taskItems{flex-direction:column;gap:2px;display:flex}.dc_taskLine{align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;display:flex}.dc_taskLineDone{color:var(--dsw-alias-label-caption);text-decoration:line-through}.dc_taskDot{border-radius:999px;background:var(--dsw-alias-state-warn-primary);flex:none;width:6px;height:6px}.dc_taskLineDone .dc_taskDot{background:var(--dsw-alias-state-success-primary)}.dc_taskText{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}.dc_readerTasks{border-top:.5px solid var(--dsw-alias-border-l1);flex-direction:column;gap:4px;margin:8px 20px 0;padding-top:8px;display:flex}',
			'.dc_select{flex:1;min-width:0;font-size:12px;padding:4px 6px}.dc_command{border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);flex-direction:column;gap:6px;margin:6px 0 10px;padding:10px}.dc_commandRow{flex-direction:row;gap:8px;display:flex}.dc_rowAction{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;align-self:center;margin-right:8px;padding:4px 8px;font:inherit;font-size:11px;line-height:16px}.dc_rowAction:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
			'@media (max-width:720px){.dc_factValue{max-width:60vw}.dc_head{flex-wrap:wrap}.dc_rail{width:168px}.dc_workspace{flex-direction:column}.dc_rail{border-right:0;border-bottom:.5px solid var(--dsw-alias-border-l1);width:auto;flex-direction:row;flex-wrap:wrap;align-items:center}.dc_devices{flex-direction:row;flex-wrap:wrap}}',
			// v4.1 frosted-glass skin: layered translucency, large radii, soft light.
			'.dc_root{background:radial-gradient(1100px 560px at 8% -12%,color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent),transparent 62%),radial-gradient(900px 520px at 102% -6%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent),transparent 58%),var(--dsw-alias-bg-base)}',
			'.dc_head{position:relative;z-index:2;padding:16px 22px 12px;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 65%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-base) 70%,transparent);-webkit-backdrop-filter:blur(24px) saturate(170%);backdrop-filter:blur(24px) saturate(170%)}',
			'.dc_title{font-weight:600;letter-spacing:.01em}.dc_headFacts{gap:16px}.dc_factValue{max-width:30vw}',
			'.dc_ghost,.dc_primary{height:30px;border-radius:999px;padding:0 15px;transition:background .16s ease,box-shadow .16s ease,transform .16s ease,color .16s ease}.dc_ghost{border-width:1px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}.dc_ghost:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 6px 16px color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}.dc_primary{background:linear-gradient(135deg,var(--dsw-alias-button-primary-fill),color-mix(in srgb,var(--dsw-alias-brand-primary) 78%,var(--dsw-alias-button-primary-fill)));box-shadow:0 8px 20px color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent)}.dc_primary:hover:not(:disabled){transform:translateY(-1px);box-shadow:0 10px 24px color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}.dc_iconBtn{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 60%,transparent);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}',
			'.dc_workspace{gap:16px;padding:0 16px 16px}.dc_rail{width:238px;padding:14px;gap:10px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 65%,transparent);border-radius:24px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 62%,transparent);-webkit-backdrop-filter:blur(26px) saturate(160%);backdrop-filter:blur(26px) saturate(160%);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent),0 20px 48px color-mix(in srgb,var(--dsw-alias-label-primary) 9%,transparent)}.dc_main{padding:2px 2px 4px 0}',
			'.dc_memory,.dc_device,.dc_row,.dc_taskItem,.dc_command,.dc_settings,.dc_blank,.dc_notice,.dc_composer,.dc_turn,.dc_station,.dc_mobile{border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 62%,transparent);border-radius:20px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 66%,transparent);-webkit-backdrop-filter:blur(20px) saturate(150%);backdrop-filter:blur(20px) saturate(150%);box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent),0 8px 24px color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent)}',
			'.dc_row,.dc_device,.dc_devItem,.dc_taskItem,.dc_ghost,.dc_tab,.dc_rowAction{transition:background .16s ease,box-shadow .16s ease,transform .16s ease,border-color .16s ease}',
			'.dc_row:hover{transform:translateY(-1px);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,var(--dsw-alias-border-l1));box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary) 6%,transparent),0 14px 34px color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}.dc_rowOpen{padding:10px 14px;gap:5px}.dc_rowAction{border-radius:999px}',
			'.dc_devItem{border-radius:16px;padding:9px 11px}.dc_devItemOn{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent);background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 40%,transparent));box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-label-primary) 8%,transparent)}.dc_devBadge{min-width:20px;height:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 18%,transparent);color:var(--dsw-alias-state-warn-primary);font-size:10.5px;font-weight:600;line-height:18px;text-align:center;flex:none}',
			'.dc_badge,.dc_chip,.dc_dot{border-radius:999px}.dc_badge{padding:0 8px;line-height:19px}.dc_chip{padding:1px 8px;line-height:17px}',
			'.dc_sectionTitle{font-size:13px;letter-spacing:.01em}.dc_sectionCount,.dc_fieldHint{font-size:11px}',
			'.dc_searchRow{display:flex;align-items:center;gap:10px;margin:8px 0 4px}.dc_search{flex:1;min-width:0;border-radius:14px;padding:8px 12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 55%,transparent)}',
			'.dc_input,.dc_textarea{border-width:1px;border-radius:14px;background:color-mix(in srgb,var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1)) 72%,transparent);transition:border-color .16s ease,box-shadow .16s ease}.dc_input:focus,.dc_textarea:focus{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l2));box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}',
			'.dc_reader{padding:0 22px 18px}.dc_readerHead{padding-top:2px}.dc_tabs{padding:2px 0 8px;gap:6px}.dc_tab{border-radius:999px;padding:4px 13px}.dc_tabOn{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 30%,transparent);background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent),transparent)}',
			'.dc_turn{border-radius:16px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 58%,transparent)}.dc_turn_user{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent))}.dc_turn_assistant{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}.dc_turnBody{padding:10px 14px 12px}',
			'.dc_composer{border-radius:24px;padding:12px 14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 72%,transparent)}.dc_sent{padding:2px 10px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}',
			'.dc_settings{border-radius:24px;padding:16px 18px}.dc_station{border-radius:20px;padding:12px 14px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 50%,transparent)}.dc_qr{border-radius:18px;padding:8px;width:196px;height:196px;background:var(--dsw-alias-bg-base)}',
			'.dc_scroll::-webkit-scrollbar,.dc_rail::-webkit-scrollbar,.dc_main::-webkit-scrollbar,.dc_turnBody::-webkit-scrollbar{width:10px;height:10px}.dc_scroll::-webkit-scrollbar-thumb,.dc_rail::-webkit-scrollbar-thumb,.dc_main::-webkit-scrollbar-thumb,.dc_turnBody::-webkit-scrollbar-thumb{border-radius:999px;border:3px solid transparent;background-clip:padding-box;background-color:color-mix(in srgb,var(--dsw-alias-label-caption) 34%,transparent)}.dc_scroll::-webkit-scrollbar-track,.dc_rail::-webkit-scrollbar-track,.dc_main::-webkit-scrollbar-track{background:transparent}',
			'@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){.dc_rail,.dc_memory,.dc_device,.dc_row,.dc_taskItem,.dc_command,.dc_settings,.dc_blank,.dc_notice,.dc_composer,.dc_turn,.dc_station,.dc_mobile,.dc_ghost{background:var(--dsw-alias-bg-layer-1)}}',
			'@media (prefers-reduced-motion:reduce){.dc_row,.dc_device,.dc_devItem,.dc_taskItem,.dc_ghost,.dc_primary,.dc_tab{transition:none}.dc_ghost:hover:not(:disabled),.dc_primary:hover:not(:disabled),.dc_row:hover{transform:none}}',
			'@media (max-width:720px){.dc_workspace{flex-direction:column;padding:0 10px 12px;gap:10px}.dc_rail{width:auto;flex-direction:row;flex-wrap:wrap;align-items:center;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l1) 65%,transparent)}.dc_devices{flex-direction:row;flex-wrap:wrap}.dc_main{padding:0}.dc_factValue{max-width:58vw}.dc_head{flex-wrap:wrap;padding:12px 14px 10px}}',
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
