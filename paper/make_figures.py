#!/usr/bin/env python3
"""Deep Connect — figures for the paper (English and Chinese variants).

Data figures read paper/data/metrics.json, which is produced by measure.mjs
against the shipped code. Diagrams are drawn from the design in DESIGN.md.
Both languages are generated from one spec so the two papers cannot drift.
"""
import json
import os
from pathlib import Path

os.environ.setdefault("MPLCONFIGDIR", str(Path(__file__).resolve().parent.parent.parent / ".mpl"))
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Rectangle, Circle
from matplotlib.lines import Line2D

ROOT = Path(__file__).resolve().parent
ASSETS = ROOT / "assets"
ASSETS.mkdir(exist_ok=True)
METRICS = json.loads((ROOT / "data" / "metrics.json").read_text())

INK = "#1d1d1f"
MUTED = "#6e6e73"
LINE = "#d2d2d7"
BLUE = "#2563eb"
GREEN = "#15803d"
AMBER = "#b45309"
RED = "#b91c1c"
PANEL = "#f7f7f9"
FONT_EN = "Avenir Next"
# PingFang SC is not installed under that name; these carry CJK plus Latin.
FONT_ZH = "Arial Unicode MS"

# Text used by diagrams, keyed so both languages stay in sync.
T = {
    "en": {
        "device": "DSH install", "browser": "Browser panel", "host": "Host half",
        "relay": "Relay (self-hosted)", "channel": "channel = SHA-256(account id)",
        "mailbox": "offline mailbox", "cipher": "ciphertext only",
        "same_origin": "same-origin /api", "wss": "WSS, AES-256-GCM",
        "account": "signed-in account", "key": "frame key (never leaves device)",
        "passphrase": "or shared passphrase", "aad": "AAD: id | from | to | version",
        "nonce": "nonce", "tag": "tag", "body": "ciphertext (base64)",
        "route": "routing fields (plaintext)", "payload": "payload (encrypted)",
        "presence": "presence", "index": "index broadcast", "request": "history request",
        "response": "history response", "prompt": "prompt handoff", "drain": "mailbox drain",
        "time": "time", "seal": "seal throughput", "open": "open throughput",
        "payload_kb": "payload size (KiB)", "mbps": "MB s$^{-1}$", "rtt": "round-trip time (ms)",
        "cdf": "fraction of exchanges", "sessions": "indexed sessions", "buildms": "index build (ms)",
        "wirekb": "index size (KiB)", "turns": "conversation turns", "transcriptkb": "transcript wire size (KiB)",
        "threat": "what each party observes", "sees": "observes", "partial": "partial", "no": "does not observe",
        "relayop": "relay operator", "netobs": "network observer", "peer": "peer device", "local": "local user",
        "account": "account id", "titles": "session titles", "transcripts": "transcripts", "prompts": "prompt text",
        "names": "device names", "sizes": "envelope sizes / times", "hash": "channel hash",
        "kdf": "key derivation (ms)", "hist": "share of runs", "count": "envelopes",
        "drainms": "drain (ms)", "detectms": "disconnect detection (ms)",
        "lifecycle": "offline interval, reconnect and drain",
        "e1": "envelopes queued while the peer is offline", "e2": "peer reconnects",
        "e3": "queued envelopes delivered", "e4": "presence update",
        "lan": "same LAN", "vps": "VPS with TLS", "tunnel": "managed tunnel",
        "relay": "relay", "proxy": "TLS proxy", "cloud": "tunnel provider",
        "devA": "device A", "devB": "device B", "outbound": "outbound only",
    },
    "zh": {
        "device": "DSH 安装", "browser": "浏览器面板", "host": "宿主半",
        "relay": "中继（自建）", "channel": "channel = SHA-256(账号 id)",
        "mailbox": "离线信箱", "cipher": "仅密文",
        "same_origin": "同源 /api", "wss": "WSS，AES-256-GCM",
        "account": "已登录账号", "key": "帧密钥（不离开设备）",
        "passphrase": "或共享口令", "aad": "AAD：id | 发件 | 收件 | 版本",
        "nonce": "nonce", "tag": "标签", "body": "密文（base64）",
        "route": "路由字段（明文）", "payload": "载荷（加密）",
        "presence": "在场广播", "index": "索引广播", "request": "历史请求",
        "response": "历史应答", "prompt": "消息投喂", "drain": "信箱排空",
        "time": "时间", "seal": "封装吞吐", "open": "解封吞吐",
        "payload_kb": "载荷大小（KiB）", "mbps": "MB s$^{-1}$", "rtt": "往返时延（ms）",
        "cdf": "交换占比", "sessions": "索引会话数", "buildms": "索引构建（ms）",
        "wirekb": "索引大小（KiB）", "turns": "对话轮数", "transcriptkb": "历史传输大小（KiB）",
        "threat": "各参与方能观察到什么", "sees": "可见", "partial": "部分", "no": "不可见",
        "relayop": "中继运营方", "netobs": "网络观察者", "peer": "对端设备", "local": "本机用户",
        "account": "账号 id", "titles": "会话标题", "transcripts": "对话正文", "prompts": "提问内容",
        "names": "设备名", "sizes": "信封大小与时间", "hash": "channel 哈希",
        "kdf": "密钥派生（ms）", "hist": "运行占比", "count": "信封数",
        "drainms": "排空（ms）", "detectms": "断连检测（ms）",
        "lifecycle": "离线区间、重连与排空",
        "e1": "对端离线期间积压的信封", "e2": "对端重连",
        "e3": "积压信封被投递", "e4": "在场状态更新",
        "lan": "同一局域网", "vps": "带 TLS 的云主机", "tunnel": "托管隧道",
        "relay": "中继", "proxy": "TLS 代理", "cloud": "隧道服务",
        "devA": "设备 A", "devB": "设备 B", "outbound": "仅出站",
    },
}


def setup(lang):
    font = [FONT_ZH, "Hiragino Sans GB", "Heiti TC"] if lang == "zh" else FONT_EN
    plt.rcParams.update({
        "font.family": font,
        "font.size": 8.4,
        "axes.linewidth": 0.8,
        "axes.edgecolor": LINE,
        "axes.labelcolor": INK,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "text.color": INK,
        "axes.titlesize": 8.8,
        "axes.titleweight": "semibold",
        "figure.dpi": 300,
        "savefig.dpi": 300,
        "savefig.bbox": "tight",
        "savefig.pad_inches": 0.03,
    })


def box(ax, x, y, w, h, title, lines=(), fill="white", edge=LINE, lw=1.0, title_size=8.6, body_size=7.2, color=INK):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.015,rounding_size=0.10",
                                linewidth=lw, edgecolor=edge, facecolor=fill, zorder=2))
    ax.text(x + w / 2, y + h - 0.12, title, ha="center", va="top", fontsize=title_size,
            fontweight="semibold", color=color, zorder=3)
    for i, line in enumerate(lines):
        ax.text(x + w / 2, y + h - 0.74 - i * 0.34, line, ha="center", va="top",
                fontsize=body_size, color=MUTED, zorder=3)


def arrow(ax, start, end, color=INK, style="-|>", lw=1.0, curve=0.0, ls="-", label=None, label_offset=(0, 0), fontsize=7.0):
    ax.add_patch(FancyArrowPatch(start, end, arrowstyle=style, mutation_scale=8,
                                 linewidth=lw, color=color, linestyle=ls, zorder=1,
                                 connectionstyle=f"arc3,rad={curve}", shrinkA=2, shrinkB=2))
    if label:
        mx, my = (start[0] + end[0]) / 2 + label_offset[0], (start[1] + end[1]) / 2 + label_offset[1]
        ax.text(mx, my, label, ha="center", va="bottom", fontsize=fontsize, color=color)


def plain(ax, xlim=(0, 10), ylim=(0, 10)):
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.axis("off")


def save(fig, name):
    fig.savefig(ASSETS / name)
    plt.close(fig)


# ------------------------------------------------------------------ figure 1
def fig_architecture(lang):
    t = T[lang]
    setup(lang)
    fig, ax = plt.subplots(figsize=(7.1, 3.3))
    plain(ax, (0, 10), (0, 10))

    def device(x, name):
        ax.add_patch(FancyBboxPatch((x, 1.15), 2.6, 6.9, boxstyle="round,pad=0.02,rounding_size=0.10",
                                    fill=False, edgecolor=INK, linewidth=1.2, zorder=1))
        ax.text(x + 0.14, 7.75, name, fontsize=10, fontweight="bold", color=INK, va="top")
        box(ax, x + 0.22, 5.35, 2.16, 1.45, t["browser"], [t["same_origin"]], fill="#eef2ff", edge="#c7d2fe", title_size=8.0, body_size=6.6)
        box(ax, x + 0.22, 2.95, 2.16, 1.55, t["host"], [t["wss"]], fill=PANEL, title_size=8.0, body_size=6.4)
        arrow(ax, (x + 1.3, 5.30), (x + 1.3, 4.55), color=BLUE, lw=0.9)

    device(0.25, "A")
    device(7.15, "B")

    # Relay.
    ax.add_patch(FancyBboxPatch((3.5, 1.15), 3.0, 6.9, boxstyle="round,pad=0.02,rounding_size=0.10",
                                facecolor="#f0fdf4", edgecolor=GREEN, linewidth=1.2, zorder=1))
    ax.text(5.0, 7.62, t["relay"], ha="center", va="top", fontsize=8.4, fontweight="semibold", color=GREEN)
    ax.text(5.0, 6.95, t["channel"], ha="center", va="top", fontsize=6.2, color=MUTED)
    box(ax, 3.72, 4.45, 2.56, 1.55, t["mailbox"], [], fill="white", edge="#bbf7d0", title_size=7.6)
    ax.text(5.0, 4.05, t["route"], ha="center", fontsize=6.2, color=MUTED,
            family="monospace" if lang == "en" else FONT_ZH)
    ax.text(5.0, 3.62, "no account id, no plaintext" if lang == "en" else "无账号 id，无明文", ha="center", fontsize=6.0, color=GREEN)
    envelope_note = "envelope = {id, from, to, at} + body" if lang == "en" else "信封 = {id, from, to, at} + 密文体"
    ax.text(5.0, 3.05, envelope_note, ha="center", fontsize=5.8, color=MUTED,
            family="monospace" if lang == "en" else FONT_ZH)

    # Links + labels.
    arrow(ax, (2.88, 3.75), (3.47, 3.95), color=INK, lw=1.1)
    arrow(ax, (6.53, 3.95), (7.12, 3.75), color=INK, lw=1.1)
    ax.text(3.17, 3.35, "WSS", ha="center", fontsize=6.2, color=INK)
    ax.text(6.82, 3.35, "WSS", ha="center", fontsize=6.2, color=INK)
    ax.text(5.0, 0.55, "the relay routes ciphertext; it never holds a key" if lang == "en"
            else "中继只转发密文，从不持有密钥", ha="center", fontsize=6.8, color=MUTED)
    save(fig, f"fig1-architecture-{lang}.png")


# ------------------------------------------------------------------ figure 2
def fig_envelope(lang):
    t = T[lang]
    setup(lang)
    fig, ax = plt.subplots(figsize=(7.1, 3.1))
    plain(ax, (0, 10), (0, 10))

    def lane(y, title, sub, box_title, box_lx, box_rx, out):
        box(ax, box_lx, y - 0.95, 2.45, 1.9, title, [sub], fill="#eef2ff" if "account" in title.lower() or "账号" in title else PANEL,
            edge="#c7d2fe" if ("account" in title.lower() or "账号" in title) else LINE, title_size=7.6, body_size=6.4)
        ax.add_patch(FancyBboxPatch((box_rx, y - 0.55), 1.55, 1.1, boxstyle="round,pad=0.02,rounding_size=0.08",
                                    facecolor="white", edgecolor=LINE, linewidth=1.0, zorder=2))
        ax.text(box_rx + 0.775, y, box_title, ha="center", va="center", fontsize=6.8, fontweight="semibold", zorder=3)
        arrow(ax, (box_lx + 2.38, y), (box_rx - 0.02, y), color=BLUE, lw=0.9)
        ax.text(box_rx + 0.775, y - 1.05, out, ha="center", fontsize=6.4, color=MUTED)

    ax.text(0.9, 9.55, "channel" if lang == "en" else "channel", ha="center", fontsize=6.6, color=GREEN, family="monospace")
    lane(8.35, t["account"], t["account"] if False else ("id (opaque)" if lang == "en" else "账号标识（不透明）"),
         "SHA-256", 0.2, 3.15, "channel (64 hex)" if lang == "en" else "channel（64 位十六进制）")
    lane(6.25, t["passphrase"], "replaces the account id" if lang == "en" else "可替代账号标识",
         "PBKDF2-HMAC\nSHA-256, 210k" if lang == "en" else "PBKDF2-HMAC\nSHA-256，210k", 0.2, 3.0,
         "32-byte frame key" if lang == "en" else "32 字节帧密钥")

    # Envelope box on the right.
    ax.add_patch(FancyBboxPatch((6.0, 1.05), 3.8, 7.5, boxstyle="round,pad=0.02,rounding_size=0.10",
                                facecolor="white", edgecolor=INK, linewidth=1.2, zorder=2))
    ax.text(7.9, 8.95, "envelope" if lang == "en" else "信封", ha="center", fontsize=8.2, fontweight="semibold")
    rows = [
        ("id, from, to, at", t["route"], MUTED),
        ("nonce (12 B)", "", BLUE),
        ("tag (16 B)", "", AMBER),
        ("ciphertext", t["payload"], GREEN),
    ]
    y = 8.2
    for name, note, color in rows:
        ax.text(6.2, y, name, fontsize=6.8, family="monospace", color=color, va="center")
        if note:
            ax.text(6.2, y - 0.38, note, fontsize=5.9, color=MUTED, va="center")
            y -= 1.05
        else:
            y -= 0.62
    ax.text(6.2, 3.85, t["aad"], fontsize=6.0, color=AMBER, va="center")
    ax.text(6.2, 3.15, "body = base64(nonce ‖ tag ‖ ct)", fontsize=6.2, family="monospace", va="center")
    ax.text(6.2, 2.45, "only routing metadata is clear" if lang == "en" else "明文只有路由元数据", fontsize=6.0, color=MUTED)
    ax.text(6.2, 1.75, "the key never leaves the device" if lang == "en" else "密钥永不离开设备", fontsize=6.0, color=RED)

    arrow(ax, (4.75, 6.1), (5.95, 5.5), color=RED, lw=1.0, ls=":")
    ax.text(5.05, 6.15, "seal" if lang == "en" else "封装", fontsize=6.2, color=RED)
    save(fig, f"fig2-envelope-{lang}.png")


# ------------------------------------------------------------------ figure 3
def fig_sequence(lang):
    t = T[lang]
    setup(lang)
    fig, ax = plt.subplots(figsize=(7.1, 3.9))
    plain(ax, (0, 10), (0, 10))
    lanes = {"A": 1.35, "R": 5.0, "B": 8.65}
    labels = {"A": "DSH A", "R": "Relay" if lang == "en" else "中继", "B": "DSH B"}
    widths = {"A": 1.7, "R": 1.5, "B": 1.7}
    for key, x in lanes.items():
        half = widths[key] / 2
        ax.add_patch(FancyBboxPatch((x - half, 8.7), widths[key], 0.75, boxstyle="round,pad=0.02,rounding_size=0.10",
                                    facecolor=PANEL, edgecolor=LINE))
        ax.text(x, 9.08, labels[key], ha="center", va="center", fontsize=7.6, fontweight="semibold")
        ax.plot([x, x], [1.0, 8.6], color=LINE, lw=1.0, zorder=0)

    def msg(y, src, dst, label, color=INK, dashed=False, note=None):
        x1, x2 = lanes[src], lanes[dst]
        arrow(ax, (x1, y), (x2, y), color=color, lw=1.1, ls=(0, (4, 2)) if dashed else "-")
        ax.text((x1 + x2) / 2, y + 0.10, label, ha="center", fontsize=6.9, color=color)
        if note:
            ax.text((x1 + x2) / 2, y - 0.34, note, ha="center", fontsize=6.0, color=MUTED)

    ax.text(0.15, 7.95, "1", fontsize=7.6, fontweight="bold", color=BLUE)
    msg(7.75, "A", "R", "hello" if lang == "en" else "hello", BLUE)
    msg(7.25, "R", "B", "presence" if lang == "en" else "presence", GREEN)
    ax.text(0.15, 6.55, "2", fontsize=7.6, fontweight="bold", color=BLUE)
    msg(6.35, "A", "R", t["index"], BLUE, note="sealed, to *" if lang == "en" else "加密，广播")
    msg(5.85, "R", "B", t["index"], GREEN)
    ax.text(0.15, 5.15, "3", fontsize=7.6, fontweight="bold", color=BLUE)
    msg(4.95, "B", "R", t["request"], BLUE, note="requestId inside payload" if lang == "en" else "requestId 在密文内")
    msg(4.45, "R", "A", t["request"], GREEN)
    msg(3.95, "A", "R", t["response"], AMBER)
    msg(3.45, "R", "B", t["response"], AMBER)
    ax.text(0.15, 2.75, "4", fontsize=7.6, fontweight="bold", color=BLUE)
    msg(2.55, "B", "R", t["prompt"], RED, note="single writer stays on A" if lang == "en" else "写入仍在 A 机")
    msg(2.05, "R", "A", t["prompt"], RED)
    msg(1.55, "A", "R", "ack", MUTED, dashed=True)
    save(fig, f"fig3-sequence-{lang}.png")


# ------------------------------------------------------------------ figure 4
def fig_performance(lang):
    t = T[lang]
    setup(lang)
    fig, axes = plt.subplots(2, 2, figsize=(7.1, 5.2))

    # (a) seal/open throughput.
    ax = axes[0][0]
    sizes = [row["size"] for row in METRICS["sealThroughput"]]
    seal = [row["mbPerSec"] for row in METRICS["sealThroughput"]]
    opn = [row["mbPerSec"] for row in METRICS["openThroughput"]]
    ax.plot(sizes, seal, marker="o", color=BLUE, label=t["seal"], lw=1.3, ms=3.4)
    ax.plot(sizes, opn, marker="s", color=AMBER, label=t["open"], lw=1.3, ms=3.2)
    ax.set_xscale("log", base=2)
    ax.set_xlabel(t["payload_kb"])
    ax.set_ylabel(t["mbps"])
    ax.set_ylim(bottom=0)
    ax.set_title("a  AES-256-GCM", loc="left")
    ax.grid(True, color="#eef0f3", lw=0.8)
    ax.legend(frameon=False, fontsize=7, loc="lower right")

    # (b) RTT CDF.
    ax = axes[0][1]
    for key, color, label in (("rtt_1k_ms", BLUE, "1 KiB"), ("rtt_64k_ms", AMBER, "64 KiB")):
        values = np.sort(METRICS["samples"][key])
        ax.plot(values, np.arange(1, len(values) + 1) / len(values), color=color, lw=1.4, label=label)
    ax.set_xlabel(t["rtt"])
    ax.set_ylabel(t["cdf"])
    ax.set_title("b  round trip through the relay", loc="left")
    ax.grid(True, color="#eef0f3", lw=0.8)
    ax.legend(frameon=False, fontsize=7, loc="lower right")

    # (c) index build and size.
    ax = axes[1][0]
    rows = METRICS["indexScale"]
    xs = [row["sessions"] for row in rows]
    ax.plot(xs, [row["buildMs"] for row in rows], marker="o", color=GREEN, lw=1.3, ms=3.4)
    ax.set_xlabel(t["sessions"])
    ax.set_ylabel(t["buildms"], color=GREEN)
    ax.tick_params(axis="y", colors=GREEN)
    ax2 = ax.twinx()
    ax2.plot(xs, [row["wireBytes"] / 1024 for row in rows], marker="s", color=BLUE, lw=1.2, ms=3.2)
    ax2.set_ylabel(t["wirekb"], color=BLUE)
    ax2.tick_params(axis="y", colors=BLUE)
    ax.set_title("c  conversation index", loc="left")
    ax.grid(True, color="#eef0f3", lw=0.8)

    # (d) transcript size.
    ax = axes[1][1]
    rows = METRICS["transcripts"]
    turns = [row["turns"] for row in rows]
    wire = [row["wireBytes"] / 1024 for row in rows]
    ax.plot(turns, wire, marker="o", color=RED, lw=1.4, ms=3.6)
    for turn, kb in zip(turns, wire):
        ax.annotate(f"{kb:.0f} KiB", (turn, kb), textcoords="offset points",
                    xytext=(6, -10), fontsize=6.2, color=MUTED)
    ax.set_xscale("log")
    ax.set_yscale("log")
    ax.set_xlabel(t["turns"])
    ax.set_ylabel(t["transcriptkb"])
    ax.set_title("d  transcript pull", loc="left")
    ax.grid(True, which="both", color="#eef0f3", lw=0.8)

    fig.tight_layout(pad=0.8, w_pad=1.2, h_pad=1.2)
    save(fig, f"fig4-performance-{lang}.png")


# ------------------------------------------------------------------ figure 5
def fig_threat(lang):
    t = T[lang]
    setup(lang)
    fig, ax = plt.subplots(figsize=(7.1, 2.9))
    plain(ax, (0, 10), (0, 10))

    rows = ["hash", "account", "names", "sizes", "titles", "transcripts", "prompts"]
    cols = ["relayop", "netobs", "peer", "local"]
    # 2 = observes, 1 = partial, 0 = does not observe.
    matrix = [
        [2, 0, 0, 0],   # channel hash: relay keys its room by it; it never travels in clear
        [0, 0, 1, 2],   # account id: never sent; peers only derive the same channel
        [2, 0, 2, 2],   # device names: relay roster, peer roster, local UI
        [2, 1, 0, 2],   # envelope sizes/times: relay yes, network partial (TLS records)
        [0, 0, 2, 2],   # titles
        [0, 0, 2, 2],   # transcripts
        [0, 0, 2, 2],   # prompts
    ]
    colors = {2: "#1d4ed8", 1: "#93c5fd", 0: "#f1f5f9"}
    labels = {2: t["sees"], 1: t["partial"], 0: t["no"]}

    x0, y0, w, h = 2.35, 0.85, 1.75, 0.98
    for j, col in enumerate(cols):
        ax.text(x0 + j * w + w / 2, y0 + len(rows) * h + 0.35, t[col], ha="center", fontsize=7.4, fontweight="semibold")
    for i, row in enumerate(rows):
        y = y0 + (len(rows) - 1 - i) * h
        ax.text(x0 - 0.15, y + h / 2, t[row], ha="right", va="center", fontsize=7.4)
        for j in range(len(cols)):
            value = matrix[i][j]
            ax.add_patch(Rectangle((x0 + j * w, y), w - 0.06, h - 0.06, facecolor=colors[value], edgecolor="none"))
            ax.text(x0 + j * w + (w - 0.06) / 2, y + (h - 0.06) / 2, labels[value], ha="center", va="center",
                    fontsize=6.3, color="white" if value == 2 else MUTED)
    ax.text(x0, 9.4, t["threat"], fontsize=8.2, fontweight="semibold")
    ax.text(0.15, 0.35, "E2E: relay and network observe neither content nor account id"
            if lang == "en" else "端到端：中继与网络都看不到正文，也看不到账号 id", fontsize=6.8, color=GREEN)
    save(fig, f"fig5-threat-{lang}.png")


# --------------------------------------------------------------- extended data
def fig_ed_raw(lang):
    t = T[lang]
    setup(lang)
    fig, axes = plt.subplots(1, 3, figsize=(7.1, 1.95))
    ax = axes[0]
    ax.hist(METRICS["samples"]["kdf_ms"], bins=9, color="#93c5fd", edgecolor="white", linewidth=0.6)
    ax.set_xlabel(t["kdf"])
    ax.set_ylabel(t["hist"])
    ax.set_title("a", loc="left")
    ax.grid(True, color="#eef0f3", lw=0.7)

    ax = axes[1]
    ax.hist(METRICS["samples"]["rtt_1k_ms"], bins=14, color="#bfdbfe", edgecolor="white", linewidth=0.5, label="1 KiB")
    ax.hist(METRICS["samples"]["rtt_64k_ms"], bins=14, color="#fcd34d", alpha=0.8, edgecolor="white", linewidth=0.5, label="64 KiB")
    ax.set_xlabel(t["rtt"])
    ax.set_ylabel(t["hist"])
    ax.set_title("b", loc="left")
    ax.legend(frameon=False, fontsize=6.4)
    ax.grid(True, color="#eef0f3", lw=0.7)

    ax = axes[2]
    rows = METRICS["indexScale"]
    ax.plot([r["sessions"] for r in rows], [r["perSessionBytes"] for r in rows], marker="o", color=GREEN, lw=1.2, ms=3)
    ax.set_xlabel(t["sessions"])
    ax.set_ylabel("bytes / session")
    ax.set_title("c", loc="left")
    ax.grid(True, color="#eef0f3", lw=0.7)
    fig.tight_layout(pad=0.5, w_pad=1.0)
    save(fig, f"figED1-raw-{lang}.png")


def fig_ed_lifecycle(lang):
    t = T[lang]
    setup(lang)
    fig, ax = plt.subplots(figsize=(7.1, 1.55))
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 3.0)
    ax.axis("off")

    drain = METRICS.get("mailboxDrain", {"queued": 40, "drainMs": 4.0})
    detect = METRICS.get("detectDisconnectMs", 8.0)
    y = 1.35
    h = 0.34

    # Three phases on one bar: offline queue, reconnect instant, steady state.
    ax.add_patch(Rectangle((0.7, y), 4.9, h, facecolor="#fef3c7", edgecolor="#fcd34d", lw=0.8))
    ax.add_patch(Rectangle((5.6, y), 0.5, h, facecolor="#dcfce7", edgecolor="#86efac", lw=0.8))
    ax.add_patch(Rectangle((6.1, y), 3.2, h, facecolor="#eef2ff", edgecolor="#c7d2fe", lw=0.8))

    ax.text(3.15, y + h / 2, ("%d envelopes queued" % drain["queued"]) if lang == "en" else ("积压 %d 个信封" % drain["queued"]),
            ha="center", va="center", fontsize=6.6, color=AMBER)
    ax.text(5.85, y + h / 2, "↺", ha="center", va="center", fontsize=7, color=GREEN)
    ax.text(7.7, y + h / 2, ("delivered in %.1f ms" % drain["drainMs"]) if lang == "en" else ("%.1f ms 内投递完成" % drain["drainMs"]),
            ha="center", va="center", fontsize=6.6, color=GREEN)

    # Phase labels above the bar.
    ax.text(0.7, y + h + 0.12, ("offline" if lang == "en" else "离线"), fontsize=6.4, color=MUTED)
    ax.text(5.35, y + h + 0.12, ("reconnect" if lang == "en" else "重连"), fontsize=6.4, color=GREEN)
    ax.text(6.4, y + h + 0.12, ("steady state" if lang == "en" else "稳态"), fontsize=6.4, color=MUTED)

    ax.plot([0.7, 9.3], [y - 0.28, y - 0.28], color=LINE, lw=0.8)
    ax.plot([5.6, 5.6], [y - 0.38, y - 0.18], color=MUTED, lw=0.9)
    ax.text(5.6, y - 0.55, "t$_{on}$", ha="center", fontsize=6.4, color=MUTED)
    ax.text(0.7, y - 0.55, "t$_{off}$", ha="center", fontsize=6.4, color=MUTED)
    ax.text(0.7, 0.35, ("disconnect detected in %.1f ms (FIN observed)" % detect) if lang == "en"
            else ("断连检测 %.1f ms（观察到 FIN）" % detect), fontsize=6.4, color=MUTED)
    save(fig, f"figED2-lifecycle-{lang}.png")


# ------------------------------------------------------------------ figure 6
def fig_topology(lang):
    t = T[lang]
    setup(lang)
    fig, axes = plt.subplots(1, 3, figsize=(7.1, 1.95))
    for ax, title in zip(axes, (t["lan"], t["vps"], t["tunnel"])):
        ax.set_xlim(0, 10)
        ax.set_ylim(0, 10)
        ax.axis("off")
        ax.text(5, 9.4, title, ha="center", fontsize=7.6, fontweight="semibold", color=INK)

    def node(ax, x, y, w, h, label, fill="white", edge=LINE):
        ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.02,rounding_size=0.12",
                                    facecolor=fill, edgecolor=edge, linewidth=0.9))
        ax.text(x + w / 2, y + h / 2, label, ha="center", va="center", fontsize=6.2, color=INK)

    # Same LAN: two devices and the relay on one segment.
    ax = axes[0]
    node(ax, 0.4, 5.4, 3.4, 1.5, t["devA"], "#eef2ff", "#c7d2fe")
    node(ax, 6.2, 5.4, 3.4, 1.5, t["devB"], "#eef2ff", "#c7d2fe")
    node(ax, 3.3, 1.6, 3.4, 1.5, t["relay"], "#f0fdf4", "#86efac")
    arrow(ax, (1.4, 5.3), (3.5, 3.3), color=MUTED, lw=0.8)
    arrow(ax, (8.6, 5.3), (6.5, 3.3), color=MUTED, lw=0.8)

    # VPS: relay behind a reverse proxy that terminates TLS.
    ax = axes[1]
    node(ax, 0.3, 6.2, 3.2, 1.4, t["devA"], "#eef2ff", "#c7d2fe")
    node(ax, 0.3, 3.4, 3.2, 1.4, t["devB"], "#eef2ff", "#c7d2fe")
    node(ax, 4.4, 4.6, 2.4, 1.5, t["proxy"], "white", AMBER)
    node(ax, 7.4, 4.6, 2.2, 1.5, t["relay"], "#f0fdf4", "#86efac")
    arrow(ax, (3.55, 6.6), (4.4, 5.4), color=MUTED, lw=0.8)
    arrow(ax, (3.55, 3.9), (4.4, 4.9), color=MUTED, lw=0.8)
    arrow(ax, (6.85, 5.3), (7.35, 5.3), color=MUTED, lw=0.8)

    # Tunnel: no inbound port anywhere.
    ax = axes[2]
    node(ax, 0.3, 6.2, 2.9, 1.4, t["devB"], "#eef2ff", "#c7d2fe")
    node(ax, 6.9, 6.2, 2.9, 1.4, t["cloud"], "white", MUTED)
    node(ax, 3.5, 2.4, 3.0, 1.5, t["devA"] + "\n+ relay", "#fef3c7", "#fcd34d")
    arrow(ax, (3.25, 6.9), (6.85, 6.9), color=MUTED, lw=0.8)
    arrow(ax, (5.0, 3.95), (6.6, 6.15), color=MUTED, lw=0.8, curve=-0.15)
    ax.text(3.55, 1.55, t["outbound"], ha="center", fontsize=5.8, color=MUTED)

    fig.tight_layout(pad=0.4, w_pad=0.8)
    save(fig, f"fig6-topology-{lang}.png")


def main():
    for lang in ("en", "zh"):
        fig_architecture(lang)
        fig_envelope(lang)
        fig_sequence(lang)
        fig_performance(lang)
        fig_threat(lang)
        fig_ed_raw(lang)
        fig_ed_lifecycle(lang)
        fig_topology(lang)
    print("figures written to", ASSETS)


if __name__ == "__main__":
    main()
