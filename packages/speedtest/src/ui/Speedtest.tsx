import {
  Button,
  Chart,
  CopyButton,
  DashboardPanel,
  ProgressBar,
  RichSelect,
  SegmentedControl,
  StatCell,
  StatGrid,
  useLocale,
} from "@k2b/ui";
import { batch, createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import { createBrowserTransport } from "../browser";
import { DEFAULT_SERVER, type Mode, PLANS, type Progress, type Result, runSpeedtest, SpeedtestError } from "../engine";
import { formatSpeedTestReading, speedTestSparklineTooltip } from "./format";
import { speedTestMessages } from "./messages";

export { speedTestMessages } from "./messages";

type State = "idle" | "ping" | "download" | "upload" | "verify" | "done" | "cancelled" | "error";
type Sample = { x: number; y: number };
type CliVariant = "cloud" | "bun" | "node";
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function speedtestSnippet(variant: CliVariant, server: string, mode: Mode) {
  if (variant === "cloud") return `cld tools speedtest --server ${shellQuote(server)} --mode ${mode}`;
  return `curl -fsS ${shellQuote(`${server}/cli`)} -o speedtest.mjs\n${variant === "bun" ? "bun" : "node"} speedtest.mjs --server ${shellQuote(server)} --mode ${mode}`;
}

export default function SpeedTest(props: { server?: string; enabled?: boolean; initialCliVariant?: CliVariant }) {
  const locale = useLocale();
  const t = () => speedTestMessages.resolve([locale()]).t;
  const server = () => props.server ?? DEFAULT_SERVER;
  const [mode, setMode] = createSignal<Mode>("quick");
  const [gaugeMax, setGaugeMax] = createSignal(100);
  const [state, setState] = createSignal<State>("idle");
  const [online, setOnline] = createSignal(true);
  const [progress, setProgress] = createSignal<Progress>();
  const [download, setDownload] = createSignal<number | null>(null);
  const [upload, setUpload] = createSignal<number | null>(null);
  const [downloadHistory, setDownloadHistory] = createSignal<Sample[]>([]);
  const [uploadHistory, setUploadHistory] = createSignal<Sample[]>([]);
  const [downloadRamp, setDownloadRamp] = createSignal<Sample[]>([]);
  const [uploadRamp, setUploadRamp] = createSignal<Sample[]>([]);
  const [completed, setCompleted] = createSignal<string[]>([]);
  const [result, setResult] = createSignal<Result>();
  const [error, setError] = createSignal<unknown>();
  const [retryAt, setRetryAt] = createSignal(0);
  const [now, setNow] = createSignal(0);
  const [cliVariant, setCliVariant] = createSignal<CliVariant>(props.initialCliVariant ?? "cloud");
  const [json, setJson] = createSignal(false);
  const [copyFailed, setCopyFailed] = createSignal(false);
  let controller: AbortController | undefined;
  let phaseStart = 0;
  let previousPhase = "";
  const running = () => ["ping", "download", "upload", "verify"].includes(state());
  const limited = () => {
    const value = error();
    return state() === "error" && value instanceof SpeedtestError && value.status === 429;
  };
  const disabled = () => props.enabled === false;
  const waiting = () => Math.max(0, Math.ceil((retryAt() - now()) / 1_000));
  const totalCap = () => PLANS[mode()].ping + PLANS[mode()].download + PLANS[mode()].upload;
  const remaining = () => Math.ceil((progress()?.remaining_ms ?? totalCap()) / 1_000);
  const labels = () => ({
    idle: t().phaseIdle,
    ping: t().phasePing,
    download: t().phaseDownload,
    upload: t().phaseUpload,
    verify: t().phaseVerify,
    done: t().phaseDone,
    cancelled: t().phaseCancelled,
    error: t().phaseError,
  });
  const phaseLabel = () =>
    disabled() ? t().phaseDisabled : !online() ? t().phaseOffline : limited() ? t().phaseWaiting : labels()[state()];
  const errorMessage = () => {
    const value = error();
    if (value instanceof SpeedtestError) {
      if (value.status === 429)
        return value.retryAfter && Number.isFinite(value.retryAfter) ? t().rateLimited({ seconds: waiting() }) : t().rateLimitedUnknown;
      if (value.code === "capacity") return t().capacity;
      if (value.code === "slow_server") return t().slow;
      if (value.code === "invalid_server") return t().invalid;
      if (value.status === 503 && waiting()) return t().busy({ seconds: waiting() });
      if (value.status) return t().http({ status: value.status });
    }
    return t().network;
  };
  const status = () =>
    copyFailed()
      ? t().copyFailed
      : disabled()
        ? t().disabled
        : !online()
          ? t().offline
          : state() === "error"
            ? errorMessage()
            : state() === "cancelled"
              ? t().cancelled
              : state() === "done"
                ? `${t().loaded}: ${formatSpeedTestReading(result()?.loaded_latency_ms ?? null, locale())} ms`
                : running()
                  ? t().remaining({ seconds: remaining() })
                  : t().ready;
  const reading = () =>
    state() === "ping" ? (progress()?.ping_ms ?? null) : ["upload", "verify"].includes(state()) ? upload() : download();
  const snippet = createMemo(() => speedtestSnippet(cliVariant(), server(), mode()));
  const finalJson = () => JSON.stringify(result() ?? null, null, 2);
  const terminal = createMemo(() => {
    if (json()) return `${snippet()} --json\n${result() ? finalJson() : `# ${status()}`}`;
    const p = progress();
    return [
      snippet(),
      `${t().server}: ${server()}`,
      `${t().ping}: ${formatSpeedTestReading(p?.ping_ms ?? null, locale())} ms · ${t().jitter}: ${formatSpeedTestReading(p?.jitter_ms ?? null, locale())} ms`,
      `Download: ${formatSpeedTestReading(download(), locale())} Mbit/s`,
      `Upload:   ${formatSpeedTestReading(upload(), locale())} Mbit/s`,
      `${t().loaded}: ${formatSpeedTestReading(p?.loaded_latency_ms ?? null, locale())} ms`,
      `${phaseLabel()} · ${running() ? t().remaining({ seconds: remaining() }) : status()}`,
    ].join("\n");
  });
  const clearIncomplete = () => {
    if (!completed().includes("download")) {
      setDownload(null);
      setDownloadHistory([]);
      setDownloadRamp([]);
    }
    if (!completed().includes("upload")) {
      setUpload(null);
      setUploadHistory([]);
      setUploadRamp([]);
    }
  };
  const stop = () => {
    controller?.abort();
    batch(() => {
      clearIncomplete();
      setState("cancelled");
    });
  };
  const update = (event: Progress) => {
    if (controller?.signal.aborted) return;
    batch(() => {
      setProgress(event);
      setState(event.phase);
      if (event.phase !== previousPhase) {
        previousPhase = event.phase;
        phaseStart = event.elapsed_ms;
      }
      if (event.phase_complete) setCompleted((items) => [...items, event.phase]);
      const value = event.phase === "ping" ? (event.ping_ms ?? 0) : event.mbps;
      if (value > gaugeMax()) {
        const magnitude = 10 ** Math.floor(Math.log10(value));
        setGaugeMax([1, 2.5, 5, 10].map((step) => magnitude * step).find((limit) => limit >= value) ?? magnitude * 10);
      }
      if (event.phase === "ping" || event.phase === "verify" || event.bytes === 0) return;
      (event.phase === "download" ? setDownload : setUpload)(event.mbps);
      // A delayed browser callback may arrive just beyond the deadline. Keep samples inside the fixed time axis.
      const sample = { x: Math.min(event.elapsed_ms, totalCap()) / 1_000, y: event.mbps };
      if (!event.phase_complete && event.elapsed_ms - phaseStart < PLANS[mode()].warmup)
        (event.phase === "download" ? setDownloadRamp : setUploadRamp)((items) => [...items, sample]);
      else (event.phase === "download" ? setDownloadHistory : setUploadHistory)((items) => [...items, sample]);
    });
  };
  const run = async () => {
    if (running() || disabled() || !online() || waiting()) return;
    controller = new AbortController();
    const current = controller;
    batch(() => {
      setCopyFailed(false);
      setGaugeMax(100);
      setError(undefined);
      setRetryAt(0);
      setResult(undefined);
      setProgress(undefined);
      setDownload(null);
      setUpload(null);
      setDownloadHistory([]);
      setUploadHistory([]);
      setDownloadRamp([]);
      setUploadRamp([]);
      setCompleted([]);
      setState("ping");
    });
    previousPhase = "";
    try {
      const next = await runSpeedtest({
        server: server(),
        mode: mode(),
        transport: createBrowserTransport(server()),
        signal: current.signal,
        onProgress: update,
      });
      if (controller !== current) return;
      batch(() => {
        setResult(next);
        setDownload(next.download_mbps);
        setUpload(next.upload_mbps);
        setState("done");
      });
    } catch (value) {
      if (controller !== current) return;
      clearIncomplete();
      if (current.signal.aborted) setState("cancelled");
      else {
        batch(() => {
          setError(value);
          setState("error");
          if (value instanceof SpeedtestError && value.retryAfter && Number.isFinite(value.retryAfter)) {
            setNow(Date.now());
            setRetryAt(Date.now() + value.retryAfter * 1_000);
          }
        });
      }
    }
  };
  onMount(() => {
    const updateOnline = () => {
      setOnline(navigator.onLine);
      if (!navigator.onLine && running()) stop();
    };
    updateOnline();
    window.addEventListener("online", updateOnline);
    window.addEventListener("offline", updateOnline);
    const timer = setInterval(() => {
      if (retryAt()) setNow(Date.now());
    }, 250);
    onCleanup(() => {
      clearInterval(timer);
      window.removeEventListener("online", updateOnline);
      window.removeEventListener("offline", updateOnline);
    });
  });
  onCleanup(() => {
    controller?.abort();
    controller = undefined;
  });
  return (
    <div class="tools-speedtest" data-state={disabled() ? "disabled" : !online() ? "offline" : state()}>
      <div class="tools-speedtest-server text-sm speedtest-muted">
        <span>
          {t().server}: <strong class="speedtest-primary inline-block max-w-full break-all">{server()}</strong>
        </span>
        <p>{t().dataNotice}</p>
      </div>
      <div class="tools-speedtest-layout">
        <DashboardPanel as="section" class="tools-speedtest-measure" aria-label={t().duration}>
          <div class="tools-speedtest-controls">
            <RichSelect
              value={mode()}
              onValueChange={(value) => {
                if (value === "quick" || value === "accurate") setMode(value);
              }}
              disabled={running()}
              title={t().duration}
              aria-label={t().duration}
              items={[
                { value: "quick", label: t().quick, description: t().quickDescription },
                { value: "accurate", label: t().accurate, description: t().accurateDescription },
              ]}
            />
            <Button
              size="md"
              class="tools-speedtest-start"
              variant={running() ? "secondary" : "primary"}
              disabled={!running() && (disabled() || !online() || waiting() > 0)}
              onClick={() => (running() ? stop() : void run())}
            >
              <i aria-hidden="true" class={running() ? "ti ti-player-stop" : state() === "error" ? "ti ti-refresh" : "ti ti-player-play"} />
              {running() ? t().stop : state() === "error" ? t().retry : state() === "done" ? t().runAgain : t().startTest}
            </Button>
          </div>
          <div class="tools-speedtest-gauge" data-empty={reading() === null}>
            <Chart.Gauge
              value={reading() ?? 0}
              max={gaugeMax()}
              format={(value) => formatSpeedTestReading(value, locale())}
              label={reading() === null ? t().pending : state() === "ping" ? "ms" : state() === "done" ? "Download · Mbit/s" : "Mbit/s"}
            />
          </div>
          <ol class="tools-speedtest-phases" aria-label={t().progress}>
            <For
              each={[
                { phase: "ping", label: t().ping, value: () => progress()?.ping_ms ?? null, unit: "ms" },
                { phase: "download", label: "Download", value: download, unit: "Mbit/s" },
                { phase: "upload", label: "Upload", value: upload, unit: "Mbit/s" },
              ]}
            >
              {(item) => (
                <li data-active={state() === item.phase}>
                  <span>
                    <i aria-hidden="true" class={completed().includes(item.phase) ? "ti ti-check text-success" : "ti ti-circle-dashed"} />{" "}
                    {item.label}
                  </span>
                  <span class="tabular-nums">
                    {formatSpeedTestReading(item.value(), locale())} {item.unit}
                  </span>
                </li>
              )}
            </For>
          </ol>
          <div class="tools-speedtest-eta">
            <ProgressBar
              value={state() === "done" ? 100 : (progress()?.progress ?? 0) * 100}
              label={t().progress}
              valueText={state() === "done" ? t().phaseDone : t().remaining({ seconds: remaining() })}
            />
            <div class="flex justify-between text-xs speedtest-muted tabular-nums">
              <span>{phaseLabel()}</span>
              <span>{running() ? t().remaining({ seconds: remaining() }) : `${totalCap() / 1_000} s`}</span>
            </div>
          </div>
          <div
            class="tools-speedtest-status text-sm"
            role="status"
            aria-live="polite"
            classList={{ "speedtest-danger": state() === "error" && !limited(), "speedtest-muted": state() !== "error" || limited() }}
          >
            {status()}
          </div>
        </DashboardPanel>
        <section class="tools-speedtest-detail">
          <DashboardPanel>
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <h2 class="text-sm font-semibold">{t().throughput}</h2>
              <div class="tools-speedtest-legend text-xs speedtest-muted">
                <span>Download</span>
                <span>Upload</span>
                <span>{t().rampupLabel}</span>
              </div>
            </div>
            <div class="tools-speedtest-chart">
              <Chart.Line
                series={[
                  { label: "Download", data: downloadHistory() },
                  { label: "Upload", data: uploadHistory(), lineStyle: "dashed" },
                  { label: `${t().rampup} · Download`, data: downloadRamp(), lineStyle: "dotted" },
                  { label: `${t().rampup} · Upload`, data: uploadRamp(), lineStyle: "dotted" },
                ]}
                xAxis={{ domain: [0, totalCap() / 1_000], label: "s" }}
                yAxis={{ label: "Mbit/s" }}
                legend={false}
                labels={{ empty: t().pending }}
              />
            </div>
            <p class="text-xs speedtest-muted">{t().rampup}</p>
          </DashboardPanel>
          <StatGrid columns={3} size="md">
            <Metric
              label="Download"
              value={formatSpeedTestReading(download(), locale())}
              unit="Mbit/s"
              icon="ti ti-download"
              active={state() === "download"}
              series={downloadHistory().map((p) => p.y)}
            />
            <Metric
              label="Upload"
              value={formatSpeedTestReading(upload(), locale())}
              unit="Mbit/s"
              icon="ti ti-upload"
              active={state() === "upload"}
              series={uploadHistory().map((p) => p.y)}
            />
            <Metric
              label={t().ping}
              value={formatSpeedTestReading(progress()?.ping_ms ?? null, locale())}
              unit="ms"
              icon="ti ti-activity"
              active={state() === "ping"}
            />
            <Metric
              label={t().jitter}
              value={formatSpeedTestReading(progress()?.jitter_ms ?? null, locale())}
              unit="ms"
              icon="ti ti-wave-square"
              active={false}
            />
            <Metric
              label={t().loaded}
              value={formatSpeedTestReading(progress()?.loaded_latency_ms ?? null, locale())}
              unit="ms"
              icon="ti ti-activity-heartbeat"
              active={false}
            />
          </StatGrid>
          <DashboardPanel class="flex flex-col gap-3 min-w-0">
            <div class="flex items-center justify-between gap-2 flex-wrap">
              <h2 class="text-sm font-semibold">{t().terminalTitle}</h2>
              <div class="flex items-center gap-2">
                <Button size="sm" variant="ghost" aria-pressed={json()} onClick={() => setJson(!json())}>
                  {json() ? t().progress : "--json"}
                </Button>
                <CopyButton
                  text={finalJson()}
                  onCopyError={() => setCopyFailed(true)}
                  onCopied={() => setCopyFailed(false)}
                  label={t().copyResult}
                  disabled={!result()}
                  size="sm"
                />
              </div>
            </div>
            <pre class="tools-speedtest-terminal" role="region" tabIndex={0} aria-label={t().terminalOutput}>
              {terminal()}
            </pre>
            <div class="tools-speedtest-runtimes">
              <SegmentedControl<CliVariant>
                value={cliVariant()}
                onValueChange={setCliVariant}
                ariaLabel={t().terminalTitle}
                size="sm"
                options={[
                  { value: "cloud", label: "Cloud CLI" },
                  { value: "node", label: "Node" },
                  { value: "bun", label: "Bun" },
                ]}
              />
              <CopyButton text={snippet()} onCopyError={() => setCopyFailed(true)} onCopied={() => setCopyFailed(false)} size="sm" />
            </div>
            <p class="text-xs speedtest-muted">{t().terminalHint}</p>
          </DashboardPanel>
        </section>
      </div>
    </div>
  );
}

/** App-owned reading composition; the shared KPI tile owns rendering and trend inspection. */
export function Metric(props: { label: string; value: string; unit: string; icon: string; active: boolean; series?: number[] }) {
  const locale = useLocale();
  return (
    <StatCell
      label={props.label}
      value={props.value}
      sub={props.unit}
      icon={props.icon}
      tone={props.active ? "blue" : "zinc"}
      trend={props.series}
      trendTooltip={speedTestSparklineTooltip({ label: props.label, unit: props.unit, locale: locale() })}
    />
  );
}
