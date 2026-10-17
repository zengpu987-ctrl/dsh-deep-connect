# 中继端部署

Deep Connect 的中继是一个**哑路由器**：它只知道 `channel`（账号的哈希）、
`deviceId`（信封上的收发人）和一串不透明密文。它读不到任何对话内容，也推不出密钥。

选哪条路，取决于两台机器**能不能互相看见**：

| 场景 | 用哪个 | 是否有账号/域名门槛 |
|---|---|---|
| 同一个局域网 / 同一个 VPN / Tailscale | [`install.sh`](install.sh)（本机起一个） | 无，零注册 |
| 一台常开的机器 + 公网可达 | [`install.sh --public`](install.sh) 或 VPS | 无 |
| 想让它长在云端、自己不维护机器 | [Cloudflare Workers](cloudflare/) | Cloudflare 账号（免费档够用） |
| 已经在用 Deno | [Deno Deploy](deno/) | Deno 账号（有坑，见文档末尾） |

协议在三条路里完全一致，所以**随时可以换**：换完在两台机器的面板里改一下中继地址即可，
密钥和 channel 不变，不需要重新配对。

---

## 1. 本机 / 局域网（推荐先走这条）

在**任意一台**两台机器都能访问到的电脑上：

```bash
cd deep-connect
./relay/install.sh
```

它会：检查 Node ≥ 22、在 `~/.dsh/deep-connect-relay/` 下建状态目录、后台启动中继、
等端口真的开始应答、然后打印**另一台机器该填的地址**。

```
Point every DSH at one of these:
  this machine    http://127.0.0.1:8790
  other machines  http://172.20.10.12:8790
```

然后**在每台机器上**打开 Deep Connect 面板 → 设置 → 填「中继地址」→ 保存。
两台机器显示的**密钥指纹必须一致**；不一致说明它们没有推算出同一把密钥
（通常是没有登录同一个 DeepSeek 账号，或者口令填得不一样）。

停止：`kill $(cat ~/.dsh/deep-connect-relay/relay.pid)`
看日志：`tail -f ~/.dsh/deep-connect-relay/relay.log`

### 常用参数

```bash
PORT=9000 ./relay/install.sh              # 换端口
RELAY_TOKEN=一串密钥 ./relay/install.sh   # 额外要求一个共享令牌
STATE_DIR=/var/lib/dc ./relay/install.sh  # 换状态目录
./relay/install.sh --public               # 同时打印公网 IP 和隧道建议
```

设了 `RELAY_TOKEN` 的话，每台机器的面板「访问令牌」里要填**同一个**值。

### 开机自启（macOS）

```bash
cat > ~/Library/LaunchAgents/com.dsh.deep-connect-relay.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.dsh.deep-connect-relay</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/绝对路径/deep-connect/relay/relay.cjs</string>
    <string>--host</string><string>0.0.0.0</string>
    <string>--port</string><string>8790</string>
    <string>--state</string><string>/Users/你的用户名/.dsh/deep-connect-relay/relay-state.json</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST
launchctl load ~/Library/LaunchAgents/com.dsh.deep-connect-relay.plist
```

把 `/usr/local/bin/node` 和路径换成 `which node` 与你的实际路径。

### 开机自启（Linux / systemd）

```ini
# /etc/systemd/system/dsh-deep-connect-relay.service
[Unit]
Description=Deep Connect relay
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/deep-connect/relay/relay.cjs --host 0.0.0.0 --port 8790 --state /var/lib/deep-connect/relay-state.json
Restart=always
User=deepconnect

[Install]
WantedBy=multi-user.target
```

### 出门在外也要连上

本机的端口在外面是看不见的。最省事的是 `cloudflared` 快速隧道：

```bash
cloudflared tunnel --url http://127.0.0.1:8790 --no-autoupdate
```

它会打印一个 `https://xxx.trycloudflare.com` 地址，把它填进两台机器的面板即可
（插件会把它转成 `wss://`）。

**注意**：快速隧道的域名**每次重启都会变**，而且官方明确说不保证可用性。所以它适合
「先用起来」，不适合长期方案。长期要么用固定域名的具名隧道，要么把中继放到 VPS/云端。

---

## 2. Cloudflare Workers + Durable Objects

**结论先说：从中国大陆用必须挂自定义域名。** 实测 `workers.dev` 在这个网络里解析到
`202.160.128.203`（典型的污染地址）并且连不上；`api.cloudflare.com` 是通的，所以部署本身没问题。

```bash
cd deep-connect/relay/cloudflare
npx wrangler login          # 走浏览器授权，需要你自己的账号
npx wrangler deploy
```

然后**必须**在 `wrangler.toml` 里打开 `routes`，把自定义域名填上（例如
`connect.你的域名.com`，在 Cloudflare 里代理），重新部署，用那个域名当**中继地址**。

免费档对一个账号几台桌面机是够的：每天 10 万请求、13000 GB·s 的 Durable Object 时长，
而 WebSocket 休眠（hibernation）让空闲连接的设备**不计时长**；每请求 10 ms CPU 对纯转发也够。

> ⚠️ 这个 Worker **没有在本机验证过**（没有 Cloudflare 账号可部署）。它是按官方 API 写的，
> 第一次 `wrangler deploy` 才是真正的测试。已验证可用的是 `relay.cjs`，两者协议一致。

---

## 3. Deno Deploy

```bash
# 不要用 npm 上的 deployctl：那是个 48 字节的占位包。
# 在 Deno Deploy 控制台新建项目并接上 relay/deno/relay.js，或用 HTTP API：
#   https://api.deno.com/v2/docs
```

选它之前先知道两件事：免费档**空闲约 20–30 秒就把应用停掉**（心跳长连接会被反复唤醒），
并且 `deployctl` 在 npm 上是假的。本插件的中继邮箱模式（`httpMode`）在 Deno Deploy 上
比 WebSocket 更稳，因为长轮询本身就是一个「有事才醒」的请求。

> ⚠️ 同样**未在本机验证**。协议与 `relay.cjs` 一致。

---

## 4. 自己的 VPS

直接用 `install.sh`，或者照 systemd 单元跑 `relay.cjs`。这是唯一「一定常开、一定不被
暂停」的方案，代价是要花钱。

如果 VPS 在国内且想用域名走 80/443，需要 ICP 备案；用裸 IP + 非 80/443 端口可以绕开。

---

## 安全边界

- **channel = SHA-256(账号 id)**，中继只见到这 64 位十六进制串，见不到账号 id。
- **密钥在自己机器上推导**（`PBKDF2(账号 id 或你的口令)`），从不上传。
- 每帧 **AES-256-GCM**，随机 nonce，并把 `信封 id | 发件人 | 收件人 | 协议版本` 作为
  AAD 一起鉴权——中继想在传输中改收件人，标签校验就会失败。
- 中继**能**看到的是：有多少台设备在线、设备名、信封大小和时间。这些是路由必需的元数据。
- 中继**不能**看到的是：对话标题、正文、工具调用、账号 id。

想更强（前向保密、可撤销设备）需要一次带外配对（二维码/短码）与设备密钥，属于二期。
