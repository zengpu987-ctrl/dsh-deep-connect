# Deep Connect — 设计

让**同一个 DeepSeek 账号**登录的多台 DSH 电脑通过云端中继互相发现，并做到：

1. **会话索引互见** —— 每台机器把本地会话的索引（id、标题、cwd、时间、消息数、预览）推到中继，其他机器看得见「那台机器上有哪些对话/任务」。
2. **完整消息历史可读** —— 点开远端某条会话，能读到完整对话正文（user/assistant/tool 全量），不需要那台机器开着窗口。
3. **任务状态一致** —— todo / goal / 团队任务本身就是会话日志里的事件，跟着会话日志一起同步，因此第 2 条实现后基本顺带成立；额外提供一份「任务摘要」聚合视图，让两台机器一眼看到对方的任务板。
4. **可接管** —— 在 B 机上继续 A 机开着的对话。

隐私：**中继只看到密文**。密钥由两台机器各自从同一个 DeepSeek 账号本地推导，中继运营方拿不到对话内容。

---

## 1. 为什么是这个形状

DSH 已经是事件溯源（event-sourced）的：一次对话就是一条只追加的事件日志
（`SessionEvent[]`），标题、todo、goal、团队任务、工具调用全都是这条日志里的事件。
所以「同步对话 + 同步任务」在 DSH 里不是两个功能，而是**同一个功能**：把日志搬过去。

已核实的 DSH 原语（本机安装的 `@deepseek-ai/dsh` 依赖树，版本 `0.2.0-rc.2`，路径形如
`<dsh-install>/node_modules/@deepseek-ai/`）：

| 原语 | 位置 | 用途 |
|---|---|---|
| `SessionHandle.read(offset?, length?)` | `dsh-session-persistence/lib/types/handle.d.ts:70` | 读出一条会话的**规范化事件**；后端自己处理 zstd 分帧、历史格式迁移、崩溃尾巴 |
| `SessionPersistence.list()` | `dsh-session-persistence/lib/types/index.d.ts:173` | 列出全部已存会话的 header + revision，**不读事件体**，适合做索引 |
| `SessionPersistence.stat(id)` | `dsh-session-persistence/lib/types/index.d.ts:160` | 单条会话的变更令牌（revision），用于增量判断 |
| `SessionController.follow/prompt/inspect` | `dsh-api-session-controller/lib/types/index.d.ts` | 本地 Agent 的实时帧流与「投喂一条消息」；接管靠它 |
| `ctx.agents.resume({ resumeSessionId })` | `dsh-agent/lib/types/index.d.ts:109` | 把一条已持久化会话重新挂上活的 Agent（二期用） |
| `ctx.webServer.register / registerUpgrade` | `dsh-host-webserver/lib/types/index.d.ts:71,97` | Host 半注册同源 HTTP 路由 / WebSocket 升级路由 |
| `ctx.deepseekAccount.getProfile(client)` | `dsh-deepseek-account/lib/types/index.d.ts:72` | 拿到账号的用户 id（`AccountProfile.id`），用作「同一账号」的判定依据 |
| `ctx.credentials` | `dsh-credentials/lib/types/index.d.ts` | 存放推导密钥 / 设备身份 |

**关键发现（核实的）**：磁盘上的 `session.vN.jsonl.zstd` 是**多个独立 zstd 帧首尾相接**，
一帧一行；读取必须逐帧解压，直接 `zstdDecompressSync(整个文件)` 只出第一帧
（实测：199,882 字节的文件只解出 234 字节 = 会话头）。
所以插件**不自己解析文件**，一律走 `ctx.sessionPersistence`——它内部负责逐帧、校验和与恢复。
这既是正确性要求，也是版本兼容要求。

## 2. 拓扑

```
  A 机 (DSH)                          B 机 (DSH)
  ┌──────────────┐                    ┌──────────────┐
  │ deep-connect │                    │ deep-connect │
  │  Host 半     │                    │  Host 半     │
  │  ├ 本地 SSE  │◀── 同源 HTTP ──┐   │              │
  │  └ WS client │                │   │              │
  └──────┬───────┘            浏览器 │   └──────┬───────┘
         │                            ▲          │
         │  WSS（密文）                │          │  WSS（密文）
         ▼                            │          ▼
  ┌────────────────────────────────────────────────────┐
  │  dsh-connect-relay（云端，无依赖单文件）             │
  │  channel = SHA-256(accountId) 分桶                    │
  │  只做：投递信封、在场名单、离线暂存、长轮询            │
  │  看不见：账号 id（只有它的哈希）、任何对话内容（密文）  │
  └────────────────────────────────────────────────────┘
```

浏览器**永远只连本机**（`127.0.0.1`）：面板读写本地 Host 的同源路由，本地 Host 再走中继去
另一台机器。这样浏览器侧不需要任何新的认证、不需要跨源、不需要暴露中继。

## 3. 中继契约（`deep-connect/relay/RELAY.md` 冻结）

中继是**哑的**：它不知道什么是会话、消息、任务。它只知道
`channel`（账号桶）、`deviceId`（信封上的寄件人/收件人）和**一串不透明的密文**。

- `channel = hex(SHA-256("dsh-deep-connect/channel/v1|" + accountId))`
  中继只见到这个 64 位十六进制串，见不到 accountId。
- 认证：所有请求带 `x-dsh-connect-channel: <channel>`；WebSocket 用同样的头（或 `?channel=`）。
  没带就是 401。中继不需要单独的密码——channel 本身就是持有者凭证，且它等于「能推导出同一把
  密钥」，也就是「同一个账号」。
- 信封（明文部分只有路由信息）：
  ```json
  { "id": "m-<随机>", "from": "<deviceId>", "to": "<deviceId>|*",
    "at": 1792038768593, "seq": 7, "ttlMs": 604800000, "body": "<base64 密文>" }
  ```
- 设备**不需要**在线：发给离线设备的信封进它的信箱，等它下次连接时按 `seq` 升序投递；上限
  `maxMailboxPerDevice`（默认 512 条）与 `ttlMs`（默认 7 天），超限丢最旧。
- 连接即握手：`hello` 帧带上设备名与能力，中继据此维护在场名单，并向同 channel 的其它连接广播
  `presence` 帧。

## 4. 密码学

```
accountKey = PBKDF2-HMAC-SHA-256(accountId, salt="dsh-deep-connect/v1", iters=200000, 32B)
channel    = hex(SHA-256("dsh-deep-connect/channel/v1|" + accountId))
```

- 两台机器登录同一账号 → `accountId` 相同 → 独立推出同一把 `accountKey`。
- 每帧 `AES-256-GCM`，随机 96 位 nonce，`aad = channel | seq`。
- 用户可在设置里覆盖 `passphrase`：填了就用
  `PBKDF2(passphrase, salt="dsh-deep-connect/v1|"+accountId)`，两台机器填一样的口令即可。
- `crypto.subtle`（浏览器/Node 都有）实现，不引第三方库。

**诚实说明威胁模型**：`accountId` 本身既不随机也不由用户选择，是 DeepSeek 平台分配的用户标识。
本机任何能读到 `~/.dsh/.credentials.yaml` 的程序本来就能拿到账号 token，因此以 accountId 派生密钥
并不降低本地安全边界；**它防的是中继运营方和链路**：中继只拿到 channel 哈希与密文，推不出密钥、
读不到正文。想要更强的前向保密需要一次带外配对（二维码/短码），列为二期。

## 5. 数据流

### 5.1 索引（谁有什么）

- 本机 `ctx.sessionPersistence.list()` 拿 header（id、cwd、createdAt、isSeeded…），
  再按需取标题：标题是会话日志里的 `session/title` 事件 → `read()` 少量事件。
- 组装成 `SessionIndexEntry { id, title, cwd, createdAt, updatedAt, eventCount, preview, deviceId }`。
- 变更时（`session/event` 触发 + 节流 2s）加密成 `index` 帧，`to: "*"` 广播。
- 收到别人的 `index` 帧：落盘到本地缓存，面板显示成「远端设备」分组。

### 5.2 历史（点开就能读）

- 面板点开远端会话 → 浏览器 `POST /api/deep-connect/api { action: "history", deviceId, sessionId }`
  → 本地 Host 发 `ask{kind:"history"}` 帧给那台设备。
- 拥有者 `read()` 出全部事件 → `history` 帧（分片，默认 1 MiB/片）回传 → 落到
  `<root>/remote/<deviceId>/<sessionId>.json`，浏览器分页读取渲染。
- 之后长期可离线阅读：缓存就是副本。

### 5.3 任务摘要

- 从事件流里折叠 `todo` / `goal/change` / 团队任务相关事件，得到任务板摘要；
  随 `index` 帧一起带最小字段（`tasks: { open, done, top3[] }`），详情走历史。

### 5.4 接管（在 B 机继续 A 机的对话）

两种手段，一期做第一种：

1. **远程投喂（一期）**：B 机浏览器发 `prompt` 帧 → A 机的 Host 调
   `ctx.sessionController.prompt({ sessionId, requestId, mode, content })`，真正干活的是 A 机
   （模型、工具、文件都在 A 上），A 机把 `follow` 帧实时回传，B 机面板同步显示。
   语义清晰、无并发写冲突：**一条会话永远只有一台机器在写**。
2. **本地接管（二期）**：B 机导入日志（`ctx.sessionPersistence.create(header)` + `append(events)`
   + `flush()`）后 `ctx.agents.resume({ resumeSessionId })`，之后 B 机本地执行。
   必须配一个**独占租约**：A 机检测到自己不再是所有者时停止对这条会话的写入。

## 6. 磁盘布局

```
<root>/                     默认 ~/.dsh/deep-connect
  identity.json             本机 deviceId、设备名、创建时间
  key.json                  { mode: "account" | "passphrase", salt, verifier }（不含密钥本体）
  config.json               中继地址、开关、节流参数
  peers.json                channel 内的设备名单（由 presence 帧维护）
  index/<deviceId>.json     对端会话索引
  remote/<deviceId>/<sessionId>.json   对端会话历史副本
  outbox/                   发件队列（中继离线时暂存）
```

写入一律「临时文件 + 原子重命名」，与记忆体 Superman 的 Store 同一套做法。

## 7. 教训与约束（实现时必须守）

| 约束 | 原因 |
|---|---|
| 不自己解 zstd / 不碰 `session.vN.jsonl.zstd` | 多帧串联 + 校验和 + 崩溃尾巴 + 历史格式迁移，`ctx.sessionPersistence` 已实现且是唯一正确入口 |
| 历史同步走 `read()` 的**规范化事件**，不是文件字节 | 两端格式代（v0…v4）可能不同，规范化事件跨代稳定；文件字节只对同代成立 |
| `to: "*"` 广播不经过自己 | 否则自己的索引会被自己收到并覆盖成远端条目 |
| 中继默认 `0.0.0.0`，但**必须**校验 channel | 云端部署时它是公网服务；无 channel 的请求一律 401 |
| 面板只连本机同源 | 浏览器不直连中继，避免跨源、避免把 channel 交给浏览器 |
| 一条会话同时只有一台机器写 | 事件日志是「只追加、从不重写」，两台同时写会分叉 |
