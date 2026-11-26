import type { Mode } from "@k2b/speedtest";
import { formatSpeedTestReading, speedTestSparklineTooltip } from "@k2b/speedtest/format";
import { type CliVariant, createSpeedtest } from "@k2b/speedtest/state";
import { Button, Chart, CopyButton, DashboardPanel, ProgressBar, SegmentedControl, StatCell, StatGrid, useLocale } from "@k2b/ui";
import { createUniqueId } from "solid-js";

export { speedTestMessages } from "@k2b/speedtest/messages";
export { type CliVariant, speedtestSnippet } from "@k2b/speedtest/state";

/**
 * The v1 screen of the speed test in Tools, on the shared measurement of `@k2b/speedtest/state`; Tools' v2 rebuild
 * replaces it with `SpeedtestPane`. Its island is `SpeedTest.island.tsx`.
 */
export default function SpeedTest(props: { server?: string; enabled?: boolean; initialCliVariant?: CliVariant }) {
  const {
    t,
    locale,
    server,
    mode,
    setMode,
    gaugeMax,
    state,
    progress,
    upload,
    downloadHistory,
    uploadHistory,
    ramp,
    phaseStarts,
    result,
    cliVariant,
    setCliVariant,
    json,
    setJson,
    setCopyFailed,
    done,
    running,
    limited,
    disabled,
    online,
    waiting,
    historySeconds,
    remaining,
    status,
    reading,
    readingLabel,
    chartCeiling,
    snippet,
    finalJson,
    terminal,
    stop,
    run,
  } = createSpeedtest(props);
  const id = createUniqueId();
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
              xAxis={{
                domain: [0, historySeconds()],
                insetEndpointLabels: true,
                format: (value) => `${formatSpeedTestReading(value, locale())} s`,
              }}
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
