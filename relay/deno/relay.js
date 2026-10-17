/**
 * Deep Connect relay — Deno Deploy.
 *
 * Same wire protocol as `relay.cjs` and the Cloudflare Worker, backed by Deno KV.
 * One KV key space per channel; the value is always opaque ciphertext.
 *
 * Plain JavaScript on purpose: Deno runs it as-is, with no build step.
 *
 * NOT VERIFIED. `deno.com` answers from this machine, but there was no Deno
 * Deploy project to run against, and the platform has documented caveats worth
 * knowing before you choose it: the free tier shuts an idle app down after
 * roughly 20-30 seconds, and a hibernating WebSocket relay has to be woken by
 * the next request. Long-poll clients therefore behave better here than sockets.
 * The self-hosted `relay.cjs` is the tested path.
 *
 * Deploy:
 *   # Deno Deploy's npm `deployctl` is a 48-byte placeholder — do not use it.
 *   # Create the project in the dashboard, connect this file, or use the HTTP API:
 *   #   https://api.deno.com/v2/docs
 *
 * Run locally:
 *   deno run --allow-net --allow-env relay/deno/relay.ts
 *
 * @typedef {{id: string, from: string, to: string, at: number, ttlMs: number, body: string, seq?: number, expiresAt?: number}} Envelope
 */

const MAX_MAILBOX = 512;
const MAX_WAIT_MS = 25_000;

const kv = await Deno.openKv();

/** One JSON response. */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Read and validate the caller's channel. */
function channelOf(request, url) {
  const channel = request.headers.get("x-dsh-connect-channel") ?? url.searchParams.get("channel") ?? "";
  return /^[0-9a-f]{32,128}$/.test(channel) ? channel : undefined;
}

/** The channel's roster, derived from the device records the relay keeps. */
async function roster(channel) {
  const out = [];
  for await (const entry of kv.list({ prefix: ["device", channel] })) {
    const device = entry.value;
    out.push({ id: device.id, name: device.name, online: device.online === true, lastSeen: device.lastSeen, pending: 0 });
  }
  return out;
}

/** Remember one device. */
async function rememberDevice(channel, deviceId, name) {
  const key = ["device", channel, deviceId];
  const existing = (await kv.get(key)).value;
  await kv.set(key, {
    id: deviceId,
    name: name || existing?.name || deviceId.slice(0, 8),
    lastSeen: Date.now(),
    seq: existing?.seq ?? 0,
  });
}

/**
 * Park one envelope for a recipient that is not connected.
 *
 * The sequence number is monotonic per recipient, so mailboxes drain in order.
 */
async function park(channel, envelope) {
  const deviceKey = ["device", channel, envelope.to];
  const device = (await kv.get(deviceKey)).value;
  const seq = (device?.seq ?? 0) + 1;
  await kv.set(deviceKey, { ...(device ?? { id: envelope.to, name: envelope.to.slice(0, 8) }), seq, lastSeen: Date.now() });
  const parked = { ...envelope, seq, expiresAt: Date.now() + envelope.ttlMs };
  await kv.set(["mail", channel, envelope.to, seq], parked, { expireIn: envelope.ttlMs });
  // Bound the mailbox: drop the oldest keys beyond the cap.
  const keys = [];
  for await (const entry of kv.list({ prefix: ["mail", channel, envelope.to] })) keys.push(entry.key);
  if (keys.length > MAX_MAILBOX) await kv.delete(keys.slice(0, keys.length - MAX_MAILBOX));
}

/** Who is connected right now, in this process. Sockets do not survive a restart. */
const live = new Map<string, Set<WebSocket>>();

/** Register one socket for a channel+device. */
function adopt(channel, deviceId, socket) {
  const key = `${channel}|${deviceId}`;
  let sockets = live.get(key);
  if (sockets === undefined) {
    sockets = new Set();
    live.set(key, sockets);
  }
  sockets.add(socket);
  socket.addEventListener("close", () => {
    sockets.delete(socket);
    if (sockets.size === 0) live.delete(key);
    void broadcastPresence(channel);
  });
  socket.addEventListener("error", () => {
    sockets.delete(socket);
    if (sockets.size === 0) live.delete(key);
  });
}

/** Every socket in one channel. */
function socketsOf(channel) {
  const out = [];
  for (const [key, sockets] of live) {
    if (!key.startsWith(`${channel}|`)) continue;
    for (const socket of sockets) out.push(socket);
  }
  return out;
}

/** Push a frame to every socket of one device. */
function sendTo(channel, deviceId, frame) {
  const sockets = live.get(`${channel}|${deviceId}`);
  if (sockets === undefined) return;
  const text = JSON.stringify(frame);
  for (const socket of sockets) {
    try {
      socket.send(text);
    } catch {
      /* a dead socket is removed by its close listener */
    }
  }
}

/** Tell every socket in the channel who is online. */
async function broadcastPresence(channel) {
  const frame = JSON.stringify({ type: "presence", devices: await roster(channel) });
  for (const socket of socketsOf(channel)) {
    try {
      socket.send(frame);
    } catch {
      /* ignore */
    }
  }
}

/** Route one envelope to a socket, or park it. */
async function route(channel, envelope) {
  const delivered = [];
  const queuedFor = [];
  const targets = envelope.to === "*"
    ? [...live.keys()].filter((key) => key.startsWith(`${channel}|`)).map((key) => key.slice(channel.length + 1)).filter((id) => id !== envelope.from)
    : [envelope.to];
  for (const targetId of targets) {
    const sockets = live.get(`${channel}|${targetId}`);
    if (sockets !== undefined && sockets.size > 0) {
      sendTo(channel, targetId, { type: "message", envelope });
      delivered.push(targetId);
      continue;
    }
    // Only park mail for a device the channel has seen before: otherwise anyone
    // holding the channel could make the relay allocate unbounded storage.
    const known = await kv.get(["device", channel, targetId]);
    if (known.value === null) continue;
    await park(channel, { ...envelope, to: targetId });
    queuedFor.push(targetId);
  }
  return { delivered, queuedFor };
}

/** One WebSocket upgrade. */
function handleUpgrade(request, channel) {
  const { socket, response } = Deno.upgradeWebSocket(request);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "open", at: Date.now() }));
  });
  let deviceId;
  socket.addEventListener("message", (event) => {
    void (async () => {
      let frame;
      try {
        frame = JSON.parse(String(event.data));
      } catch {
        socket.send(JSON.stringify({ type: "error", code: "bad-json" }));
        return;
      }
      if (frame.type === "hello") {
        deviceId = String(frame.deviceId ?? "").slice(0, 128);
        if (deviceId === "") {
          socket.send(JSON.stringify({ type: "error", code: "missing-device-id" }));
          return;
        }
        await rememberDevice(channel, deviceId, String(frame.name ?? "").slice(0, 120));
        adopt(channel, deviceId, socket);
        sendTo(channel, deviceId, { type: "welcome", deviceId, seq: 0, pending: 0 });
        await broadcastPresence(channel);
        return;
      }
      if (frame.type === "send" && frame.envelope !== undefined) {
        if (deviceId === undefined) {
          socket.send(JSON.stringify({ type: "error", code: "hello-required" }));
          return;
        }
        const raw = frame.envelope;
        const envelope = {
          id: String(raw.id ?? `m-${crypto.randomUUID()}`).slice(0, 128),
          from: deviceId,
          to: String(raw.to ?? "").slice(0, 128),
          at: Number(raw.at ?? Date.now()),
          ttlMs: Math.min(7 * 24 * 3600 * 1000, Math.max(1000, Number(raw.ttlMs ?? 7 * 24 * 3600 * 1000))),
          body: String(raw.body ?? ""),
        };
        const result = await route(channel, envelope);
        sendTo(channel, deviceId, { type: "sent", id: envelope.id, delivered: result.delivered, queuedFor: result.queuedFor });
        return;
      }
      if (frame.type === "ping") {
        socket.send(JSON.stringify({ type: "pong", at: Date.now() }));
      }
    })();
  });
  return response;
}

/** The HTTP entry point. */
Deno.serve(async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return json({ ok: true, relay: "deno-deploy" });

  const channel = channelOf(request, url);
  if (channel === undefined) return json({ error: "channel-required" }, 401);

  if (url.pathname === "/v1/devices") return json({ devices: await roster(channel) });

  if (url.pathname === "/v1/send" && request.method === "POST") {
    const body = await request.json().catch(() => undefined);
    if (body === undefined) return json({ error: "bad-json" }, 400);
    const from = String(body.deviceId ?? "");
    if (from === "") return json({ error: "deviceId-required" }, 400);
    await rememberDevice(channel, from, body.name);
    const envelope = {
      id: String(body.id ?? `m-${crypto.randomUUID()}`).slice(0, 128),
      from,
      to: String(body.to ?? "").slice(0, 128),
      at: Number(body.at ?? Date.now()),
      ttlMs: Math.min(7 * 24 * 3600 * 1000, Math.max(1000, Number(body.ttlMs ?? 7 * 24 * 3600 * 1000))),
      body: String(body.body ?? ""),
    };
    const result = await route(channel, envelope);
    return json({ id: envelope.id, delivered: result.delivered, queuedFor: result.queuedFor });
  }

  if (url.pathname === "/v1/recv" && (request.method === "GET" || request.method === "POST")) {
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    const deviceId = String(body.deviceId ?? url.searchParams.get("deviceId") ?? "");
    if (deviceId === "") return json({ error: "deviceId-required" }, 400);
    await rememberDevice(channel, deviceId, body.name);
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(0, Number(body.waitMs ?? url.searchParams.get("waitMs") ?? 0)));
    const deadline = Date.now() + waitMs;
    const collected = [];
    for await (const entry of kv.list({ prefix: ["mail", channel, deviceId] })) collected.push(entry.value);
    while (collected.length === 0 && Date.now() < deadline) {
      // Long-poll: this loop IS how a socket-less device stays current.
      await new Promise((resolve) => setTimeout(resolve, 250));
      for await (const entry of kv.list({ prefix: ["mail", channel, deviceId] })) collected.push(entry.value);
    }
    if (collected.length > 0) {
      const keys = [];
      for await (const entry of kv.list({ prefix: ["mail", channel, deviceId] })) keys.push(entry.key);
      await kv.delete(keys);
    }
    return json({ messages: collected, devices: await roster(channel) });
  }

  if (url.pathname === "/v1/ack" && request.method === "POST") return json({ acked: [] });

  if (request.headers.get("upgrade") === "websocket") return handleUpgrade(request, channel);

  return json({ error: "not-found" }, 404);
});
