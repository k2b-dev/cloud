import { Chart } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Canvas,
  Cells,
  Choice,
  Empty,
  Facts,
  Field,
  Notice,
  Pane,
  Progress,
  Section,
  StatusRow,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import type { Mode } from "../engine";
import { formatSpeedTestReading } from "./format";
import { type CliVariant, createSpeedtest, type SpeedtestProps } from "./speedtest-state";

export { speedTestMessages } from "./messages";
export { type CliVariant, createSpeedtest, speedtestSnippet } from "./speedtest-state";

/**
 * A measurement on v2, as one column: the duration and the start in the first band, the reading and the time left
 * while it runs, the four figures, the throughput over time, and the same measurement for the terminal. The status
 * row says what happens now (it is the live region); a failed measurement is a notice with its reason.
 */
export default function SpeedtestPane(props: SpeedtestProps & { label?: string; intro?: string; footer?: JSX.Element }) {
  const s = createSpeedtest(props);
  const t = s.t;
  const toast = useToast();
  const reading = (value: number | null) => formatSpeedTestReading(value, s.locale());
  const startLabel = () => (s.running() ? t().stop : s.state() === "done" || s.state() === "error" ? t().runAgain : t().startTest);
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      s.setCopyFailed(false);
      toast(t().copied, { status: "ok" });
    } catch {
      s.setCopyFailed(true);
      toast(t().copyFailed, { status: "bad" });
    }
  };
  return (
    <Pane
      label={props.label ?? t().measurement}
      scrollKey="speedtest"
      status={
        <StatusRow
          lead={s.state() === "idle" && !s.disabled() && s.online() && !s.copyFailed() ? s.phaseLabel() : s.status()}
          loading={s.running()}
          facts={[{ before: `${t().server} `, value: s.server() }]}
        />
      }
    >
      <Show when={s.state() === "error" && !s.limited()}>
        <Notice tone="bad" title={t().phaseError}>
          {s.status()}
        </Notice>
      </Show>
      <Band label={t().measurement}>
        <Show when={props.intro}>{(intro) => <Text type="body">{intro()}</Text>}</Show>
        <Field label={t().duration} hint={s.mode() === "quick" ? t().quickDescription : t().accurateDescription}>
          <Choice
            name="speedtest-mode"
            value={s.mode()}
            onChange={(value) => s.setMode(value as Mode)}
            disabled={s.running()}
            options={[
              { value: "quick", label: t().quick },
              { value: "accurate", label: t().accurate },
            ]}
          />
        </Field>
        <Canvas label={s.readingLabel()} height={200}>
          <Chart.Gauge value={s.reading() ?? 0} max={s.gaugeMax()} format={reading} label={s.readingLabel()} style={{ height: "100%" }} />
        </Canvas>
      </Band>
      <Bar
        start={
          <Progress
            value={s.state() === "done" ? 100 : s.running() ? Math.round((s.progress()?.progress ?? 0) * 100) : 0}
            of={100}
            label={
              s.state() === "done" || s.state() === "error" || s.state() === "cancelled"
                ? s.phaseLabel()
                : t().remaining({ seconds: s.remaining() })
            }
          />
        }
        end={
          <Button
            variant={s.running() ? undefined : "primary"}
            icon={s.running() ? "player-stop" : "player-play"}
            disabled={!s.running() && (s.disabled() || !s.online() || s.waiting() > 0)}
            onClick={() => (s.running() ? s.stop() : void s.run())}
          >
            {startLabel()}
          </Button>
        }
      />
      <Cells>
        <Cells.Cell
          icon="download"
          label="Download"
          value={`${reading(s.done("download") ? s.download() : null)} Mbit/s`}
          meta={t().downloadNote}
        />
        <Cells.Cell icon="upload" label="Upload" value={`${reading(s.done("upload") ? s.upload() : null)} Mbit/s`} meta={t().uploadNote} />
        <Cells.Cell
          icon="activity"
          label={t().ping}
          value={`${reading(s.done("ping") ? (s.progress()?.ping_ms ?? null) : null)} ms`}
          meta={t().jitterValue({ value: reading(s.done("ping") ? (s.progress()?.jitter_ms ?? null) : null) })}
        />
        <Cells.Cell
          icon="activity-heartbeat"
          label={t().loaded}
          value={`${reading(s.progress()?.loaded_latency_ms ?? null)} ms`}
          meta={t().loadedNote}
        />
      </Cells>
      <Section icon="chart-line" title={t().throughput} summary={t().rampup}>
        <Canvas label={t().throughput} height={240}>
          <Show when={s.phaseStarts().length > 0} fallback={<Empty icon="chart-line" text={t().pending} />}>
            <Chart.Line
              series={[
                { label: "Download", data: s.downloadHistory() },
                { label: "Upload", data: s.uploadHistory(), lineStyle: "dashed" },
                { label: t().rampupLabel, data: s.ramp().map(({ x, y }) => ({ x, y })), lineStyle: "dotted" },
              ]}
              // One window is 250 ms; a longer gap is a phase boundary or a missed window, never a line.
              maxGap={0.6}
              smooth={false}
              references={s.phaseStarts().map((item) => ({ axis: "x" as const, value: item.x, style: "dotted" as const }))}
              xAxis={{ domain: [0, s.historySeconds()], insetEndpointLabels: true, format: (value) => `${reading(value)} s` }}
              yAxis={{ domain: [0, s.chartCeiling()], format: (value) => reading(value) }}
              legend
              legendPlacement="top-start"
              labels={{ empty: t().pending }}
              style={{ height: "100%" }}
            />
          </Show>
        </Canvas>
      </Section>
      <Section
        icon="terminal-2"
        title={t().terminalTitle}
        summary={t().terminalHint}
        actions={[
          { label: s.json() ? t().progress : "--json", icon: s.json() ? "list" : "braces", onClick: () => s.setJson(!s.json()) },
          { label: t().copyResult, icon: "copy", disabled: !s.result(), onClick: () => void copy(s.finalJson()) },
        ]}
      >
        {/* The terminal is drawn text: a fixed 200 px, so switching to JSON or a long result scrolls inside it. */}
        <Canvas label={t().terminalOutput} height={200}>
          <pre
            tabIndex={0}
            style={{
              margin: 0,
              height: "100%",
              overflow: "auto",
              "white-space": "pre-wrap",
              "overflow-wrap": "anywhere",
              font: "12px/18px var(--k2-font-mono)",
            }}
          >
            {s.terminal()}
          </pre>
        </Canvas>
        <Field label={t().runtime}>
          <Choice
            name="speedtest-runtime"
            value={s.cliVariant()}
            onChange={(value) => s.setCliVariant(value as CliVariant)}
            options={[
              { value: "cloud", label: "Cloud CLI" },
              { value: "node", label: "Node" },
              { value: "bun", label: "Bun" },
            ]}
          />
        </Field>
        <Facts items={[{ label: t().command, value: s.snippet(), mono: true, copy: s.snippet() }]} />
      </Section>
      <Band label={t().about}>
        <Text type="meta" muted>
          {t().dataNotice}
        </Text>
        {props.footer}
      </Band>
    </Pane>
  );
}
