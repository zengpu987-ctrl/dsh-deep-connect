# Deep Connect

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

同一个 DeepSeek 账号登录的多台 DSH，通过一个云端中继互相看得见：

- **会话索引互见** —— 每台机器把本地会话的索引（标题、时间、消息数、最近几句提问、任务计数）
  加密广播给同账号的其它设备。
- **完整对话可读** —— 点开对端某条会话，读到完整正文（user / assistant / tool 全量），
  并留一份本地副本，之后离线也能看。
- **任务状态一致** —— todo / goal / 团队任务本身就是会话日志里的事件，跟着会话一起同步，
  索引行上直接显示「待办 N / 完成 N / 目标 / 团队 N」。
- **可接管** —— 在 B 机给 A 机开着的会话发消息。真正干活的是 A 机（模型、工具、文件都在 A 上），
  B 机看着结果。**一条会话永远只有一台机器在写**，所以只追加的事件日志不会分叉。
- **中继只见密文** —— 密钥由两台机器各自从同一个账号本地推导，从不上传。

```
  A 机 (DSH)                                    B 机 (DSH)
  ┌──────────────┐                              ┌──────────────┐
  │ deep-connect │◀── 同源 /api ── 浏览器        │ deep-connect │◀── 同源 /api ── 浏览器
  │  Host 半     │                              │  Host 半     │
  └──────┬───────┘                              └──────┬───────┘
         │ WSS（密文）                                    │ WSS（密文）
         └──────────────► dsh-connect-relay ◄────────────┘
                    云端，零依赖单文件
              只见 channel 哈希与不透明密文
```

浏览器**永远只连本机**：面板读写本地 Host 的同源路由，本地 Host 再走中继去另一台机器。
所以浏览器侧不需要新认证、不跨源、不接触 channel。

---

## 快速开始

### 1. 在每台机器上装插件（一行命令）

已经装好本仓库的机器上不需要这一步；**新机器**直接运行。

首选（jsDelivr CDN，国内实测可达）：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/zengpu987-ctrl/dsh-deep-connect@main/install.sh | bash
```

备选（任选其一，都是同一个脚本）：

```bash
# 镜像
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/zengpu987-ctrl/dsh-deep-connect/main/install.sh | bash
# GitHub 直连（国内时通时断，带重试）
curl -fsSL --retry 5 --retry-all-errors https://raw.githubusercontent.com/zengpu987-ctrl/dsh-deep-connect/main/install.sh | bash
```

脚本内部的仓库下载也按实测顺序做了多路回退（codeload → ghproxy.net → gh-proxy.com → github.com）。

脚本会：优先从镜像下载仓库到 `~/.dsh/plugins/dsh-deep-connect` → 链接进 DSH 的
`desktop` profile → 写依赖、bundle 列表和 Loader 配置行。
**改任何文件前都会备份**，重复运行是幂等的。装完**完全退出并重开 Harness**。

想连中继地址一起写进去（这样面板里不用再填）：

```bash
RELAY_URL=http://172.20.10.12:8790 \
  curl -fsSL https://cdn.jsdelivr.net/gh/zengpu987-ctrl/dsh-deep-connect@main/install.sh | bash
```

非默认 profile（如 `web`）加 `PROFILE=web`；DSH 装在别处加 `DSH_HOME=/path/to/.dsh`。

### 2. 起一个中继

任选一台两台机器都够得着的电脑（局域网 / VPN / 云主机都行）。仓库已经在
`~/.dsh/plugins/dsh-deep-connect` 下，或者在本仓库目录里：

```bash
~/.dsh/plugins/dsh-deep-connect/relay/install.sh
```

它会打印另一台机器该填的地址。云端部署（Cloudflare / Deno / VPS）见
[relay/DEPLOY.md](relay/DEPLOY.md)。

### 3. 在面板里把两边接起来

1. 每台机器重启 Harness，左侧边栏出现 **Deep Connect** 图标。
2. 打开面板 → **设置** → 填**中继地址**（`install.sh` 打印的那个）。
3. 保存后看**密钥指纹**：两台机器必须显示**同一个 6 位指纹**。
   - 指纹一致 = 两台机器推算出同一把密钥 = 确实登录了同一个账号。
   - 指纹不一致 = 一台没登录，或者口令填得不一样。

不用手动配对，也不用扫码：**账号就是共享秘密**。想让这个前提不成立（例如不想让账号 id
参与推导），在两台机器上填**同一句口令**即可，口令会替代账号 id 作为密钥来源。


---

## 面板里能看到什么

| 区域 | 内容 |
|---|---|
| 顶部 | 本机名、连接状态灯、中继地址、密钥指纹、重新连接 / 设置 |
| 设置 | 中继地址、访问令牌（可选）、共享口令（可选）、设备名、自动同步索引、保存 |
| 设备 | 每台对端：名字、设备 id、在线徽标、最后在线时间、会话数 |
| 会话 | 「本机」与每台对端一组：标题、相对时间、会话 id、事件数、cwd、任务标签、最后一句提问预览 |
| 阅读 | 点开任一条：完整正文，工具调用可折叠、报错的工具红色显示；底部可继续对话 |

## 继续一条对话意味着什么

在 B 机点开 A 机的会话，输入文字按发送：

1. B 机的 Host 把这句话加密后交给中继；
2. A 机的 Host 收到并解密，通过 DSH 自己的 `ctx.sessionController.prompt(...)` 投喂给本地 Agent
   —— 和你在 A 机键盘上打字走的是同一条路；
3. 真正执行的是 A 机，工具调用落在 A 机的磁盘和权限里；
4. B 机刷新后看到新内容。

对端离线时输入框会禁用，并说明原因；不会静默失败，也不会假装成功。

## 数据放在哪

```
~/.dsh/deep-connect/
  config.json                中继地址、令牌、口令、开关
  identity.json              本机 deviceId 与设备名
  peers.json                 对方设备名单
  index/<deviceId>.json      对方的会话索引
  remote/<deviceId>/<id>.json  对方会话的本地副本（只读，不会出现在普通会话列表里）
  outbox.json                中继断开时暂存待发信封
```

写入一律「临时文件 + 原子重命名」。对端会话副本**不注册进会话存储**，所以既不会混进
你的会话列表，也不会被误 resume。

---

## 实现要点

**它不自己解析会话文件。** 磁盘上的 `session.vN.jsonl.zstd` 是多个独立 zstd 帧首尾相接
（实测一个 199,882 字节的文件里 149 帧、解出 646,403 字节），带校验和与崩溃尾巴恢复。
插件一律走 `ctx.sessionQuery`（没有则退回 `ctx.sessionPersistence`），把逐帧、校验、
历史格式迁移都交给唯一正确的那个实现。

**索引很轻。** 一次 `list()` 拿全部 header，再用 `stat()` 的变更令牌判断哪条会话真的变了，
只重读变化的那条，折叠出标题、事件数、最近三句提问与任务计数。所以一个稳定的语料库
几乎不花代价。

**请求/响应先验证链路。** 中继重启后，旧 TCP 连接不会自己报错，socket 仍显示可写，
写进去的帧静默消失。所以发请求前先做一次 ping/pong 往返——完成了往返才算链路活着；
心跳发现对端不回 pong 时**强制拆掉 socket**（`close()` 在死连接上永远等不到握手完成，
重连路径就不会触发）。

**中继是敌意但有用的。** 它会丢、会重、会乱序、会扣着不发；但它改不了内容
（AAD 绑定收发双方），也读不出来。

## 已验证 / 未验证

| 部分 | 状态 |
|---|---|
| 中继 `relay/relay.cjs` | ✅ 端到端验证，28 项检查（真实 WebSocket 帧、掩码、分片、长度三种编码、离线信箱、上限与淘汰、长轮询、频道隔离、令牌门、重启后落盘恢复） |
| Host 半 + 客户端半 + 中继的联通 | ✅ 端到端验证，62 项检查：两台真实插件实例各自持有会话语料，经真实中继互通（密钥一致、索引过线、任务折叠、完整历史、按需抓取、无法伪造未抓取的会话、接管投喂、陌生账号进不来、篡改/换收件人被拒、设置往返） |
| 浏览器半渲染 | ✅ 80 项离线检查（把 `client.js` 当文本 eval，用桩 React 渲染面板，断言真机载荷下的输出）＋ 真机 GUI 无头 Chrome 打开面板逐项核对 |
| `deep-connect/relay/cloudflare` | ⚠️ **未运行过**（本机 `workers.dev` 被污染且没有账号）。按官方 API 写，首次 `wrangler deploy` 才是真测试 |
| `deep-connect/relay/deno` | ⚠️ **未运行过**。同上，协议与 `relay.cjs` 一致 |

跑测试：

```bash
node tools/relay-smoke.mjs        # 中继（28 项）
node tools/deep-connect-e2e.mjs   # 两台机器 + 中继（62 项）
node tools/client-check.mjs       # 浏览器半（80 项）
node ../tools/browser/check-connect.mjs   # 真机 GUI：面板真的渲染出来（需 GUI 在 19387 运行）
```

---

## 浏览器半重写（2026-10-15）

**症状**：点左侧「Deep Connect」主区域空白。控制台：

```
Error: Minified React error #31 … args[]=object with keys {title}
slot entry crashed in 'main'
```

**根因**：元素层是 `span(className, ...children)`，但调用点写的是
`span('dc_factValue', value, { title })`——`{title}` 被当成 **children** 交给 React。
真实 React 拒绝「对象作为子节点」并抛 error #31；槽位对抛错的 entry 的处理是**退出该 entry**，
于是 `main` 槽位里这个面板整个消失，只剩空主区域。
离线的 `client-check` 用桩 React，不做子节点校验，所以 70/70 通过却掩盖了真机崩溃——
这类差异只有真机（或严格桩）能发现。

**重写要点**：

1. **尾参数 props bag 是一等公民**：`element(tag, className, ...rest)` 若最后一个参数是朴素对象，
   就把它当 props（`{ title }` 变成属性），之前的参数才是 children。
2. **children 过白名单**：`renderable()` 丢掉 React 渲染不了的对象并 `console.warn`——
   即便将来再有人写错，也不会把对象交给 React，error #31 这一类从结构上不可能再现。
3. **注册永不抛出**：`apply()` 包 try/catch，失败也占住 `main` 槽位；
   面板渲染失败走 React **error boundary**（`PanelBoundary`）——只有 boundary 能接住
   React 渲染期抛出的异常，普通 `try` 包住 render 调用接不住（这正是上一版「已经 try 过了却还是空白」的原因）。
4. 离线桩没有类组件，`PanelBoundary` 只在有 `React.Component` 时构造，其余情况由 `PanelShell` 兜底。

**验证**：`client-check` 80/80（重写后新增 10 项：props bag 进 props 不进 children、className 合并、
bag 之前的 children 全部保留、child 位上的对象被丢弃、渲染失败被兜住并显示原因）；
`relay-smoke`、`deep-connect-e2e` 全过；真机 GUI 无头 Chrome 实测面板
（`[data-dc="panel"]` 1160×900，标题、本机/中继/指纹、本机 34 会话分组、任务 chips 全部就位，
控制台不再出现 `slot entry crashed in 'main'`）。

> Host 半与中继**未重写**：Host 的 `POST /api/deep-connect/api {action:"list"}` 实测返回完整视图，
> 中继与端到端各有真实 WebSocket 测试且全过。它们不在这条故障链上，重写只会引入新风险。

---

## 手动安装（不想跑脚本）

1. 把本目录链接进 profile：
   ```bash
   ln -s /绝对路径/dsh-deep-connect/plugin \
     ~/.dsh/profiles/desktop/node_modules/@local/dsh-deep-connect
   ```
2. 在 `~/.dsh/profiles/desktop/package.json` 里加依赖
   `"@local/dsh-deep-connect": "link:/绝对路径/dsh-deep-connect/plugin"`，
   并把 `@local/dsh-deep-connect` 加进 `dsh.profile.bundles`。
3. 在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾追加：
   ```yaml
   - insert:
       - id: deep-connect
         name: '@local/dsh-deep-connect'
         config:
           root: !!js dshHomePath('deep-connect')
           relayUrl: !!js process.env.DSH_DEEP_CONNECT_RELAY ?? ''
           secret: !!js process.env.DSH_DEEP_CONNECT_SECRET ?? ''
           indexIntervalMs: 15000
   ```
4. 重启 Harness。

---

## 仓库结构

| 路径 | 作用 |
|---|---|
| `plugin/` | 插件本体：`index.js`（Host 半）、`client.js`（浏览器半）、`host/`（加密、存储、会话读取、中继客户端）、`cordis.patch.yml`、`package.json` |
| `relay/` | 中继端：`relay.cjs`（零依赖单文件，已验证）、`install.sh`、`DEPLOY.md`、`cloudflare/`、`deno/`（云端版，未运行验证） |
| `install.sh` / `uninstall.sh` | 装/卸。支持本地 checkout 与 `curl \| bash` 远程安装，幂等并备份 |
| `tools/` | 三套测试：`relay-smoke.mjs`、`deep-connect-e2e.mjs`、`client-check.mjs` |
| `DESIGN.md` | 设计依据：为什么是这个形状、中继契约、密码学、数据流、磁盘布局 |

跑测试（只需要 Node ≥ 22，无依赖）：

```bash
node tools/relay-smoke.mjs
node tools/deep-connect-e2e.mjs
node tools/client-check.mjs
```

## 卸载

```bash
./uninstall.sh          # 移除配置行与链接，保留 ~/.dsh/deep-connect 数据
./uninstall.sh --purge  # 连数据、中继状态和下载的源码一起删
```

远程安装（`curl | bash`）后本仓库位于 `~/.dsh/plugins/dsh-deep-connect`，
卸载脚本也可以在仓库里跑 `./uninstall.sh`。

## 许可证

[MIT](LICENSE)。

---

## 与既有方案的关系

写这个插件之前先查过生态，有两类现成东西值得说明：

- **`dsh-session-sync`（Apache-2.0）** 已经能做跨设备会话同步，走的是 **git 镜像 + 三方合并**。
  它适合「事后对齐」，但需要一个两台机器都够得着的 git remote，没有在线状态、没有实时，
  也看不到对方此刻在不开着哪条会话。Deep Connect 走的是常驻中继，要的是「现在就能看见、
  点开就能读、还能把消息递过去」。
- **`@dshfly/remote-connector`、`onebox-dsh-bridge`（MIT）** 已经把「PC 主动外连的中继 +
  端到端加密 + 扫码配对」这套架构在**手机遥控电脑**上做成了产品，也解决过 DSH 的浏览器鉴权围栏。
  Deep Connect 和它们的差别是目标：这里要的是**同账号两台电脑之间的会话/任务对等同步**，
  而不是单机遥控。

## 已知边界

- **没有前向保密**：密钥由账号 id（或你的口令）派生，靠的是「只有同账号推导得出」。
  要做到「中继被攻破也解不开历史」，需要一次带外配对生成设备密钥，属于二期。
- **中继能看到元数据**：在线设备数、设备名、信封大小与时间。这些是路由必需的。
- **不做冲突合并**：一条会话只有一台机器写，所以不存在需要合并的分叉。真正的双向协同编辑
  不在范围内。
- **附件不同步**：对话里的图片/文件引用会出现在正文里，但字节不搬运。
- **接管是「远程投喂」而非「搬迁」**：会话留在原机器上执行。在一台机器上迁移整条会话
  需要独占租约，属于二期。
