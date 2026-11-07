import { Button, Chart, CopyButton, DashboardPanel, ProgressBar, SegmentedControl, StatCell, StatGrid, useLocale } from "@k2b/ui";
import { batch, createMemo, createSignal, createUniqueId, onCleanup, onMount } from "solid-js";
import { createBrowserTransport } from "../browser";
import { DEFAULT_SERVER, type Mode, PLANS, type Progress, type Result, runSpeedtest, SpeedtestError } from "../engine";
import { formatSpeedTestReading, speedTestSparklineTooltip } from "./format";
import { speedTestMessages } from "./messages";

export { speedTestMessages } from "./messages";

type State = "idle" | "ping" | "download" | "upload" | "verify" | "done" | "cancelled" | "error";
type Sample = { x: number; y: number; phase?: "download" | "upload" };
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
  // Warmup windows of both transfer phases; the chart breaks the line between phases at their time gap.
  const [ramp, setRamp] = createSignal<Sample[]>([]);
  const [phaseStarts, setPhaseStarts] = createSignal<{ phase: "download" | "upload"; x: number }[]>([]);
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
  const id = createUniqueId();
  const done = (phase: string) => completed().includes(phase);
  const running = () => ["ping", "download", "upload", "verify"].includes(state());
  const limited = () => {
    const value = error();
    return state() === "error" && value instanceof SpeedtestError && value.status === 429;
  };
  const disabled = () => props.enabled === false;
  const waiting = () => Math.max(0, Math.ceil((retryAt() - now()) / 1_000));
  const totalCap = () => PLANS[mode()].ping + PLANS[mode()].download + PLANS[mode()].upload;
  const historySeconds = () => (state() === "done" ? result()!.duration_ms : totalCap()) / 1_000;
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
                ? t().finished({
                    seconds: new Intl.NumberFormat(locale(), { maximumFractionDigits: 1 }).format((result()?.duration_ms ?? 0) / 1_000),
                    steady: !!result()?.stable.download && !!result()?.stable.upload,
                  })
                : running()
                  ? [
                      phaseLabel(),
                      done("download") && state() !== "download" ? `Download ${formatSpeedTestReading(download(), locale())} Mbit/s` : "",
                      t().remaining({ seconds: remaining() }),
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : mode() === "quick"
                    ? t().quickDescription
                    : t().accurateDescription;
  /** The hero reading: the phase being measured, else the completed download. Tiles carry every other figure. */
  const reading = () =>
    state() === "ping" ? (progress()?.ping_ms ?? null) : state() === "upload" || state() === "verify" ? upload() : download();
  const readingLabel = () =>
    reading() === null
      ? t().pending
      : state() === "ping"
        ? `${t().ping} · ms`
        : state() === "upload" || state() === "verify"
          ? "Upload · Mbit/s"
          : "Download · Mbit/s";
  // Throughput starts at zero; the top is the next round step above every plotted window, so the axis never cuts data.
  const chartCeiling = createMemo(() => {
    const top = Math.max(0, ...[...downloadHistory(), ...uploadHistory(), ...ramp()].map((sample) => sample.y));
    if (top <= 0) return 100;
    const magnitude = 10 ** Math.floor(Math.log10(top));
    return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((step) => step * magnitude).find((limit) => limit >= top * 1.05) ?? magnitude * 10;
  });
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
      status(),
    ].join("\n");
  });
  const clearIncomplete = () => {
    if (!completed().includes("download")) {
      setDownload(null);
      setDownloadHistory([]);
      setRamp((items) => items.filter((sample) => sample.phase !== "download"));
      setPhaseStarts([]);
    }
    if (!completed().includes("upload")) {
      setUpload(null);
      setUploadHistory([]);
      setRamp((items) => items.filter((sample) => sample.phase !== "upload"));
      setPhaseStarts((items) => items.filter((item) => item.phase !== "upload"));
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
      if (event.phase === "ping" || event.phase === "verify") return;
      const phase = event.phase;
      // A delayed browser callback may arrive just beyond the deadline. Keep samples inside the fixed time axis.
      const x = Math.min(event.elapsed_ms, totalCap()) / 1_000;
      if (!phaseStarts().some((item) => item.phase === phase)) setPhaseStarts((items) => [...items, { phase, x }]);
      if (event.bytes === 0) return;
      (phase === "download" ? setDownload : setUpload)(event.mbps);
      // The completing event carries the phase aggregate, not a window rate; plotting it would end the line in a cliff.
      if (event.phase_complete) return;
      // The engine counts a window only when it starts at or after warmup, so a window ending at warmup is still ramp-up.
      if (event.elapsed_ms - phaseStart <= PLANS[mode()].warmup) setRamp((items) => [...items, { x, y: event.mbps, phase }]);
      else (phase === "download" ? setDownloadHistory : setUploadHistory)((items) => [...items, { x, y: event.mbps }]);
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
      setRamp([]);
      setPhaseStarts([]);
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
      <p class="tools-speedtest-server">
        {t().server} · <span class="tools-speedtest-server-name">{server()}</span>
      </p>
      <div class="tools-speedtest-layout">
        <DashboardPanel as="section" class="tools-speedtest-measure" aria-label={t().measurement}>
          <SegmentedControl<Mode>
            value={mode()}
            onValueChange={setMode}
            disabled={running()}
            ariaLabel={t().duration}
            class="tools-speedtest-mode"
            options={[
              { value: "quick", label: t().quick },
              { value: "accurate", label: t().accurate },
            ]}
          />
          <div class="tools-speedtest-gauge" data-empty={reading() === null}>
            <Chart.Gauge
              value={reading() ?? 0}
              max={gaugeMax()}
              format={(value) => formatSpeedTestReading(value, locale())}
              label={readingLabel()}
            />
          </div>
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
          <div class="tools-speedtest-eta" data-finished={state() === "done"} aria-hidden={state() === "done"}>
            <ProgressBar
              size="sm"
              value={state() === "done" ? 100 : (progress()?.progress ?? 0) * 100}
              label={t().progress}
              valueText={state() === "done" ? t().phaseDone : t().remaining({ seconds: remaining() })}
            />
          </div>
          <p
            class="tools-speedtest-status"
            role="status"
            aria-live="polite"
            classList={{ "speedtest-danger": state() === "error" && !limited() }}
          >
            {status()}
          </p>
        </DashboardPanel>
        <DashboardPanel as="section" class="tools-speedtest-history" aria-labelledby={`${id}-history`}>
          <header class="tools-speedtest-panel-head">
            <h2 id={`${id}-history`}>{t().throughput}</h2>
            <p>{t().rampup}</p>
          </header>
          <div class="tools-speedtest-chart">
            <Chart.Line
              series={[
                { label: "Download", data: downloadHistory() },
                { label: "Upload", data: uploadHistory(), lineStyle: "dashed" },
                { label: t().rampupLabel, data: ramp().map(({ x, y }) => ({ x, y })), lineStyle: "dotted" },
              ]}
              // One window is 250 ms; a longer gap is a phase boundary or a missed window, never a line.
              maxGap={0.6}
              smooth={false}
              references={phaseStarts().map((item) => ({ axis: "x" as const, value: item.x, style: "dotted" as const }))}
              xAxis={{ domain: [0, historySeconds()], format: (value) => `${formatSpeedTestReading(value, locale())} s` }}
              padding={{ right: 32 }}
              yAxis={{ domain: [0, chartCeiling()], format: (value) => formatSpeedTestReading(value, locale()) }}
              legend
              legendPlacement="top-start"
              labels={{ empty: t().pending }}
            />
          </div>
        </DashboardPanel>
        <StatGrid columns={4} size="md" class="tools-speedtest-figures">
          <Metric
            label="Upload"
            value={formatSpeedTestReading(done("upload") ? upload() : null, locale())}
            unit="Mbit/s"
            icon="ti ti-upload"
            note={t().uploadNote}
          />
          <Metric
            label={t().ping}
            value={formatSpeedTestReading(done("ping") ? (progress()?.ping_ms ?? null) : null, locale())}
            unit="ms"
            icon="ti ti-activity"
            note={t().pingNote}
          />
          <Metric
            label={t().jitter}
            value={formatSpeedTestReading(done("ping") ? (progress()?.jitter_ms ?? null) : null, locale())}
            unit="ms"
            icon="ti ti-wave-square"
            note={t().jitterNote}
          />
          <Metric
            label={t().loaded}
            value={formatSpeedTestReading(progress()?.loaded_latency_ms ?? null, locale())}
            unit="ms"
            icon="ti ti-activity-heartbeat"
            note={t().loadedNote}
          />
        </StatGrid>
        <DashboardPanel as="section" class="tools-speedtest-cli" aria-labelledby={`${id}-cli`}>
          <header class="tools-speedtest-cli-head">
            <h2 id={`${id}-cli`}>{t().terminalTitle}</h2>
            <div class="tools-speedtest-cli-actions">
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
          </header>
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
          <p class="tools-speedtest-note">{t().terminalHint}</p>
        </DashboardPanel>
      </div>
      <p class="tools-speedtest-note">{t().dataNotice}</p>
    </div>
  );
}

/** App-owned reading composition; the shared KPI tile owns rendering and trend inspection. */
export function Metric(props: {
  label: string;
  value: string;
  unit: string;
  icon: string;
  note?: string;
  active?: boolean;
  series?: number[];
}) {
  const locale = useLocale();
  return (
    <StatCell
      label={props.label}
      // The unit stays with its figure; an unavailable reading is the tile's own dash.
      value={
        props.value === "—" ? null : (
          <>
            {props.value}
            <span class="tools-speedtest-unit"> {props.unit}</span>
          </>
        )
      }
      sub={props.note}
      icon={props.icon}
      tone={props.active ? "blue" : "zinc"}
      trend={props.series}
      trendTooltip={speedTestSparklineTooltip({ label: props.label, unit: props.unit, locale: locale() })}
    />
  );
}
