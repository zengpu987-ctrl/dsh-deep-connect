"""Deep Connect — 47 references.

Every entry is a real, citable source with a stable identifier (arXiv, RFC,
DOI, NIST, or the project's own canonical documentation). Product pages are
marked `documentation` or `software`; they describe the public artefact at the
time of writing, not a controlled benchmark.
"""
import json
from pathlib import Path

DATA = Path(__file__).resolve().parent / "data"

R = []


def add(key, authors, title, venue, year, url, kind="paper", doi=None):
    R.append({
        "key": key, "authors": authors, "title": title, "venue": venue,
        "year": year, "url": url, "type": kind, "doi": doi,
    })


# --- agentic workstations and the models behind them (1-12) -----------------
add("v3", "DeepSeek-AI", "DeepSeek-V3 technical report", "arXiv", 2024, "https://arxiv.org/abs/2412.19437")
add("r1", "DeepSeek-AI", "DeepSeek-R1: incentivizing reasoning capability in LLMs via reinforcement learning", "arXiv", 2025, "https://arxiv.org/abs/2501.12948")
add("gpt4", "OpenAI", "GPT-4 technical report", "arXiv", 2023, "https://arxiv.org/abs/2303.08774")
add("o1", "OpenAI", "OpenAI o1 system card", "arXiv", 2024, "https://arxiv.org/abs/2412.16720")
add("react", "Yao, S. et al.", "ReAct: synergizing reasoning and acting in language models", "International Conference on Learning Representations", 2023, "https://arxiv.org/abs/2210.03629")
add("toolformer", "Schick, T. et al.", "Toolformer: language models can teach themselves to use tools", "Advances in Neural Information Processing Systems 36", 2023, "https://arxiv.org/abs/2302.04761")
add("sweagent", "Yang, J. et al.", "SWE-agent: agent-computer interfaces enable automated software engineering", "Advances in Neural Information Processing Systems 37", 2024, "https://arxiv.org/abs/2405.15793")
add("autogen", "Wu, Q. et al.", "AutoGen: enabling next-gen LLM applications via multi-agent conversation", "arXiv", 2023, "https://arxiv.org/abs/2308.08155")
add("codex", "Chen, M. et al.", "Evaluating large language models trained on code", "arXiv", 2021, "https://arxiv.org/abs/2107.03374")
add("mcp", "Anthropic", "Model Context Protocol specification", "Model Context Protocol", 2024, "https://modelcontextprotocol.io", kind="documentation")
add("cot", "Wei, J. et al.", "Chain-of-thought prompting elicits reasoning in large language models", "Advances in Neural Information Processing Systems 35", 2022, "https://arxiv.org/abs/2201.11903")
add("constitutional", "Bai, Y. et al.", "Constitutional AI: harmlessness from AI feedback", "arXiv", 2022, "https://arxiv.org/abs/2212.08073")

# --- the harness itself and its storage model (13-18) -----------------------
add("dsh", "DeepSeek", "DeepSeek Harness: an event-sourced agent workstation", "GitHub", 2026, "https://github.com/deepseek-ai/deepseek-harness", kind="software")
add("cordis", "Cordis contributors", "Cordis: a cordis-style plugin framework", "GitHub", 2026, "https://github.com/cordiverse/cordis", kind="software")
add("eventsourcing", "Fowler, M.", "Event sourcing", "martinfowler.com", 2005, "https://martinfowler.com/eaaDev/EventSourcing.html", kind="documentation")
add("jsonl", "JSON Lines contributors", "JSON Lines: newline-delimited JSON", "jsonlines.org", 2024, "https://jsonlines.org", kind="documentation")
add("zstd", "Collet, Y. & Kucherawy, M. (eds)", "Zstandard compression and the application/zstd media type", "RFC 8878, Internet Engineering Task Force", 2021, "https://www.rfc-editor.org/rfc/rfc8878", kind="standard")
add("json", "Bray, T. (ed.)", "The JavaScript Object Notation (JSON) data interchange format", "RFC 8259, Internet Engineering Task Force", 2017, "https://www.rfc-editor.org/rfc/rfc8259", kind="standard")

# --- synchronisation, replication and file sync (19-26) ---------------------
add("localfirst", "Kleppmann, M., Wiggins, A., van Hardenberg, P. & McGranaghan, M.", "Local-first software: you own your data, in spite of the cloud", "Proceedings of the ACM SIGPLAN Onward! Symposium", 2019, "https://doi.org/10.1145/3359591.3359737", doi="10.1145/3359591.3359737")
add("crdt", "Shapiro, M., Preguiça, N., Baquero, C. & Zawirski, M.", "Conflict-free replicated data types", "Stabilization, Safety, and Security of Distributed Systems (SSS)", 2011, "https://doi.org/10.1007/978-3-642-24550-3_29", doi="10.1007/978-3-642-24550-3_29")
add("dynamo", "DeCandia, G. et al.", "Dynamo: Amazon's highly available key-value store", "Proceedings of the 21st ACM Symposium on Operating Systems Principles (SOSP)", 2007, "https://doi.org/10.1145/1294261.1294281", doi="10.1145/1294261.1294281")
add("bayou", "Terry, D. B., Theimer, M. M., Petersen, K., Demers, A. J. & Spreitzer, M. J.", "Managing update conflicts in Bayou, a weakly connected replicated storage system", "Proceedings of the 15th ACM Symposium on Operating Systems Principles (SOSP)", 1995, "https://doi.org/10.1145/224056.224070", doi="10.1145/224056.224070")
add("syncthing", "Syncthing contributors", "Syncthing: continuous file synchronization", "GitHub", 2024, "https://github.com/syncthing/syncthing", kind="software")
add("matrix", "Matrix.org Foundation", "Matrix specification", "Matrix.org", 2024, "https://spec.matrix.org/latest/", kind="standard")
add("rsync", "Tridgell, A. & Mackerras, P.", "The rsync algorithm", "Technical Report TR-CS-96-05, Australian National University", 1996, "https://rsync.samba.org/tech_report/", kind="paper")
add("git", "Chacon, S. & Straub, B.", "Pro Git", "Apress", 2014, "https://git-scm.com/book/en/v2", kind="book")

# --- authenticated encryption and key derivation (27-31) --------------------
add("aesgcm", "Dworkin, M.", "Recommendation for block cipher modes of operation: Galois/Counter Mode (GCM) and GMAC", "NIST Special Publication 800-38D", 2007, "https://doi.org/10.6028/NIST.SP.800-38D", kind="standard", doi="10.6028/NIST.SP.800-38D")
add("gcm", "McGrew, D. A. & Viega, J.", "The Galois/Counter Mode of operation (GCM)", "Progress in Cryptology — INDOCRYPT 2004", 2004, "https://doi.org/10.1007/978-3-540-30539-2_21", doi="10.1007/978-3-540-30539-2_21")
add("hkdf", "Krawczyk, H. & Eronen, P.", "HMAC-based extract-and-expand key derivation function (HKDF)", "RFC 5869, Internet Engineering Task Force", 2010, "https://www.rfc-editor.org/rfc/rfc5869", kind="standard")
add("pbkdf2", "Moriarty, K., Kaliski, B. & Rusch, A.", "PKCS #5: password-based cryptography specification version 2.1", "RFC 8018, Internet Engineering Task Force", 2017, "https://www.rfc-editor.org/rfc/rfc8018", kind="standard")
add("aead", "McGrew, D.", "An interface and algorithms for authenticated encryption", "RFC 5116, Internet Engineering Task Force", 2008, "https://www.rfc-editor.org/rfc/rfc5116", kind="standard")

# --- messaging protocols and pairing (32-36) -------------------------------
add("doubleratchet", "Perrin, T. & Marlinspike, M.", "The double ratchet algorithm", "Signal Foundation", 2016, "https://signal.org/docs/specifications/doubleratchet/", kind="documentation")
add("noise", "Perrin, T.", "The Noise Protocol Framework", "noiseprotocol.org", 2018, "https://noiseprotocol.org/noise.html", kind="documentation")
add("spake2", "Taubert, T. & Wood, C. A.", "SPAKE2, a PAKE", "RFC 9382, Internet Engineering Task Force", 2023, "https://www.rfc-editor.org/rfc/rfc9382", kind="standard")
add("opaque", "Jarecki, S., Krawczyk, H. & Xu, J.", "OPAQUE: an asymmetric PAKE protocol secure against pre-computation attacks", "Advances in Cryptology — EUROCRYPT 2018", 2018, "https://doi.org/10.1007/978-3-319-78372-7_15", doi="10.1007/978-3-319-78372-7_15")
add("tls13", "Rescorla, E.", "The Transport Layer Security (TLS) protocol version 1.3", "RFC 8446, Internet Engineering Task Force", 2018, "https://www.rfc-editor.org/rfc/rfc8446", kind="standard")

# --- transport, browser boundary and platform (37-44) ----------------------
add("websocket", "Fette, I. & Melnikov, A.", "The WebSocket protocol", "RFC 6455, Internet Engineering Task Force", 2011, "https://www.rfc-editor.org/rfc/rfc6455", kind="standard")
add("sameorigin", "Barth, A.", "The Web Origin concept", "RFC 6454, Internet Engineering Task Force", 2011, "https://www.rfc-editor.org/rfc/rfc6454", kind="standard")
add("asvs", "OWASP", "Application Security Verification Standard 4.0.3", "OWASP Foundation", 2021, "https://owasp.org/www-project-application-security-verification-standard/", kind="standard")
add("electron", "OpenJS Foundation", "Electron documentation", "Electron", 2024, "https://www.electronjs.org/docs/latest/", kind="documentation")
add("node", "OpenJS Foundation", "Node.js documentation", "Node.js", 2024, "https://nodejs.org/docs/latest-v22.x/api/", kind="documentation")
add("chromium", "Chromium authors", "Chrome for Testing", "Chromium project", 2024, "https://developer.chrome.com/blog/chrome-for-testing", kind="documentation")
add("tailscale", "Tailscale", "Tailscale: a mesh VPN built on WireGuard", "Tailscale", 2024, "https://tailscale.com/kb/", kind="documentation")
add("cloudflared", "Cloudflare", "Cloudflare Tunnel", "Cloudflare", 2024, "https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/", kind="documentation")

# --- governance, zero trust and messaging usability (45-47) ----------------
add("gdpr", "European Parliament and Council", "Regulation (EU) 2016/679 on the protection of natural persons with regard to the processing of personal data", "Official Journal of the European Union", 2016, "https://eur-lex.europa.eu/eli/reg/2016/679/oj", kind="standard")
add("zerotrust", "Rose, S., Borchert, O., Mitchell, S. & Connelly, S.", "Zero trust architecture", "NIST Special Publication 800-207", 2020, "https://doi.org/10.6028/NIST.SP.800-207", kind="standard", doi="10.6028/NIST.SP.800-207")
add("sok", "Unger, N. et al.", "SoK: secure messaging", "Proceedings of the 2015 IEEE Symposium on Security and Privacy", 2015, "https://doi.org/10.1109/SP.2015.36", doi="10.1109/SP.2015.36")


def main():
    keys = [entry["key"] for entry in R]
    assert len(R) == 47, f"expected 47 references, got {len(R)}"
    assert len(set(keys)) == 47, "duplicate reference keys"
    DATA.mkdir(parents=True, exist_ok=True)
    (DATA / "references.json").write_text(json.dumps(R, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {len(R)} references to {DATA / 'references.json'}")


if __name__ == "__main__":
    main()
