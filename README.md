# Deep Connect Pro

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

多台 DSH 通过**一键生成的中继站**互相看得见（v3 Pro 起不再依赖账号或手填地址）：

- **会话索引互见** —— 每台机器把本地会话的索引（标题、时间、消息数、最近几句提问、任务计数）
  加密广播给同账号的其它设备。
- **完整对话可读** —— 对端一出现，索引里的每条会话正文都会被自动拉下来（v2），
  点开即读、离线可看。
- **任务状态一致** —— todo / goal / 团队任务本身就是会话日志里的事件，跟着会话一起同步，
  索引行上直接显示「待办 N / 完成 N / 目标 / 团队 N」。
- **可接管** —— 在 B 机给 A 机开着的会话发消息。真正干活的是 A 机（模型、工具、文件都在 A 上），
  B 机看着结果。**一条会话永远只有一台机器在写**，所以只追加的事件日志不会分叉。
- **可继承** —— 也可以把 A 的会话连同完整事件日志搬成 B 上的一条新会话，用 B 的模型和工具
  接着干；A 上那条原样保留。
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
curl -fsSL https://cdn.jsdelivr.net/gh/zengpu987-ctrl/dsh-deep-connect@v4.0.5/install.sh | bash
```

备选（任选其一，都是同一个脚本）：

```bash
# 同上，但不带版本号（会取 main 上的最新安装器）
curl -fsSL https://cdn.jsdelivr.net/gh/zengpu987-ctrl/dsh-deep-connect@main/install.sh | bash
# GitHub 镜像
curl -fsSL https://gh-proxy.com/https://raw.githubusercontent.com/zengpu987-ctrl/dsh-deep-connect/main/install.sh | bash
# GitHub 直连（国内时通时断，带重试）
curl -fsSL --retry 5 --retry-all-errors https://raw.githubusercontent.com/zengpu987-ctrl/dsh-deep-connect/main/install.sh | bash
```

安装器只要求 `curl` + `tar` +（`node` 或 `python3` 之一，用来改 profile 的 JSON）。
macOS 自带 `python3`，因此没装 Node 的机器也能直接跑。

脚本内部的仓库下载也按实测顺序做了多路回退（codeload → ghproxy.net → gh-proxy.com → github.com）。

脚本会：优先从镜像下载仓库到 `~/.dsh/plugins/dsh-deep-connect` → 链接进 DSH 的
`desktop` profile → 写依赖、bundle 列表和 Loader 配置行。
**改任何文件前都会备份**，重复运行是幂等的。装完**完全退出并重开 Harness**。

想连中继地址一起写进去（这样面板里不用再填）：

```bash
# 注意：变量要放在 bash 前面（管道左侧只作用于 curl），或者先 export。
curl -fsSL https://cdn.jsdelivr.net/gh/zengpu987-ctrl/dsh-deep-connect@v4.0.5/install.sh \
  | RELAY_URL=http://172.20.10.12:8790 bash
```

等价写法：`export RELAY_URL=http://172.20.10.12:8790; curl ... | bash`。

非默认 profile（如 `web`）加 `PROFILE=web`；DSH 装在别处加 `DSH_HOME=/path/to/.dsh`。

### 2. 一键生成中继站（v3 Pro）

装好并重启 Harness 后，左侧 **Deep Connect Pro** 面板里只有两件事：

1. 在**任意一台**设备上点 **「一键生成中继站」**。本机会起一个中继进程；
   机器上有 `cloudflared` 时会顺手开一条 Cloudflare 快速隧道，于是得到一个
   **公网可达**的邀请链接；没有 `cloudflared` 就退化成**局域网链接**（面板会明说）。
2. 在**另一台**设备的「加入别人的中继站」里粘贴这条链接，点**加入**。两台设备就在同一个中继站里了。

> 链接形如 `https://xxxx.trycloudflare.com#<邀请令牌>`。令牌在 URL 的 `#` 后面——
> 浏览器和 WebSocket 都不会把它发给服务器，中继只看到频道哈希和密文。
> **链接就是邀请函**：谁拿到链接谁就能加入，请通过可信渠道发送。

想自己托管一个常开中继（VPS / 局域网服务器）仍然可以，见 [relay/DEPLOY.md](relay/DEPLOY.md)；
在面板里改填那条地址即可，协议与中继站完全一样。

---

## v4.0.5：跨机指令真的能落地——接力在本机跑、插话被服从、命令带工作区与模型强度

v4.0.4 及以前，**从另一台机器发过来的任何输入都进不了对端**。根因是一行签名：

```js
async prompt(request, signal) { signal.throwIfAborted(); /* … */ }
```

Host 的 Remote 方法由传输层补第二个参数 `AbortSignal`，而插件是**进程内直调**：
`sessionController.prompt(request)` 少传了 signal，于是在 `throwIfAborted` 处必抛
`TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`，
被 `servePrompt` / `serveTask` 的 catch 吞成 `accepted:false` 回给发送方。
插话、发布命令、手机下发共用这条路径，因此全部失效——而 e2e 一直全绿，
是因为测试桩的 `prompt` 不看第二个参数（4.0.5 起桩会抛同样的 TypeError，回归跑得出来）。

同版把三件事按使用方的语义补齐：

- **接力到本机 = 在本机把任务跑一遍。** 继承完事件日志后立刻向新本机会话投递一条
  「接力到本机，请把它完整跑一遍」的指令（附原任务正文），由本机的模型和工具真正执行；
  阅读器里的「继承到本机」仍是纯复制。回执带 `ran` / `task` / `runError`。
- **插话必须被听。** 仍走 `steer`，但对端回执带回**实际生效的投递方式**：只有真的进了
  运行中的那一轮才显示「已插话」，否则显示「已排队」，不再把排队冒充成插话。
- **发布命令带工作区与模型强度。** 对端的工作区列表与默认目录随索引广播；命令卡多了
  「对端工作区 / 模型强度 / 思考强度」三个下拉（默认取**本机**当前模型）。对端用
  `create({ workspaceId })` 落进指定工作区，再 `selectModel(…)` 装上本机选的模型强度，
  最后才投递任务；模型不可路由会明确失败，不静默降级。

兼容性：线协议仍是 v3，新增字段是**附加**的。4.0.4 的对端会忽略
`workspaces` / `model` / `workspaceId`，命令仍按它自己的默认目录与默认模型执行；
但 4.0.4 作为**接收方**依旧拒收一切输入（根因在接收方），所以两端都要升到 4.0.5。
对端偏旧时，失败信息会直接点明「对端插件低于 4.0.5」。

验证：`relay-smoke` 40 项、`client-check` 109 项、`deep-connect-e2e` 116 项，全过。

---

## v4.0.4：五项承诺的核实与补齐

逐条对照 4.0.x 的实现与测试，这一版补了三处真实缺口：

| 承诺 | 现状 | 证据 |
|---|---|---|
| 点检查更新直接装 | ✅ | 面板按钮 → `update-install`；下载 codeload（4.6 MB 实测）→ `tar` 解包 → 覆盖 `plugin/`；面板提示重启。客户端测试断言按钮发的是 `update-install` 而不是命令文本。 |
| 对话/轨迹分开 | ✅ | 阅读器两页签；`tool/call` 现在单独成行并标注「调用」（此前会落进普通 turn 的兜底标签）。 |
| 实时看进程 + 插话 | ✅ | 远程阅读器每 2.5 秒**强制拉一次新副本**（`fresh:true` 跳过缓存比较，此前受索引 15 秒节流影响并不实时）；插话走 `steer`，测试覆盖。 |
| 微信扫码管理 | ✅ | 令牌手机页（设备/任务/下发命令）＋可选隧道＋设置里的二维码；e2e 覆盖手机页 200、错令牌 404、手机下发命令在对方执行；QR src 断言覆盖。 |
| 默认留在中继站 | ✅（有边界） | 加入方持久化并自动重连；托管方用 detach 进程 + `station.json` 接续；**本轮新增**：接续失败时自动重建中继站，不再需要手点。**边界**：整机重启会杀掉 detach 进程，Cloudflare 快速隧道域名随之改变，托管方需要把新链接再发一次；要彻底免维护，需具名隧道或 VPS 中继。`退出中继站` 可永久退出。 |

---

## v4.0.3：v4.0.2 以下版本「窗口封死」

两条路一起封：

- **面板封死。** 运行的插件版本若低于 `MIN_VERSION`（4.0.2），客户端只渲染一屏
  「此版本已封停」＋升级命令，设备栏、会话、设置全部不出现；Host 端也只放行
  `list` / `update-check` / `update-install`，其它动作一律 `badRequest`。
- **中继站封死。** 中继新增 `--require-version <semver>`：中继站默认以
  `--require-version 4.0.2` 启动，握手和 HTTP 信箱都会检查 `ver` 参数
  （`x-dsh-connect-version` 头同样接受）。**没有上报版本**或低于下限的客户端
  直接吃 `426 version-refused`，邮件箱路径也拒绝。

客户端现在每次连接都会带 `ver=<PLUGIN_VERSION>`（WebSocket 查询参数与 HTTP 头各一份）。
版本号收敛到 [`plugin/host/version.js`](plugin/host/version.js) 一处：`PLUGIN_VERSION` 与
`MIN_VERSION` 同源，避免面板 / 中继 / 更新检查三处漂移。

> 手工用 `relay/install.sh` 起的中继不强制版本（那是自建部署的自由）；只有面板生成的
> 中继站会带上版本门槛。

---

## v4.0.2：更新检查不再被单个 CDN 的缓存骗到

4.0.1 的链路是「第一个成功即采用」。实测发现 jsDelivr 的包版本列表会滞后几分钟：
刚发 v4.0.1 后它仍返回 v4.0.0，先采用它就会让用户看不到新版本。

4.0.2 改成**所有来源都问一遍、取最高版本**：jsDelivr 包 API、GitHub tags、
raw.githubusercontent 的 `plugin/package.json`、curl、fetch 各自独立尝试，
任何一个成功都计入候选，最后按 semver 取最大值；`transport` 字段记录本次哪些来源成功。
全部失败仍是 10 分钟后重试，成功后 6 小时再查。

实测（本机代理环境）：`transport=jsdelivr+github+raw+curl+fetch`，`latest=4.0.1`。

---

## v4.0.1：修复自动检查更新

原来的检查更新用 `fetch` 直连 GitHub，而 DSH 宿主进程常带 `NODE_USE_ENV_PROXY=1`：
Node 会把 fetch 交给代理，代理到 `api.github.com` 的 TLS 经常被重置（`ECONNRESET`），
于是「检查更新」一直失败；GitHub 匿名 API 每小时 60 次的限流也会让 403 长期挂着。

4.0.1 把检查改成**多传输链**（[net.js](plugin/net.js)）：

1. **jsDelivr 包 API**（CDN，无匿名限流，列出同一批 tag）——首选；
2. **`node:https` 直连 GitHub tags**（绕过 fetch 的代理逻辑）；
3. **curl**（机器确实需要代理时兜底）；
4. `fetch`（最后）。

另外三处修正：

- **失败不再压 6 小时**：检查失败后 10 分钟重试；成功才推到 6 小时后。
- **每 30 分钟巡检一次**：`ctx.interval` 周期性调用，面板轮询自然看到新版本。
- **下载也走同一套**：`httpsDownload` 直连 codeload，失败依次退 ghproxy / gh-proxy，最后 curl；
  全部失败才报错，并把每条路线的错误一起显示。

实测（本机，GitHub API 已被限流 403）：检查经 jsDelivr 返回 `latest=4.0.0`，`transport=jsdelivr`；
`codeload` 直连下载 4.6 MB 成功。

---

## v4.0.0：一键自更新、对话/轨迹分栏、实时跟随与插话、微信扫码、默认留在中继站

- **检查更新直接装。** 「检查并更新」不再显示一条 curl：Host 下载对应 tag 的仓库包、
  用 `tar` 解到临时目录，再把 `plugin/`（以及 `relay/`）覆盖到正在运行的位置；
  面板提示「已更新到 vX，重启 Harness 后生效」。失败会明说原因，不会静默。
- **对话与轨迹分栏。** 阅读器顶部两个页签：**对话**（用户/助手的正文）与
  **轨迹**（工具调用、工具结果、系统/开发者事件）。`tool/call` 现在单独成一条轨迹，
  带工具名和参数，不再只藏在助手正文里。
- **实时跟随 + 插话。** 打开发往对端的会话时每 2.5 秒刷新一次，顶部显示「实时」；
  输入框的「插话」走 `steer`，直接进入对端正跑着的那一轮，「发送」则排队下一轮。
- **微信扫码手机管理。** 设置里开启「手机管理」后，本机启动一个带令牌的手机页面
  （设备列表、任务清单、给设备下发命令），有 cloudflared 时额外开一条隧道并显示二维码；
  微信扫一扫即可打开。令牌在路径里，错令牌一律 404。
- **默认留在中继站，可退出。** 加入过的中继站写入配置，重启/更新后自动重连；
  托管端的中继与隧道是 detach 进程并落盘 `station.json`，重启后自动接续（`adoptStation`）。
  想离开点「退出中继站」，退出后下次启动不再自动加入。**只有整机重启（断电/重启系统）
  会杀掉 detached 进程**，那时托管端需要重新生成一次链接——这是 Cloudflare 快速隧道的
  固有限制，不是配置丢失。

> 协议未变（仍是 v3 线协议），4.0.0 与 3.x 可以滚动升级、混跑。

---

## v3.0.2：任务面板、任务内容与接力、记忆共享开关

- **左侧设备栏。** 面板左边是设备列表（本机 + 每台对端，带在线灯、会话数、记忆共享状态），
  点某台设备就只看它的任务与会话；默认是「全部设备」总览。设置仍在右上角，管互联配置。
- **任务内容而不只是轨迹。** 索引里现在带任务正文（待办条目、团队任务、目标文案，每会话最多 12 条），
  设备详情直接列出任务清单；阅读器顶部也显示这条会话的任务内容，正文照旧是完整对话。
- **任务接力。** 每条对端任务/会话旁有「接力到本机」：把完整事件日志复制成本机一条新会话
  （同一套继承机制），随后自动切到本机设备、可以继续干；原会话留在对端。
- **记忆共享开关。** 设备栏上的开关控制本机是否把对话正文共享给中继站：关掉后只广播标题与
  任务计数，对端拉正文/继承都会被明确拒绝（`memory-sharing-off`），开关状态随索引广播。
- **更新不断联。** 中继站的中继与隧道改为 detach 启动并落盘 `station.json`：插件升级/重启后
  新进程直接接续同一个地址与邀请令牌（`adoptStation`），已加入的设备不用重新加入。
- **图标真的换了。** 侧边栏图标以前是 `client.js` 里内联的地球+链接，不是 `icon.svg`；
  现在两处都是「一台电脑—锁—另一台电脑」。

> 注意：v3.0.2 未改协议（仍是 v3），所以 3.0.0 / 3.0.1 / 3.0.2 之间可以滚动升级、混跑。

---

## v3.0.0 Pro（发布补丁 v3.0.1）：一键中继站、旧版失效、自动检查更新

- **中继站取代旧互联方式。** 不再需要在两台机器上填同一个中继地址、也不再靠账号或口令
  推出共享密钥：一台设备生成中继站，另一台粘贴链接加入。邀请令牌就是密钥输入。
- **3.0.0 Pro 以下全部失效。** 协议升到 v3：频道/密钥的域分隔符、AAD 里的版本号都变了，
  v2 客户端连帧都解不开；中继站还要求升级请求带 `proto=3`，旧客户端直接吃 `426 Upgrade Required`。
  旧版不是"被劝退"，而是**在协议层被拒绝**。
- **插件内自动检查更新。** Host 每 6 小时（面板首开也会查一次）向 GitHub 要最新 release，
  面板顶部出现「有新版本 vX」时，设置里会给出可直接复制的升级命令。
- **图标改成两台电脑相连**（`plugin/icon.svg`）。

---

## v2.0.0：出现彼此设备后立即全文同步，并且可继承

v2 把「点开才拉」变成「一出现就同步」：

- **自动全文同步**：只要对端出现在设备列表里，本机就把它索引里的**每一条会话正文**
  排队拉下来（`autoSyncHistory`，默认开），存进 `~/.dsh/deep-connect/remote/<设备>/`。
  列表行的 `hasCopy` 就是「这条正文已经在本机了」；离线也能照常阅读。
  一条只按 `(eventCount, updatedAt)` 变化过的会话才会重拉，稳定语料不产生流量。
- **打开即读**：阅读器先读本地副本，只有副本过期才发一次网络请求。
- **继承到本机**：阅读对端会话时，右下角的 **「继承到本机」** 会把那条会话的
  **原始事件日志**（不是摘要）经中继加密搬过来，用本机的 `sessionPersistence`
  落成一条**新的本地会话**，然后就能用本机的模型和工具接着干。原会话仍留在对端，
  两边各自追加，不会分叉。
- **接管仍在**：输入框发送 / 插话仍然是把消息交给拥有会话的那台机器执行
  （`sessionController.prompt`），适合「让那台机器继续跑」。

> 「继承」写的是真会话：新会话出现在普通会话列表里，可 resume、可改名、可继续。
> 单条上限 12 MB（中继单帧 16 MB），超了会明确拒绝而不是悄悄截断。
> 本机没挂载 `sessionPersistence` 的部署会直接说明无法继承。

发版检查：`node tools/station-smoke.mjs` 真起一个中继站（relay 子进程 + cloudflared 隧道）并验证令牌、`proto=3` 门禁与邀请链接往返；`node tools/deep-connect-e2e.mjs` 覆盖了自动全文同步、缓存优先读取、
继承落地等路径（103 项），`relay-smoke`（40 项）与 `client-check`（101 项）不变。


---

## 面板里能看到什么

| 区域 | 内容 |
|---|---|
| 顶部 | 本机名、连接状态灯、中继地址、密钥指纹、重新连接 / 设置 |
| 设置 | 中继地址、访问令牌（可选）、共享口令（可选）、设备名、自动同步索引、保存 |
| 设备 | 每台对端：名字、设备 id、在线徽标、最后在线时间、会话数 |
| 会话 | 「本机」与每台对端一组：标题、相对时间、会话 id、事件数、cwd、任务标签、最后一句提问预览 |
| 阅读 | 点开任一条：完整正文（先读本机副本），工具调用可折叠、报错的工具红色显示；底部可继续对话，对端会话右下角有「继承到本机」 |

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
  remote/<deviceId>/<id>.json  对方会话的本地副本（只读，自动同步而来，不注册进本机会话列表）
  outbox.json                中继断开时暂存待发信封
```

写入一律「临时文件 + 原子重命名」。对端会话副本**不注册进会话存储**，所以既不会混进
你的会话列表，也不会被误 resume；只有你主动点「继承到本机」时，才会通过
`sessionPersistence.create/append/flush` 写出一条新的**本机会话**，那条和普通会话一样
出现在列表里、可以 resume。

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
| 中继 `relay/relay.cjs` | ✅ 端到端验证，40 项检查（真实 WebSocket 帧、掩码、分片、长度三种编码、离线信箱与重连排空、半开连接离场、上限与淘汰、长轮询、频道隔离、令牌门、重启后落盘恢复） |
| Host 半 + 客户端半 + 中继的联通 | ✅ 端到端验证，103 项检查：两台真实插件实例各自持有会话语料，经真实中继互通（密钥一致、索引过线、任务折叠、完整历史、**设备一出现就自动全文同步**、**缓存优先读取**、**继承成本机会话且事件逐条重排**、无法伪造未抓取的会话、接管投喂、陌生账号进不来、篡改/换收件人被拒、设置往返） |
| 浏览器半渲染 | ✅ 101 项离线检查（把 `client.js` 当文本 eval，用桩 React 渲染面板，断言真机载荷下的输出）＋ 真机 GUI 无头 Chrome 打开面板逐项核对 |
| `deep-connect/relay/cloudflare` | ⚠️ **未运行过**（本机 `workers.dev` 被污染且没有账号）。按官方 API 写，首次 `wrangler deploy` 才是真测试 |
| `deep-connect/relay/deno` | ⚠️ **未运行过**。同上，协议与 `relay.cjs` 一致 |

跑测试：

```bash
node tools/relay-smoke.mjs        # 中继（40 项）
node tools/station-smoke.mjs      # 一键中继站：真起 relay + cloudflared + 接续（17 项）
node tools/deep-connect-e2e.mjs   # 两台机器 + 中继（103 项）
node tools/client-check.mjs       # 浏览器半（101 项）
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
| `plugin/` | 插件本体：`index.js`（Host 半）、`client.js`（浏览器半）、`host/`（加密、存储、会话读取、中继客户端、继承写入 `inherit.js`）、`cordis.patch.yml`、`package.json` |
| `relay/` | 中继端：`relay.cjs`（零依赖单文件，已验证）、`install.sh`、`DEPLOY.md`、`cloudflare/`、`deno/`（云端版，未运行验证） |
| `install.sh` / `uninstall.sh` | 装/卸。支持本地 checkout 与 `curl \| bash` 远程安装，幂等并备份 |
| `tools/` | 三套测试：`relay-smoke.mjs`、`deep-connect-e2e.mjs`、`client-check.mjs` |
| `DESIGN.md` | 设计依据：为什么是这个形状、中继契约、密码学、数据流、磁盘布局 |

跑测试（只需要 Node ≥ 22，无依赖）：

```bash
node tools/relay-smoke.mjs
node tools/station-smoke.mjs
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

## 论文

本仓库附带一篇 Nature 格式的技术论文（英文 18 页，另有中文版），记录设计、协议、密码学、威胁模型、实测数据与故障目录：

- 英文：`paper/DeepConnect-Nature-EN.pdf`
- 中文：`paper/DeepConnect-Nature-ZH.pdf`
- 源文件：`paper/`（`src/` 为中英文正文与元数据，`measure.mjs` 采集数据，`make_figures.py` 出图，47 篇参考文献）

复现：

```bash
node paper/measure.mjs          # 采集真实测量数据 -> paper/data/metrics.json
python3 paper/make_figures.py   # 生成中英文图表 -> paper/assets/
python3 paper/build.py          # 生成 HTML -> paper/build/
node paper/render.mjs           # 渲染 PDF
```

论文中的每个数字都来自 `paper/data/metrics.json`，构建脚本在占位符缺失时会失败，因此正文与图表不会漂移。

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
