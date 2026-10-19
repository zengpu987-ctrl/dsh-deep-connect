#!/usr/bin/env python3
"""Deep Connect — assemble the two papers (English, Chinese) from content + data.

Citation tokens in the body ("[[v3]]", "[[localfirst,gdpr]]") are numbered by
first appearance, Nature style, and the reference list is emitted in that order.
Numeric placeholders ("{{kdf_mean}}") come from data/metrics.json so that every
number in the prose is the one the measurement script produced.
"""
import html
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "src"
BUILD = ROOT / "build"
BUILD.mkdir(exist_ok=True)
METRICS = json.loads((ROOT / "data" / "metrics.json").read_text())
REFS = {entry["key"]: entry for entry in json.loads((ROOT / "data" / "references.json").read_text())}
TEMPLATE = (ROOT / "template.html").read_text()


def summary(key):
    return METRICS["summary"][key]


def value(name):
    """Every placeholder the prose may use."""
    s = {k: v for k, v in METRICS.items() if not isinstance(v, dict) or "mean" not in v}
    table = {
        "kdf_mean": f"{summary('kdf_ms')['mean']:.2f}",
        "kdf_sd": f"{summary('kdf_ms')['sd']:.2f}",
        "kdf_p95": f"{summary('kdf_ms')['p95']:.2f}",
        "channel_us": f"{summary('channel_hash_us')['mean']:.2f}",
        "connect_mean": f"{summary('ws_connect_ms')['mean']:.2f}",
        "connect_p50": f"{summary('ws_connect_ms')['p50']:.2f}",
        "connect_p95": f"{summary('ws_connect_ms')['p95']:.2f}",
        "rtt1k_mean": f"{summary('rtt_1k_ms')['mean']:.2f}",
        "rtt1k_p50": f"{summary('rtt_1k_ms')['p50']:.2f}",
        "rtt1k_p95": f"{summary('rtt_1k_ms')['p95']:.2f}",
        "rtt64k_mean": f"{summary('rtt_64k_ms')['mean']:.2f}",
        "rtt64k_p50": f"{summary('rtt_64k_ms')['p50']:.2f}",
        "rtt64k_p95": f"{summary('rtt_64k_ms')['p95']:.2f}",
        "index_broadcast": f"{summary('index_broadcast_ms')['mean']:.2f}",
        "drain_ms": f"{METRICS['mailboxDrain']['drainMs']:.1f}",
        "drain_n": str(METRICS["mailboxDrain"]["queued"]),
        "detect_ms": f"{METRICS['detectDisconnectMs']:.1f}",
        "seal_1k": f"{METRICS['sealThroughput'][0]['mbPerSec']:.0f}",
        "seal_64k": f"{METRICS['sealThroughput'][2]['mbPerSec']:.0f}",
        "code_lines": f"{METRICS['code']['codeLines']:,}",
        "plugin_lines": f"{METRICS['code']['pluginLines']:,}",
        "relay_lines": f"{METRICS['code']['relayLines']:,}",
        "test_lines": f"{METRICS['code']['testLines']:,}",
        "file_count": str(METRICS["code"]["files"]),
        "fingerprint": METRICS["fingerprint"],
        "neg_trials": str(METRICS["negative"]["trials"]),
        "overhead_small": f"{METRICS['envelopeOverhead'][0]['ratio']:.2f}",
        "overhead_large": f"{METRICS['envelopeOverhead'][-1]['ratio']:.2f}",
        "index_wire_200": f"{METRICS['indexScale'][-1]['wireBytes'] / 1024:.0f}",
        "index_build_200": f"{METRICS['indexScale'][-1]['buildMs']:.2f}",
        "transcript_2000": f"{METRICS['transcripts'][-1]['wireBytes'] / 1024:.0f}",
        "transcript_export_2000": f"{METRICS['transcripts'][-1]['exportMs']:.2f}",
        "gen_date": METRICS["generatedAt"][:10],
    }
    table.update({k: v for k, v in s.items() if isinstance(v, (str, int, float))})
    return table


VALUES = value(None)


TABLE_RE = re.compile(r"<table>(.*?)</table>", re.S)
HEAD_RE = re.compile(r"<tr>(.*?)</tr>", re.S)
WIDTH_RE = re.compile(r'style="width:\s*(\d+(?:\.\d+)?)%"')


def fix_tables(html):
    """Browsers ignore <th>width> in auto layout; emit an explicit colgroup."""
    def repl(match):
        inner = match.group(1)
        head = HEAD_RE.search(inner)
        if head is None:
            return match.group(0)
        widths = WIDTH_RE.findall(head.group(1))
        if not widths:
            return match.group(0)
        cols = "".join(f'<col style="width:{w}%">' for w in widths)
        return f"<table><colgroup>{cols}</colgroup>{inner}</table>"

    return TABLE_RE.sub(repl, html)


def number_citations(body):
    order = []

    def repl(match):
        keys = [k.strip() for k in match.group(1).split(",") if k.strip()]
        numbers = []
        for key in keys:
            if key not in REFS:
                raise SystemExit(f"unknown citation key: {key}")
            if key not in order:
                order.append(key)
            numbers.append(order.index(key) + 1)
        numbers = sorted(set(numbers))
        # Collapse runs of three or more into a range.
        rendered = []
        i = 0
        while i < len(numbers):
            j = i
            while j + 1 < len(numbers) and numbers[j + 1] == numbers[j] + 1:
                j += 1
            if j - i >= 2:
                rendered.append(f"{numbers[i]}–{numbers[j]}")
            else:
                rendered.extend(str(n) for n in numbers[i:j + 1])
            i = j + 1
        return "<sup>" + ",".join(rendered) + "</sup>"

    numbered = re.sub(r"\[\[([^\]]+)\]\]", repl, body)
    return numbered, order


def reference_html(order):
    items = []
    for key in order:
        ref = REFS[key]
        authors = html.escape(ref["authors"])
        title = html.escape(ref["title"])
        venue = html.escape(ref["venue"])
        year = ref["year"]
        url = ref["url"]
        doi = ref.get("doi")
        tail = f' <span class="doi">doi:{html.escape(doi)}</span>' if doi else ""
        items.append(
            f'<li>{authors} {title}. <i>{venue}</i> ({year}). '
            f'<a href="{html.escape(url)}">{html.escape(url)}</a>{tail}</li>'
        )
    return "\n".join("    " + item for item in items)


def _subst(text):
    for key, replacement in VALUES.items():
        text = text.replace("{{" + key + "}}", str(replacement))
    return text


def fill(template, mapping):
    out = template
    for key, text in mapping.items():
        out = out.replace("{{" + key + "}}", text)
    # Any placeholder left over is a content bug, not a rendering choice.
    leftover = sorted(set(re.findall(r"\{\{([A-Z_0-9]+)\}\}", out)))
    if leftover:
        raise SystemExit(f"unfilled placeholders: {leftover}")
    return out


def build(lang, meta, body):
    body = fix_tables(body)
    body, order = number_citations(body)
    body = body.replace("{{", "{{")  # keep literal braces untouched
    for key, text in VALUES.items():
        body = body.replace("{{" + key + "}}", str(text))
    leftover = sorted(set(re.findall(r"\{\{([A-Za-z_0-9]+)\}\}", body)))
    if leftover:
        raise SystemExit(f"unfilled placeholders in body: {leftover}")
    meta = {key: (value if not isinstance(value, str) else _subst(value)) for key, value in meta.items()}
    page = fill(TEMPLATE, {
        "LANG": lang,
        "BODYCLASS": "zh" if lang == "zh" else "",
        "TITLE": meta["title"],
        "SUBTITLE": meta["subtitle"],
        "AUTHORS": meta["authors"],
        "AFFIL": meta["affil"],
        "META": meta["meta"],
        "RUNNING": meta["running"],
        "ABSTRACT_LABEL": meta["abstract_label"],
        "ABSTRACT": meta["abstract"],
        "BODY": body,
        "REFS_TITLE": meta["refs_title"],
        "REFS": reference_html(order),
        "EXTENDED": meta.get("extended", ""),
        "FOOTER": meta["footer"],
    })
    out = BUILD / f"paper-{lang}.html"
    out.write_text(page, encoding="utf-8")
    print(f"{out}  ({len(order)} references cited)")


def main():
    for lang in ("en", "zh"):
        body_path = SRC / f"body_{lang}.html"
        meta_path = SRC / f"meta_{lang}.json"
        if not body_path.exists() or not meta_path.exists():
            print(f"skip {lang}: missing {body_path.name} or {meta_path.name}")
            continue
        build(lang, json.loads(meta_path.read_text(encoding="utf-8")), body_path.read_text(encoding="utf-8"))


if __name__ == "__main__":
    main()
