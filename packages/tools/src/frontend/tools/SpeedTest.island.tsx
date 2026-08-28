import { i18n } from "@k2b/stdlib";
import { Button, Chart, CopyButton, NoticeCard, useLocale } from "@k2b/ui";
import { batch, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { ToolCodeBlock } from "./ToolOutput";

export const speedTestMessages = i18n.define({
  baseLocale: "en",
  messages: {
    en: {
      phasePing: "Pinging server",
      phaseDownload: "Measuring download",
      phaseUpload: "Measuring upload",
      phaseDone: "Done",
      phaseError: "Error",
      unknownError: "unknown error",
      dataNotice:
        "This tool sends random test data to the cloud server to measure your connection. The data is generated in your browser and discarded server-side — nothing is stored.",
      runAgain: "Run again",
      startTest: "Start test",
      stop: "Stop",
      terminalTitle: "Run from your terminal",
      cliHintBefore: "Use the Cloud CLI or pipe the script into your runtime. Append ",
      cliHintAfter: " for structured output.",
      cliRuntimeAria: "CLI runtime",
    },
    de: {
      phasePing: "Ping wird gemessen",
      phaseDownload: "Download wird gemessen",
      phaseUpload: "Upload wird gemessen",
      phaseDone: "Fertig",
      phaseError: "Fehler",
      unknownError: "unbekannter Fehler",
      dataNotice:
        "Dieses Werkzeug sendet zufällige Testdaten an den Cloud-Server, um deine Verbindung zu messen. Die Daten werden im Browser erzeugt und serverseitig verworfen. Nichts wird gespeichert.",
      runAgain: "Erneut testen",
      startTest: "Test starten",
      stop: "Stoppen",
      terminalTitle: "Im Terminal ausführen",
      cliHintBefore: "Nutze die Cloud CLI oder übergib das Skript an deine Laufzeitumgebung. Ergänze ",
      cliHintAfter: " für strukturierte Ausgabe an.",
      cliRuntimeAria: "Laufzeitumgebung",
    },
  },
});

type SpeedTestMessages = ReturnType<typeof speedTestMessages.resolve>["t"];

type Phase = "idle" | "ping" | "download" | "upload" | "done" | "error";

type CliVariant = "cloud" | "bun" | "node" | "python";

type SpeedTestProps = {
  /** Public-facing base URL of the speedtest API, e.g. `https://cloud.example.org/tools/api/speedtest`. */
  cliBaseUrl?: string;
};

const speedtestServerFromBase = (base: string): string => {
  try {
    return new URL(base).origin;
  } catch {
    return base.replace(/\/tools\/api\/speedtest\/?$/, "").replace(/\/+$/, "");
  }
};

const buildSnippet = (variant: CliVariant, base: string): string => {
  switch (variant) {
    case "cloud":
      return `cld tools speedtest --server ${speedtestServerFromBase(base)}`;
    case "bun":
      return `curl -fsSL ${base}/cli | bun -`;
    case "node":
      return `curl -fsSL ${base}/cli | node --input-type=module`;
    case "python":
      return `curl -fsSL ${base}/cli.py | python3 -`;
  }
};

const PING_SAMPLES = 10;
const PING_WARMUP = 1;
const DOWNLOAD_PARALLEL = 4;
const DOWNLOAD_PER_STREAM = 25 * 1024 * 1024;
const UPLOAD_PARALLEL = 4;
const UPLOAD_PER_STREAM = 12 * 1024 * 1024;

const phaseLabel = (t: SpeedTestMessages): Record<Phase, string> => ({
  idle: "",
  ping: t.phasePing,
  download: t.phaseDownload,
  upload: t.phaseUpload,
  done: t.phaseDone,
  error: t.phaseError,
});

const formatRate = (mbps: number | null): string => {
  if (mbps === null) return "—";
  if (mbps < 10) return mbps.toFixed(1);
  return Math.round(mbps).toString();
};

const formatMs = (ms: number | null): string => {
  if (ms === null) return "—";
  if (ms < 10) return ms.toFixed(1);
  return Math.round(ms).toString();
};

// crypto.getRandomValues caps at 65536 bytes per call (Web Crypto spec).
const RANDOM_CHUNK = 64 * 1024;
const fillRandom = <T extends Uint8Array>(buf: T): T => {
  for (let off = 0; off < buf.byteLength; off += RANDOM_CHUNK) {
    crypto.getRandomValues(buf.subarray(off, Math.min(off + RANDOM_CHUNK, buf.byteLength)));
  }
  return buf;
};

const stddev = (samples: number[]): number => {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const variance = samples.reduce((s, x) => s + (x - mean) ** 2, 0) / samples.length;
  return Math.sqrt(variance);
};

export default function SpeedTest(props: SpeedTestProps) {
  const locale = useLocale();
  const t = () => speedTestMessages.resolve([locale()]).t;
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [download, setDownload] = createSignal<number | null>(null);
  const [upload, setUpload] = createSignal<number | null>(null);
  const [ping, setPing] = createSignal<number | null>(null);
  const [jitter, setJitter] = createSignal<number | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  // History buffers feed the per-tile sparklines.
  const [downloadHistory, setDownloadHistory] = createSignal<number[]>([]);
  const [uploadHistory, setUploadHistory] = createSignal<number[]>([]);
  const [pingHistory, setPingHistory] = createSignal<number[]>([]);

  let abortController: AbortController | null = null;
  let activeXhrs: XMLHttpRequest[] = [];

  const cleanup = () => {
    abortController?.abort();
    abortController = null;
    for (const xhr of activeXhrs) {
      try {
        xhr.abort();
      } catch {}
    }
    activeXhrs = [];
  };
  onCleanup(cleanup);

  const measurePing = async (signal: AbortSignal) => {
    // Warmup requests are discarded — first request pays for connection
    // setup, JIT warmup, settings cache fill, etc.
    for (let i = 0; i < PING_WARMUP; i++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      await apiClient.speedtest.ping.$get({}, { init: { cache: "no-store", signal } });
    }
    const samples: number[] = [];
    for (let i = 0; i < PING_SAMPLES; i++) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
      const t0 = performance.now();
      await apiClient.speedtest.ping.$get({}, { init: { cache: "no-store", signal } });
      samples.push(performance.now() - t0);
      setPingHistory([...samples]);
    }
    // Report the minimum sample as ping: it represents the best-case
    // network + server round-trip. Higher samples include transient
    // scheduling/queueing delay and would inflate the result.
    const min = Math.min(...samples);
    return { ping: min, jitter: stddev(samples) };
  };

  const measureDownload = async (signal: AbortSignal) => {
    let totalBytes = 0;
    const t0 = performance.now();
    let lastUpdate = t0;

    const streams = Array.from({ length: DOWNLOAD_PARALLEL }, async () => {
      const res = await apiClient.speedtest.download.$get(
        { query: { size: String(DOWNLOAD_PER_STREAM) } },
        { init: { cache: "no-store", signal } },
      );
      if (!res.body) throw new Error("download: no response body");
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          totalBytes += value.byteLength;
          const now = performance.now();
          if (now - lastUpdate > 100) {
            lastUpdate = now;
            const elapsed = (now - t0) / 1000;
            if (elapsed > 0) {
              const mbps = (totalBytes * 8) / elapsed / 1e6;
              setDownload(mbps);
              setDownloadHistory((prev) => [...prev, mbps]);
            }
          }
        }
      }
    });
    await Promise.all(streams);
    const elapsed = (performance.now() - t0) / 1000;
    const final = elapsed > 0 ? (totalBytes * 8) / elapsed / 1e6 : 0;
    setDownload(final);
    setDownloadHistory((prev) => [...prev, final]);
  };

  // XHR is required for upload progress events — fetch() has none.
  const uploadOne = (payload: Blob, byteLength: number, onProgress: (loaded: number) => void, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeXhrs.push(xhr);
      const finish = () => {
        activeXhrs = activeXhrs.filter((x) => x !== xhr);
      };
      xhr.open("POST", "/tools/api/speedtest/upload");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded);
      };
      xhr.onload = () => {
        finish();
        if (xhr.status >= 200 && xhr.status < 300) {
          onProgress(byteLength);
          resolve();
        } else reject(new Error(`upload failed: HTTP ${xhr.status}`));
      };
      xhr.onerror = () => {
        finish();
        reject(new Error("upload network error"));
      };
      xhr.onabort = () => {
        finish();
        reject(new DOMException("aborted", "AbortError"));
      };
      signal.addEventListener(
        "abort",
        () => {
          try {
            xhr.abort();
          } catch {}
        },
        { once: true },
      );
      xhr.send(payload);
    });

  const measureUpload = async (signal: AbortSignal) => {
    const data = fillRandom(new Uint8Array(UPLOAD_PER_STREAM));
    const payload = new Blob([data]);

    const t0 = performance.now();
    let lastUpdate = t0;
    const loaded = new Array<number>(UPLOAD_PARALLEL).fill(0);

    const streams = Array.from({ length: UPLOAD_PARALLEL }, (_, i) =>
      uploadOne(
        payload,
        UPLOAD_PER_STREAM,
        (l) => {
          loaded[i] = l;
          const now = performance.now();
          if (now - lastUpdate > 100) {
            lastUpdate = now;
            const total = loaded.reduce((a, b) => a + b, 0);
            const elapsed = (now - t0) / 1000;
            if (elapsed > 0) {
              const mbps = (total * 8) / elapsed / 1e6;
              setUpload(mbps);
              setUploadHistory((prev) => [...prev, mbps]);
            }
          }
        },
        signal,
      ),
    );
    await Promise.all(streams);
    const elapsed = (performance.now() - t0) / 1000;
    const final = elapsed > 0 ? (UPLOAD_PER_STREAM * UPLOAD_PARALLEL * 8) / elapsed / 1e6 : 0;
    setUpload(final);
    setUploadHistory((prev) => [...prev, final]);
  };

  const run = async () => {
    cleanup();
    abortController = new AbortController();
    const { signal } = abortController;
    batch(() => {
      setError(null);
      setDownload(null);
      setUpload(null);
      setPing(null);
      setJitter(null);
      setDownloadHistory([]);
      setUploadHistory([]);
      setPingHistory([]);
    });
    try {
      setPhase("ping");
      const result = await measurePing(signal);
      batch(() => {
        setPing(result.ping);
        setJitter(result.jitter);
      });
      setPhase("download");
      await measureDownload(signal);
      setPhase("upload");
      await measureUpload(signal);
      setPhase("done");
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        setPhase("idle");
        return;
      }
      setError((err as Error).message ?? t().unknownError);
      setPhase("error");
    }
  };

  const stop = () => {
    cleanup();
    setPhase("idle");
  };

  const isRunning = () => phase() === "ping" || phase() === "download" || phase() === "upload";

  const [cliVariant, setCliVariant] = createSignal<CliVariant>("cloud");
  const cliSnippet = createMemo(() => (props.cliBaseUrl ? buildSnippet(cliVariant(), props.cliBaseUrl) : ""));

  return (
    <div class="flex flex-col gap-4">
      <NoticeCard tone="warning" icon={false} bodyClass="flex items-center gap-2">
        <i class="ti ti-cloud-upload shrink-0" />
        <span>{t().dataNotice}</span>
      </NoticeCard>

      <div class="paper p-4 flex flex-col gap-4">
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric
            label="Download"
            value={formatRate(download())}
            unit="Mbps"
            icon="ti ti-download"
            active={phase() === "download"}
            series={downloadHistory()}
            seriesColor="text-blue-500 dark:text-blue-400"
          />
          <Metric
            label="Upload"
            value={formatRate(upload())}
            unit="Mbps"
            icon="ti ti-upload"
            active={phase() === "upload"}
            series={uploadHistory()}
            seriesColor="text-emerald-500 dark:text-emerald-400"
          />
          <Metric
            label="Ping"
            value={formatMs(ping())}
            unit="ms"
            icon="ti ti-activity"
            active={phase() === "ping"}
            series={pingHistory()}
            seriesColor="text-amber-500 dark:text-amber-400"
          />
          <Metric label="Jitter" value={formatMs(jitter())} unit="ms" icon="ti ti-wave-square" active={phase() === "ping"} />
        </div>

        <div class="flex items-center gap-3">
          <Show
            when={isRunning()}
            fallback={
              <Button onClick={run}>
                <i class="ti ti-player-play" />
                {phase() === "done" || phase() === "error" ? t().runAgain : t().startTest}
              </Button>
            }
          >
            <Button variant="secondary" onClick={stop}>
              <i class="ti ti-player-stop" /> {t().stop}
            </Button>
            <span class="text-sm text-dimmed flex items-center gap-1.5">
              <i class="ti ti-loader-2 animate-spin" />
              {phaseLabel(t())[phase()]}…
            </span>
          </Show>
        </div>

        <Show when={error()}>
          <NoticeCard tone="danger" icon={false}>
            {error()}
          </NoticeCard>
        </Show>
      </div>

      <Show when={props.cliBaseUrl}>
        <div class="paper p-4 flex flex-col gap-3">
          <div class="flex items-end justify-between gap-3 flex-wrap">
            <div>
              <h2 class="text-sm font-semibold">{t().terminalTitle}</h2>
              <p class="text-xs text-dimmed">
                {t().cliHintBefore}
                <code class="text-[11px]">--json</code>
                {t().cliHintAfter}
              </p>
            </div>
            <div class="flex items-center gap-0.5 text-xs" role="tablist" aria-label={t().cliRuntimeAria}>
              <For
                each={[
                  { value: "cloud" as CliVariant, label: "Cloud CLI" },
                  { value: "bun" as CliVariant, label: "Bun" },
                  { value: "node" as CliVariant, label: "Node" },
                  { value: "python" as CliVariant, label: "Python" },
                ]}
              >
                {(opt) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={cliVariant() === opt.value}
                    class="px-2 py-1 rounded-md transition-colors"
                    classList={{
                      "bg-zinc-100 dark:bg-zinc-800 text-primary": cliVariant() === opt.value,
                      "text-dimmed hover:text-secondary": cliVariant() !== opt.value,
                    }}
                    onClick={() => setCliVariant(opt.value)}
                  >
                    {opt.label}
                  </button>
                )}
              </For>
            </div>
          </div>

          <div class="relative">
            <ToolCodeBlock class="overflow-x-auto pr-12">{cliSnippet()}</ToolCodeBlock>
            <div class="absolute top-2 right-2">
              <CopyButton text={cliSnippet()} size="xs" />
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
}

function Metric(props: {
  label: string;
  value: string;
  unit: string;
  icon: string;
  active: boolean;
  series?: number[];
  seriesColor?: string;
}) {
  return (
    <div
      class="rounded-lg p-3 flex flex-col gap-1.5 transition-colors"
      classList={{
        "bg-zinc-50 dark:bg-zinc-800/50": !props.active,
        "bg-blue-50 dark:bg-blue-900/20 ring-1 ring-blue-400/40": props.active,
      }}
    >
      <div class="flex items-center gap-1.5 text-xs text-dimmed">
        <i class={props.icon} />
        <span>{props.label}</span>
      </div>
      <div class="flex items-baseline gap-1">
        <span class="text-2xl font-semibold tabular-nums">{props.value}</span>
        <span class="text-xs text-dimmed">{props.unit}</span>
      </div>
      <div class={`h-5 w-full ${props.seriesColor ?? ""}`}>
        <Show when={props.series && props.series.length > 1}>
          <Chart kind="sparkline" class="w-full h-full" data={props.series!} smooth showLast />
        </Show>
      </div>
    </div>
  );
}
