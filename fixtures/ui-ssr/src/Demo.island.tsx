import {
  AppOverview,
  Avatar,
  Button,
  Calendar,
  Chart,
  Checkbox,
  CodeDisplay,
  ColorInput,
  DataTable,
  DatePicker,
  DocNote,
  DocPage,
  DocSection,
  FileBrowserPanel,
  type FileSource,
  LinkCard,
  LogEntriesTable,
  MarkdownView,
  NoticeCard,
  Pagination,
  PinInput,
  ProgressBar,
  prompts,
  RangePicker,
  Select,
  SettingsModal,
  Slider,
  StatCell,
  StatGrid,
  StatusBadge,
  StructuredDataPreview,
  Switch,
  toast,
  Widget,
  WidgetHero,
  WidgetList,
  WidgetPills,
  WidgetStat,
  WidgetStatus,
} from "@k2b/ui";
import { createSignal, type JSX } from "solid-js";

const demoFileSource: FileSource = {
  list: async () => [
    { path: "/README.md", mediaType: "text/markdown" },
    { path: "/src", kind: "folder" },
    { path: "/src/index.ts", mediaType: "text/typescript" },
  ],
  read: async (path) => ({
    encoding: "utf8",
    mediaType: path.endsWith(".md") ? "text/markdown" : "text/typescript",
    content: path.endsWith(".md") ? "# Portable UI\n\nSolid components without Cloud state." : "export * from './content';",
  }),
};

const Section = (props: { id: string; title: string; children: JSX.Element }) => (
  <section
    id={props.id}
    style="scroll-margin-top:16px;border:1px solid var(--k2b-border);border-radius:var(--k2b-radius-surface);background:var(--k2b-surface);padding:16px"
  >
    <h2 style="margin:0 0 14px;font-size:14px">{props.title}</h2>
    {props.children}
  </section>
);

export default function Demo() {
  const [theme, setTheme] = createSignal<"light" | "dark">("light");
  const [enabled, setEnabled] = createSignal(true);
  const [accepted, setAccepted] = createSignal(false);
  const [role, setRole] = createSignal("member");
  const [date, setDate] = createSignal<string | null>("2026-07-28");
  const [pin, setPin] = createSignal("123");
  const [balance, setBalance] = createSignal(20);
  const [color, setColor] = createSignal("#2563eb");
  const [transparent, setTransparent] = createSignal(false);
  const [calendarDate, setCalendarDate] = createSignal(new Date("2026-07-15T12:00:00Z"));

  const confirmAction = async () => {
    if (await prompts.confirm("This dialog is rendered by @k2b/ui.", { title: "Portable prompt" })) {
      toast.success("Confirmed");
    }
  };

  return (
    <div class="k2b-ui" data-theme={theme()}>
      <div style="min-height:100vh;background:var(--k2b-app-background);color:var(--k2b-text);padding:24px">
        <header style="display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 auto 20px;max-width:1120px">
          <div>
            <p style="margin:0;color:var(--k2b-text-muted);font-size:12px">@k2b/ui standalone fixture</p>
            <h1 style="margin:3px 0 0;font-size:24px">Certified package surface</h1>
          </div>
          <Button variant="secondary" onClick={() => setTheme(theme() === "light" ? "dark" : "light")}>
            <i class={theme() === "light" ? "ti ti-moon" : "ti ti-sun"} aria-hidden="true" />
            Toggle theme
          </Button>
        </header>

        <main style="display:grid;gap:16px;margin:0 auto;max-width:1120px">
          <Section id="inputs" title="Inputs">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">
              <Select
                label="Role"
                value={role()}
                onValueChange={(value) => value && setRole(value)}
                options={[
                  { value: "member", label: "Member" },
                  { value: "admin", label: "Administrator" },
                ]}
              />
              <DatePicker label="Release date" value={date()} onValueChange={setDate} clearable />
              <PinInput label="Access code" value={pin()} onValueChange={setPin} length={6} />
              <Slider label="Balance" value={balance()} onValueChange={setBalance} min={-100} max={100} center defaultValue={0} />
              <ColorInput
                label="Accent"
                value={color()}
                onValueChange={setColor}
                transparent
                transparentValue={transparent()}
                onTransparentValueChange={setTransparent}
              />
              <div style="display:grid;gap:10px;align-content:start">
                <Checkbox label="Accept updates" value={accepted()} onValueChange={setAccepted} />
                <Switch label="Automation" value={enabled()} onValueChange={setEnabled} />
              </div>
            </div>
          </Section>

          <Section id="surfaces" title="Surfaces and feedback">
            <div style="display:grid;gap:14px">
              <div style="display:flex;flex-wrap:wrap;gap:6px">
                <StatusBadge label="Healthy" tone="ok" />
                <StatusBadge label="Running" tone="running" variant="dot" />
                <StatusBadge label="Needs review" tone="warning" variant="text" />
                <StatusBadge label="Failed" tone="error" />
              </div>
              <ProgressBar label="Migration readiness" value={68} showValue />
              <NoticeCard.Grid
                items={[
                  {
                    title: "Generic by design",
                    tone: "info" as const,
                    detail: "No Cloud services, routes, permissions, or application state.",
                  },
                  {
                    title: "Prompt kernel",
                    tone: "warning" as const,
                    detail: "Dialogs remain scoped to the package root.",
                  },
                ]}
              >
                {(notice) => <NoticeCard {...notice} />}
              </NoticeCard.Grid>
              <Button onClick={confirmAction}>Open prompt</Button>
            </div>
          </Section>

          <Section id="content" title="Content">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px">
              <CodeDisplay title="Query" language="text" code={"select service, latency\nfrom telemetry\nwhere healthy = true;"} />
              <StructuredDataPreview title="Payload" data={{ service: "gateway", healthy: true, latency: { p95: 84, unit: "ms" } }} />
              <MarkdownView trustedHtml="<h3>Trusted Markdown</h3><p>Rendered HTML stays a deliberate consumer boundary.</p>" headingScale="compact" />
              <div style="display:grid;gap:12px;align-content:start">
                <RangePicker
                  value="24h"
                  options={[
                    { value: "1h", href: "?window=1h" },
                    { value: "24h", href: "?window=24h" },
                    { value: "7d", href: "?window=7d" },
                  ]}
                />
                <Pagination currentPage={3} totalPages={8} baseUrl="?page=" />
              </div>
            </div>
          </Section>

          <Section id="data-content" title="Data, charts, calendar, files and docs">
            <div style="display:grid;gap:16px">
              <DataTable
                rows={[
                  { id: "gateway", service: "Gateway", status: "Healthy", latency: 42 },
                  { id: "worker", service: "Worker", status: "Degraded", latency: 138 },
                ]}
                columns={[
                  { id: "service", header: "Service", value: (row) => row.service, sortable: true },
                  { id: "status", header: "Status", value: (row) => row.status },
                  { id: "latency", header: "Latency", value: (row) => `${row.latency} ms`, align: "right" },
                ]}
                getRowId={(row) => row.id}
                sort={{ key: "service", direction: "asc" }}
                sortHref={(next) => `?sort=${next.key}&direction=${next.direction}`}
                footer={{ values: { service: "2 services", latency: "90 ms avg" } }}
              />
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px">
                <Chart
                  kind="stateTimeline"
                  interactive
                  rows={[
                    { label: "Gateway", intervals: [{ from: 0, to: 7, state: "healthy", tooltip: "Gateway healthy" }] },
                    { label: "Worker", intervals: [{ from: 2, to: 5, state: "warning", tooltip: "Worker degraded" }] },
                  ]}
                  states={[
                    { state: "healthy", label: "Healthy", color: "#10b981" },
                    { state: "warning", label: "Warning", color: "#f59e0b" },
                  ]}
                  domain={[0, 7]}
                />
                <LogEntriesTable
                  entries={[
                    {
                      id: 1,
                      createdAt: "2026-07-28T08:15:00Z",
                      level: "info",
                      source: "gateway",
                      message: "Route registered",
                      metadata: null,
                    },
                    {
                      id: 2,
                      createdAt: "2026-07-28T08:16:00Z",
                      level: "warn",
                      source: "worker",
                      message: "Retry scheduled",
                      metadata: { attempt: 2 },
                    },
                  ]}
                />
              </div>
              <Calendar
                date={calendarDate()}
                onDateChange={setCalendarDate}
                dateConfig={{ timeZone: "UTC", locale: "en" }}
                events={[{ id: "review", title: "Release review", start: "2026-07-15T09:00:00Z", end: "2026-07-15T10:00:00Z" }]}
              />
              <FileBrowserPanel source={demoFileSource} initialPath="/README.md" />
              <section id="portable-docs">
                <DocPage>
                  <DocSection eyebrow="@k2b/ui" title="Portable documentation primitives">
                    <p>Navigation, readable content and an optional outline compose without a Cloud shell.</p>
                    <DocNote title="Consumer owned" variant="tip">
                      Routing and application state stay outside the package.
                    </DocNote>
                  </DocSection>
                </DocPage>
              </section>
            </div>
          </Section>

          <Section id="composition" title="Composition">
            <AppOverview title="Operations" subtitle="Cloud-neutral structure" icon="ti ti-activity">
              <AppOverview.Main title="Runtime">
                <StatGrid columns={3}>
                  <StatCell label="Requests" value="12.4k" sub="last 24 hours" trend={[8, 11, 9, 14, 12]} />
                  <StatCell label="Success" value="99.8%" sub="within SLO" />
                  <StatCell label="Latency" value="84ms" sub="p95" />
                </StatGrid>
              </AppOverview.Main>
              <AppOverview.Aside title="People">
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                  <Avatar name="Ada Lovelace" />
                  <span style="font-size:12px">Ada Lovelace</span>
                </div>
                <LinkCard
                  href="#widgets"
                  title="Open widgets"
                  description="Composable dashboard blocks"
                  icon="ti ti-layout-dashboard"
                  color="blue"
                />
              </AppOverview.Aside>
            </AppOverview>
          </Section>

          <Section id="settings" title="Settings">
            <SettingsModal title="Application settings">
              <SettingsModal.Tab id="general" title="General" icon="ti ti-settings">
                <p>General package settings.</p>
              </SettingsModal.Tab>
              <SettingsModal.Tab
                id="security"
                title="Security"
                description="Destructive options stay clearly separated."
                icon="ti ti-lock"
                tone="danger"
              >
                <Button variant="danger">Delete local fixture data</Button>
              </SettingsModal.Tab>
            </SettingsModal>
          </Section>

          <Section id="widgets" title="Widgets">
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px">
              <Widget title="Platform health" meta="just now" icon="ti ti-heartbeat" size="compact">
                <WidgetStatus title="Operational" message="All checks passed" tone="success" grow />
                <WidgetPills
                  pills={[
                    { label: "Apps", value: 23 },
                    { label: "Routes", value: 102, tone: "blue" },
                  ]}
                />
              </Widget>
              <Widget title="Requests" icon="ti ti-chart-bar" size="compact">
                <WidgetStat label="Last hour" value="12.4k" sub="99.8% successful" grow />
              </Widget>
              <Widget title="Deployments" href="?view=deployments" size="compact">
                <WidgetList
                  grow
                  items={[
                    { label: "gateway", sub: "healthy", icon: "ti ti-rocket", iconTone: "emerald", meta: "now" },
                    { label: "worker", sub: "healthy", icon: "ti ti-rocket", iconTone: "emerald", meta: "2m" },
                  ]}
                />
              </Widget>
              <Widget title="Empty state" size="compact">
                <WidgetHero title="All clear" subtitle="No pending work" icon="ti ti-circle-check" tone="emerald" />
              </Widget>
            </div>
          </Section>
        </main>
      </div>
    </div>
  );
}
