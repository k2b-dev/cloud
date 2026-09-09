import { Hono } from "hono";
import { type AuthContext } from "@k2b/cloud/server";
import { resolveSpeedtestBase } from "./_url";

const buildJsScript = (
  base: string,
): string => `// StuVe Cloud speedtest — runs on Bun or Node 19+ (or Node 18 with --experimental-global-webcrypto).
// Pass --json for a single-line JSON result instead of human-readable output.

const BASE = ${JSON.stringify(base)};
const args = process.argv.slice(2);
const wantsJson = args.includes("--json");

const PING_WARMUP = 1;
const PING_SAMPLES = 10;
const DOWNLOAD_PARALLEL = 4;
const DOWNLOAD_PER_STREAM = 25 * 1024 * 1024;
const UPLOAD_PARALLEL = 4;
const UPLOAD_PER_STREAM = 12 * 1024 * 1024;
const RANDOM_CHUNK = 64 * 1024;

const fillRandom = (buf) => {
  for (let off = 0; off < buf.byteLength; off += RANDOM_CHUNK) {
    crypto.getRandomValues(buf.subarray(off, Math.min(off + RANDOM_CHUNK, buf.byteLength)));
  }
  return buf;
};

const stddev = (xs) => {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length);
};

const isTty = !!process.stderr.isTTY;
const showSpinner = isTty && !wantsJson;
const FRAMES = ["|", "/", "-", "\\\\"];
let frame = 0;
let status = "";
let ticker = null;

const startSpinner = () => {
  if (!showSpinner || ticker) return;
  ticker = setInterval(() => {
    process.stderr.write(\`\\r[\${FRAMES[frame]}] \${status}\`.padEnd(60));
    frame = (frame + 1) % FRAMES.length;
  }, 80);
};
const stopSpinner = () => {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
    // Clear the line so the final summary starts on a clean row.
    process.stderr.write("\\r" + " ".repeat(60) + "\\r");
  }
};
const setStatus = (s) => { status = s; };

async function measurePing() {
  for (let i = 0; i < PING_WARMUP; i++) {
    const r = await fetch(BASE + "/ping", { cache: "no-store" });
    if (r.body) await r.body.cancel().catch(() => {});
  }
  const samples = [];
  for (let i = 0; i < PING_SAMPLES; i++) {
    setStatus(\`Ping \${i + 1}/\${PING_SAMPLES}\`);
    const t0 = performance.now();
    const r = await fetch(BASE + "/ping", { cache: "no-store" });
    if (r.body) await r.body.cancel().catch(() => {});
    samples.push(performance.now() - t0);
  }
  return { ping: Math.min(...samples), jitter: stddev(samples) };
}

async function measureDownload() {
  setStatus("Download");
  let total = 0;
  const t0 = performance.now();
  const streams = Array.from({ length: DOWNLOAD_PARALLEL }, async () => {
    const res = await fetch(\`\${BASE}/download?size=\${DOWNLOAD_PER_STREAM}\`, { cache: "no-store" });
    if (!res.body) throw new Error("download: no response body");
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
    }
  });
  await Promise.all(streams);
  return (total * 8) / (performance.now() - t0) / 1000;
}

async function measureUpload() {
  setStatus("Upload");
  const payload = fillRandom(new Uint8Array(UPLOAD_PER_STREAM));
  const t0 = performance.now();
  const streams = Array.from({ length: UPLOAD_PARALLEL }, () =>
    fetch(\`\${BASE}/upload\`, {
      method: "POST",
      body: payload,
      headers: { "content-type": "application/octet-stream" },
      cache: "no-store",
    }).then((r) => {
      if (!r.ok) throw new Error(\`upload failed: HTTP \${r.status}\`);
    }),
  );
  await Promise.all(streams);
  const elapsed = (performance.now() - t0) / 1000;
  return (UPLOAD_PER_STREAM * UPLOAD_PARALLEL * 8) / elapsed / 1e6;
}

startSpinner();
let pingRes, download, upload;
try {
  pingRes = await measurePing();
  download = await measureDownload();
  upload = await measureUpload();
} finally {
  stopSpinner();
}

const round = (n) => Math.round(n * 100) / 100;
if (wantsJson) {
  process.stdout.write(JSON.stringify({
    server: BASE,
    timestamp: new Date().toISOString(),
    ping_ms: round(pingRes.ping),
    jitter_ms: round(pingRes.jitter),
    download_mbps: round(download),
    upload_mbps: round(upload),
  }) + "\\n");
} else {
  const row = (label, value) => \`  \${label.padEnd(11)}\${value}\\n\`;
  process.stdout.write(
    row("Server", BASE) +
    row("Ping", \`\${pingRes.ping.toFixed(1)} ms\`) +
    row("Jitter", \`\${pingRes.jitter.toFixed(1)} ms\`) +
    row("Download", \`\${Math.round(download)} Mbps\`) +
    row("Upload", \`\${Math.round(upload)} Mbps\`),
  );
}
`;

const buildPyScript = (base: string): string => `# StuVe Cloud speedtest — runs on Python 3.7+ with stdlib only.
# Pass --json for a single-line JSON result instead of human-readable output.

import sys, os, time, math, json, threading, http.client
from urllib.parse import urlparse
from concurrent.futures import ThreadPoolExecutor

BASE = ${JSON.stringify(base)}
WANTS_JSON = "--json" in sys.argv

PING_WARMUP = 1
PING_SAMPLES = 10
DOWNLOAD_PARALLEL = 4
DOWNLOAD_PER_STREAM = 25 * 1024 * 1024
UPLOAD_PARALLEL = 4
UPLOAD_PER_STREAM = 12 * 1024 * 1024

IS_TTY = sys.stderr.isatty()
_PARSED = urlparse(BASE)
_HOST = _PARSED.hostname
_PORT = _PARSED.port or (443 if _PARSED.scheme == "https" else 80)
_PATH = _PARSED.path or ""

def make_conn():
    """Return a fresh HTTP(S) connection to the speedtest host."""
    if _PARSED.scheme == "https":
        return http.client.HTTPSConnection(_HOST, _PORT, timeout=30)
    return http.client.HTTPConnection(_HOST, _PORT, timeout=30)

SHOW_SPINNER = IS_TTY and not WANTS_JSON
_FRAMES = "|/-\\\\"
_status = ""
_stop_event = threading.Event()
_ticker_thread = None

def _spin_loop():
    idx = 0
    while not _stop_event.wait(0.08):
        sys.stderr.write(f"\\r[{_FRAMES[idx]}] {_status:<60}")
        sys.stderr.flush()
        idx = (idx + 1) % len(_FRAMES)

def start_spinner():
    global _ticker_thread
    if not SHOW_SPINNER or _ticker_thread is not None:
        return
    _ticker_thread = threading.Thread(target=_spin_loop, daemon=True)
    _ticker_thread.start()

def stop_spinner():
    global _ticker_thread
    if _ticker_thread is None:
        return
    _stop_event.set()
    _ticker_thread.join()
    _ticker_thread = None
    sys.stderr.write("\\r" + " " * 64 + "\\r")
    sys.stderr.flush()

def set_status(msg: str) -> None:
    global _status
    _status = msg

def stddev(xs):
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / len(xs))

def measure_ping():
    """Share one keep-alive connection across all samples — otherwise every
    request would pay for a fresh TCP handshake and inflate ping by ~1 ms."""
    conn = make_conn()
    try:
        for _ in range(PING_WARMUP):
            conn.request("GET", _PATH + "/ping", headers={"cache-control": "no-store"})
            conn.getresponse().read()
        samples = []
        for i in range(PING_SAMPLES):
            set_status(f"Ping {i + 1}/{PING_SAMPLES}")
            t0 = time.perf_counter()
            conn.request("GET", _PATH + "/ping", headers={"cache-control": "no-store"})
            conn.getresponse().read()
            samples.append((time.perf_counter() - t0) * 1000)
    finally:
        conn.close()
    return min(samples), stddev(samples)

def _download_stream(size):
    conn = make_conn()
    try:
        conn.request("GET", f"{_PATH}/download?size={size}", headers={"cache-control": "no-store"})
        resp = conn.getresponse()
        n = 0
        while True:
            chunk = resp.read(64 * 1024)
            if not chunk:
                break
            n += len(chunk)
        return n
    finally:
        conn.close()

def _upload_stream(data):
    conn = make_conn()
    try:
        conn.request("POST", _PATH + "/upload", body=data,
                     headers={"content-type": "application/octet-stream"})
        conn.getresponse().read()
    finally:
        conn.close()

def measure_download():
    set_status("Download")
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=DOWNLOAD_PARALLEL) as pool:
        futures = [pool.submit(_download_stream, DOWNLOAD_PER_STREAM) for _ in range(DOWNLOAD_PARALLEL)]
        total = sum(f.result() for f in futures)
    elapsed = time.perf_counter() - t0
    return (total * 8) / elapsed / 1e6

def measure_upload():
    set_status("Upload")
    payload = os.urandom(UPLOAD_PER_STREAM)
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=UPLOAD_PARALLEL) as pool:
        futures = [pool.submit(_upload_stream, payload) for _ in range(UPLOAD_PARALLEL)]
        for f in futures:
            f.result()
    elapsed = time.perf_counter() - t0
    return (UPLOAD_PER_STREAM * UPLOAD_PARALLEL * 8) / elapsed / 1e6

start_spinner()
try:
    ping_ms, jitter_ms = measure_ping()
    download = measure_download()
    upload = measure_upload()
finally:
    stop_spinner()

if WANTS_JSON:
    out = {
        "server": BASE,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ping_ms": round(ping_ms, 2),
        "jitter_ms": round(jitter_ms, 2),
        "download_mbps": round(download, 2),
        "upload_mbps": round(upload, 2),
    }
    print(json.dumps(out))
else:
    print(f"  {'Server':<11}{BASE}")
    print(f"  {'Ping':<11}{ping_ms:.1f} ms")
    print(f"  {'Jitter':<11}{jitter_ms:.1f} ms")
    print(f"  {'Download':<11}{round(download)} Mbps")
    print(f"  {'Upload':<11}{round(upload)} Mbps")
`;

const scriptHeaders = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
};

export default new Hono<AuthContext>()
  .get("/cli", (c) => {
    const base = resolveSpeedtestBase(c);
    return new Response(buildJsScript(base), {
      headers: { ...scriptHeaders, "Content-Type": "application/javascript; charset=utf-8" },
    });
  })
  .get("/cli.py", (c) => {
    const base = resolveSpeedtestBase(c);
    return new Response(buildPyScript(base), {
      headers: { ...scriptHeaders, "Content-Type": "text/x-python; charset=utf-8" },
    });
  });
