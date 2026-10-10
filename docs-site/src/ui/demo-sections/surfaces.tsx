import {
  Avatar,
  Button,
  Calendar,
  type CalendarEvent,
  DataPanel,
  DateTimePicker,
  DescriptionList,
  IconButton,
  LinkCard,
  MultiSelectInput,
  NotFoundState,
  NoticeCard,
  NumberInput,
  PanelHeader,
  Paper,
  Placeholder,
  ProgressBar,
  ProgressRing,
  RangePicker,
  ResourceCard,
  type ResourceCardState,
  SegmentedControl,
  Select,
  StatCell,
  StatGrid,
  StatusBadge,
  TextInput,
  Timeline,
  type TimelineItem,
} from "@k2b/ui";
import baseCss from "@k2b/ui/base.css" with { type: "text" };
import { createSignal, For, type JSX, Show } from "solid-js";
import { DemoCard } from "../DemoCard";
import { DemoGrid, type DemoSection } from "./types";

const violetTheme = {
  "--k2b-accent-50": "#f5f3ff",
  "--k2b-accent-100": "#ede9fe",
  "--k2b-accent-200": "#ddd6fe",
  "--k2b-accent-300": "#c4b5fd",
  "--k2b-accent-400": "#a78bfa",
  "--k2b-accent-500": "#8b5cf6",
  "--k2b-accent-600": "#7c3aed",
  "--k2b-accent-700": "#6d28d9",
  "--k2b-accent-800": "#5b21b6",
  "--k2b-accent-900": "#4c1d95",
  "--k2b-accent-950": "#2e1065",
} as JSX.CSSProperties;

const ThemeDemo = () => {
  const [violet, setViolet] = createSignal(false);

  return (
    <DemoCard
      id="theme"
      chip={[{ kind: "asset", name: "global.css", from: "@k2b/ui/global.css" }]}
      description="Switch the local accent stack. The nested .k2b-ui scope updates its semantic tokens and components without changing the surrounding page."
      code={`import "@k2b/ui/global.css";

const [violet, setViolet] = createSignal(false);
const violetTheme = { /* --k2b-accent-50 through --k2b-accent-950 */ };

<div
  class="k2b-ui ui-theme-demo"
  style={violet() ? violetTheme : undefined}
>
  <Button
    variant={violet() ? "secondary" : "primary"}
    aria-pressed={!violet()}
    onClick={() => setViolet(false)}
  >
    Default blue
  </Button>
  <Button
    variant={violet() ? "primary" : "secondary"}
    aria-pressed={violet()}
    onClick={() => setViolet(true)}
  >
    Violet
  </Button>
  <Button variant="ghost"><i class="ti ti-palette" /> Themed icon</Button>
</div>`}
    >
      <div class="k2b-ui ui-theme-demo" style={violet() ? violetTheme : undefined}>
        <div class="ui-theme-demo__swatches">
          <div data-token="action">
            <span>Action solid</span>
            <code>--k2b-action-solid</code>
          </div>
          <div data-token="surface">
            <span>Surface</span>
            <code>--k2b-surface</code>
          </div>
          <div data-token="text">
            <span>Text</span>
            <code>--k2b-text</code>
          </div>
        </div>
        <div class="ui-theme-demo__actions" role="group" aria-label="Accent theme">
          <Button variant={violet() ? "secondary" : "primary"} aria-pressed={!violet()} onClick={() => setViolet(false)}>
            Default blue
          </Button>
          <Button variant={violet() ? "primary" : "secondary"} aria-pressed={violet()} onClick={() => setViolet(true)}>
            Violet
          </Button>
          <Button variant="ghost">
            <i class="ti ti-palette" aria-hidden="true" />
            Themed icon
          </Button>
        </div>
      </div>
    </DemoCard>
  );
};

/** A plain HTML page that uses no classes beyond the documented helpers. */
const basePage = `<main>
  <header class="row">
    <h1>Travel expenses</h1>
    <button type="button" class="primary">Export PDF</button>
  </header>
  <p class="muted">Receipts for October, paid back monthly.</p>
  <form class="row">
    <label>Purpose <input name="purpose" placeholder="Client visit"></label>
    <label>Amount <input name="amount" type="number" step="0.01"></label>
    <button>Add</button>
  </form>
  <p role="status" data-tone="success">Receipt saved.</p>
  <nav aria-label="Filter">
    <button type="button" aria-pressed="true">All</button>
    <button type="button" aria-pressed="false">Open</button>
    <button type="button" aria-pressed="false">Done</button>
  </nav>
  <ul>
    <li><label><input type="checkbox" checked> Book the train</label><button type="button" class="danger" aria-label="Delete Book the train">✕</button></li>
    <li><label><input type="checkbox"> Hand in the receipts</label><button type="button" class="danger" aria-label="Delete Hand in the receipts">✕</button></li>
  </ul>
  <section>
    <h2>Summary</h2>
    <div class="grid">
      <div class="stat"><span>Total</span><strong>€237.40</strong></div>
      <div class="stat"><span>Receipts</span><strong>3</strong></div>
      <div class="stat"><span>Open</span><strong>1</strong></div>
    </div>
    <figure>
      <table>
        <thead><tr><th>Purpose</th><th>Status</th><th class="num">Amount</th><th><span class="sr-only">Actions</span></th></tr></thead>
        <tbody>
          <tr><td>Train Berlin to Hamburg<br><small>Oct 2</small></td><td><span class="tag" data-tone="success">Paid</span></td><td class="num">€89.90</td><td><button type="button" class="danger" aria-label="Delete train receipt">✕</button></td></tr>
          <tr><td>Hotel near the client<br><small>Oct 2</small></td><td><span class="tag" data-tone="warning">Open</span></td><td class="num">€124.00</td><td><button type="button" class="danger" aria-label="Delete hotel receipt">✕</button></td></tr>
        </tbody>
      </table>
    </figure>
    <details>
      <summary>Cost center</summary>
      <dl><dt>Number</dt><dd>4711</dd><dt>Approver</dt><dd>Jana Nowak</dd></dl>
    </details>
  </section>
  <section>
    <h2>Approval</h2>
    <p role="alert">The amount must be a number.</p>
    <progress value="2" max="3">2 of 3 approved</progress>
  </section>
</main>`;

const BaseStylesheetDemo = () => {
  const [theme, setTheme] = createSignal<"light" | "dark">("light");
  const [width, setWidth] = createSignal<"phone" | "desktop">("desktop");
  const srcdoc = () =>
    `<!doctype html><html lang="en" data-theme="${theme()}"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${baseCss}</style></head><body>${basePage}</body></html>`;

  return (
    <DemoCard
      id="base-stylesheet"
      chip={[{ kind: "asset", name: "base.css", from: "@k2b/ui/base.css" }]}
      description="A plain HTML page without its own CSS. Switch the theme attribute and the width; the page keeps one rhythm, flat key figures, quiet row actions, and a header row with the action at the end."
      code={`import baseCss from "@k2b/ui/base.css" with { type: "text" };

const page = \`<!doctype html>
<html lang="en" data-theme="\${theme}">
  <head><style>\${baseCss}</style></head>
  <body>
    <main>
      <header class="row"><h1>Travel expenses</h1><button type="button" class="primary">Export PDF</button></header>
      <ul><li><label><input type="checkbox"> Hand in the receipts</label><button type="button" class="danger" aria-label="Delete">✕</button></li></ul>
      <div class="grid"><div class="stat"><span>Total</span><strong>€237.40</strong></div></div>
    </main>
  </body>
</html>\`;

<iframe title="Base stylesheet example" sandbox="" srcdoc={page} />`}
    >
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap gap-3">
          <SegmentedControl
            ariaLabel="Theme"
            size="sm"
            value={theme}
            onValueChange={setTheme}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
          <SegmentedControl
            ariaLabel="Width"
            size="sm"
            value={width}
            onValueChange={setWidth}
            options={[
              { value: "phone", label: "390 px" },
              { value: "desktop", label: "Full width" },
            ]}
          />
        </div>
        <iframe
          title="Base stylesheet example"
          sandbox=""
          srcdoc={srcdoc()}
          style={{
            width: width() === "phone" ? "390px" : "100%",
            "max-width": "100%",
            height: "36rem",
            border: "0",
            "border-radius": "var(--k2b-radius-surface)",
          }}
        />
      </div>
    </DemoCard>
  );
};

const EmptyDemo = () => (
  <DemoCard
    id="empty-states"
    chip={[
      { kind: "component", name: "Placeholder", from: "@k2b/ui" },
      { kind: "component", name: "NotFoundState", from: "@k2b/ui" },
    ]}
    description="The examples intentionally combine compact, inline, panel, centered, and left-aligned placeholders; the code below names each non-default layout choice. NotFoundState handles a route-level dead end."
    code={`import { Button, NotFoundState, Placeholder } from "@k2b/ui";

<Placeholder
  surface="paper"
  title="No projects"
  description="Create the first project."
  icon="ti ti-folder-off"
  action={<Button size="sm">New project</Button>}
/>
<Placeholder surface="paper" state="loading" variant="panel" title="Loading projects" description="Fetching the latest projects." />
<Placeholder surface="paper" state="error" align="left" title="Projects unavailable" description="Reload the page to try again." />
<NotFoundState code="404" title="Project not found" description="It may have been moved." action={{ label: "All projects", href: "/projects" }} />
<Placeholder surface="paper" variant="inline" align="left" icon="ti ti-file-text" description="No notes yet" />`}
  >
    <div class="ui-demo-form-grid">
      <Placeholder
        surface="paper"
        title="No projects"
        description="Create the first project."
        icon="ti ti-folder-off"
        action={<Button size="sm">New project</Button>}
      />
      <Placeholder surface="paper" state="loading" variant="panel" title="Loading projects" description="Fetching the latest projects." />
      <Placeholder surface="paper" state="error" align="left" title="Projects unavailable" description="Reload the page to try again." />
      <NotFoundState
        code="404"
        title="Project not found"
        description="It may have been moved."
        action={{ label: "All projects", href: "#empty-states" }}
      />
      <Placeholder surface="paper" variant="inline" align="left" icon="ti ti-file-text" description="No notes yet" />
    </div>
  </DemoCard>
);

const PaperDemo = () => (
  <DemoCard
    id="paper"
    chip={{ kind: "component", name: "Paper", from: "@k2b/ui" }}
    description="Paper provides one quiet neutral boundary without choosing content spacing. Elevation is opt-in for a complete surface that sits above its surroundings."
    code={`import { Paper } from "@k2b/ui";

<Paper as="section" class="project-summary">
  <h2>Project summary</h2>
  <p>Three services are ready for deployment.</p>
</Paper>

<Paper as="a" href="/projects/current" class="project-summary-link" elevated interactive>
  Open the current project
</Paper>`}
  >
    <div class="ui-paper-demo-grid">
      <Paper as="section" class="ui-paper-demo">
        <span class="ui-paper-demo__eyebrow">Project summary</span>
        <h2>Three services are ready</h2>
        <p>Content spacing belongs to the application.</p>
      </Paper>
      <Paper as="a" href="#paper" class="ui-paper-demo ui-paper-demo--link" elevated interactive>
        <span>
          <strong>Current project</strong>
          <small>Open deployment details</small>
        </span>
        <i class="ti ti-arrow-right" aria-hidden="true" />
      </Paper>
    </div>
  </DemoCard>
);

const CardsDemo = () => (
  <DemoCard
    id="cards"
    chip={[
      { kind: "component", name: "LinkCard", from: "@k2b/ui" },
      { kind: "component", name: "Avatar", from: "@k2b/ui" },
    ]}
    description="LinkCard uses an explicit color or the app accent and can carry one trailing count; Avatar accepts a portable image URL or text fallback."
    code={`import { Avatar, LinkCard } from "@k2b/ui";

<LinkCard href="/runtime" title="Runtime" description="Open details" icon="ti ti-server" color="cyan" />
<LinkCard href="/apps/pulse" title="Pulse" description="Metrics and dashboards" icon="ti ti-activity" meta="12 capabilities" />
<Avatar name="Ada Lovelace" src="/avatars/ada.webp" size="lg" />
<Avatar name="Grace Hopper" fallback="GH" size="md" />`}
  >
    <div class="ui-demo-form-grid">
      <LinkCard href="#cards" title="Runtime" description="Open runtime details" icon="ti ti-server" color="cyan" />
      <LinkCard href="#cards" title="Pulse" description="Metrics and dashboards" icon="ti ti-activity" meta="12 capabilities" />
      <div class="ui-demo-row">
        <Avatar name="Ada Lovelace" src="/assets/logo.svg" size="lg" />
        <Avatar name="Grace Hopper" fallback="GH" size="md" />
      </div>
    </div>
  </DemoCard>
);

const resourceStates: ResourceCardState[] = ["ok", "loading", "no_access", "deleted", "unavailable"];

const ResourceCardDemo = () => (
  <DemoCard
    id="resource-cards"
    chip={{ kind: "component", name: "ResourceCard", from: "@k2b/ui" }}
    description="ResourceCard keeps one size while it loads, shows the element, or says that the reader has no access, the element is deleted, or it is not available right now. Outside ok it shows nothing of the element."
    code={`import { ResourceCard } from "@k2b/ui";

<ResourceCard
  state={card.state}
  title="Onboarding checklist"
  icon="ti ti-notebook"
  source="Notebooks"
  location="Team handbook"
  preview="Laptop, accounts, and the first week"
  href="/notebooks/onboarding"
/>`}
  >
    <div class="ui-demo-form-grid">
      <For each={resourceStates}>
        {(state) => (
          <ResourceCard
            state={state}
            title="Onboarding checklist"
            icon="ti ti-notebook"
            source="Notebooks"
            location="Team handbook"
            preview="Laptop, accounts, and the first week"
            href="#resource-cards"
          />
        )}
      </For>
    </div>
  </DemoCard>
);

const formatDuration = (minutes: number) =>
  minutes < 60 ? `${minutes} min` : minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} h`;

const DetailsDemo = () => {
  const [due, setDue] = createSignal<string | null>("2026-10-06T17:00");
  const [estimate, setEstimate] = createSignal<number | null>(90);
  const [priority, setPriority] = createSignal<string | null>("medium");
  const [labels, setLabels] = createSignal<string[]>(["hardware"]);

  return (
    <DemoCard
      id="details"
      chip={[
        { kind: "component", name: "DescriptionList", from: "@k2b/ui" },
        { kind: "component", name: "Select", from: "@k2b/ui" },
      ]}
      description="Semantic key-value content in a responsive grid or compact inspector rows. Both layouts retain real dl/dt/dd elements and support optional actions. A plain control as a row's value turns the whole row into that control."
      code={`{/* Scan-friendly facts */}
<DescriptionList columns={2} items={facts} />

{/* Compact metadata in a detail panel */}
<DescriptionList
  layout="rows"
  size="sm"
  actionVisibility="progressive"
  items={metadata}
/>

{/* Property rows: the value is the control, the whole row opens it */}
<DescriptionList
  layout="rows"
  size="sm"
  items={[
    { term: "Due", description: <DateTimePicker aria-label="Due" appearance="plain" placeholder="No due date" clearable value={due} onValueChange={setDue} /> },
    { term: "Estimate", description: <NumberInput aria-label="Estimate" appearance="plain" placeholder="No estimate" suffix="min" min={1} formatValue={formatDuration} value={estimate} onValueCommit={setEstimate} /> },
    { term: "Priority", description: <Select aria-label="Priority" appearance="plain" placeholder="No priority" clearable options={priorities} value={priority} onValueChange={setPriority} /> },
    { term: "Labels", description: <MultiSelectInput aria-label="Labels" appearance="plain" placeholder="Label" placeholderIcon="ti ti-plus" options={labelOptions} value={labels} onValueChange={setLabels} /> },
  ]}
/>`}
    >
      <div class="ui-demo-form-grid">
        <article class="ui-detail-panel-pattern">
          <header>
            <strong>Responsive grid</strong>
            <span>Scan a small set of peer facts across one to three columns.</span>
          </header>
          <DescriptionList
            columns={2}
            items={[
              { term: "Owner", description: "Platform team" },
              { term: "Region", description: "Europe West" },
              { term: "Created", description: "31 July 2026" },
              {
                term: "Repository",
                description: "cloud",
                action: (
                  <IconButton label="Open repository" size="xs" variant="ghost">
                    <i class="ti ti-external-link" aria-hidden="true" />
                  </IconButton>
                ),
              },
            ]}
          />
        </article>
        <article class="ui-detail-panel-pattern">
          <header>
            <strong>Compact rows</strong>
            <span>Align terms and values for inspector metadata and settings summaries.</span>
          </header>
          <DescriptionList
            layout="rows"
            size="sm"
            actionVisibility="progressive"
            items={[
              { term: "Created", description: "31 July 2026, 14:32" },
              { term: "Updated", description: "13 August 2026, 18:41" },
              {
                term: "ID",
                description: "Res7K2",
                action: (
                  <IconButton label="Copy resource ID" size="xs" variant="ghost">
                    <i class="ti ti-copy" aria-hidden="true" />
                  </IconButton>
                ),
              },
            ]}
          />
        </article>
        <article class="ui-detail-panel-pattern">
          <header>
            <strong>Property rows</strong>
            <span>Values read as text; hover shows a quiet surface and a click anywhere in the row edits.</span>
          </header>
          <DescriptionList
            layout="rows"
            size="sm"
            items={[
              {
                term: "Due",
                description: (
                  <DateTimePicker
                    aria-label="Due"
                    appearance="plain"
                    placeholder="No due date"
                    clearable
                    value={due}
                    onValueChange={setDue}
                  />
                ),
              },
              {
                term: "Estimate",
                description: (
                  <NumberInput
                    aria-label="Estimate"
                    appearance="plain"
                    placeholder="No estimate"
                    suffix="min"
                    min={1}
                    formatValue={formatDuration}
                    value={estimate}
                    onValueCommit={setEstimate}
                  />
                ),
              },
              {
                term: "Priority",
                description: (
                  <Select
                    aria-label="Priority"
                    appearance="plain"
                    placeholder="No priority"
                    clearable
                    options={[
                      { id: "high", label: "High", color: "#f97316" },
                      { id: "medium", label: "Medium", color: "#eab308" },
                      { id: "low", label: "Low", color: "#3b82f6" },
                    ]}
                    value={priority}
                    onValueChange={setPriority}
                  />
                ),
              },
              {
                term: "Labels",
                description: (
                  <MultiSelectInput
                    aria-label="Labels"
                    appearance="plain"
                    placeholder="Label"
                    placeholderIcon="ti ti-plus"
                    options={[
                      { id: "hardware", label: "Hardware", color: "#2563eb" },
                      { id: "office", label: "Office", color: "#16a34a" },
                      { id: "network", label: "Network", color: "#9333ea" },
                    ]}
                    value={labels}
                    onValueChange={setLabels}
                  />
                ),
              },
              { term: "Created", description: "31 July 2026, 14:32" },
            ]}
          />
        </article>
      </div>
    </DemoCard>
  );
};

const ProgressDemo = () => (
  <DemoCard
    id="progress"
    chip={{ kind: "component", name: "ProgressBar", from: "@k2b/ui" }}
    description="Determinate progress in semantic tones and three compact sizes."
    code={`<ProgressBar value={72.4} label="Upload progress" tone="success" showValue />
<ProgressBar value={38} label="Indexing" size="sm" showValue />
<ProgressBar value={16} label="Storage limit" tone="danger" size="xs" showValue />
<ProgressRing value={35} label="Usage" />
<ProgressRing value={92} tone="warning" label="Usage, almost used up" />
<ProgressRing value={100} tone="danger" label="Usage, used up" />`}
  >
    <div class="ui-demo-form-grid">
      <ProgressBar value={72.4} label="Upload progress" tone="success" showValue />
      <ProgressBar value={38} label="Indexing" showValue size="sm" />
      <ProgressBar value={16} label="Storage limit" tone="danger" showValue size="xs" />
      <div class="flex items-center gap-3">
        <ProgressRing value={35} label="Usage" />
        <ProgressRing value={92} tone="warning" label="Usage, almost used up" />
        <ProgressRing value={100} tone="danger" label="Usage, used up" />
      </div>
    </div>
  </DemoCard>
);

const StatsDemo = () => (
  <DemoCard
    id="stats"
    chip={[
      { kind: "component", name: "StatGrid", from: "@k2b/ui" },
      { kind: "component", name: "StatCell", from: "@k2b/ui" },
    ]}
    description="This example pins three columns for its three cells; omitting columns uses the six-column responsive ladder. Cells can link, show contextual accents, and render compact trends."
    code={`import { StatCell, StatGrid } from "@k2b/ui";

<StatGrid columns={3} title="Runtime" action={{ label: "Observability", href: "./observability" }}>
  <StatCell label="Requests" value="42k" sub="last hour" trend={[12, 18, 16, 24, 42]} />
  <StatCell label="Latency" value="83 ms" sub="p95" href="./observability" valueClass="app-latency-warning" />
  <StatCell label="Errors" value={12} sub="last hour" accent={{ tone: "red", icon: "ti ti-alert-circle", text: "inspect" }} />
</StatGrid>`}
  >
    <StatGrid columns={3} title="Runtime" action={{ label: "Observability", href: "./observability" }}>
      <StatCell label="Requests" value="42k" sub="last hour" trend={[12, 18, 16, 24, 42]} />
      <StatCell label="Latency" value="83 ms" sub="p95" href="./observability" valueClass="ui-stat-attention" />
      <StatCell label="Errors" value={12} sub="last hour" accent={{ tone: "red", icon: "ti ti-alert-circle", text: "inspect" }} />
    </StatGrid>
  </DemoCard>
);

const OperationalDemo = () => {
  const notices = [
    { tone: "neutral" as const, title: "Release deployed", detail: "Version 2.4 is serving all regions." },
    { tone: "info" as const, title: "Maintenance scheduled", detail: "Telemetry pauses briefly at 02:00 UTC." },
    { tone: "success" as const, title: "Backfill complete", detail: "All historical samples are available." },
    { tone: "warning" as const, title: "Delayed source", detail: "The last sample arrived 8 minutes ago." },
    { tone: "danger" as const, title: "Database unavailable", detail: "Current diagnostics could not be loaded." },
  ];

  return (
    <DemoCard
      id="observability"
      chip={[
        { kind: "component", name: "PanelHeader", from: "@k2b/ui" },
        { kind: "component", name: "DataPanel", from: "@k2b/ui" },
        { kind: "component", name: "StatusBadge", from: "@k2b/ui" },
        { kind: "component", name: "NoticeCard", from: "@k2b/ui" },
        { kind: "component", name: "NoticeCard.Grid", from: "@k2b/ui" },
        { kind: "component", name: "RangePicker", from: "@k2b/ui" },
      ]}
      description="Persistent notices and six semantic status tones keep operational meaning consistent across panels and dense rows."
      code={`import {
  DataPanel,
  NoticeCard,
  PanelHeader,
  RangePicker,
  StatusBadge,
  Timeline,
  type TimelineItem,
} from "@k2b/ui";

const notices = [
  { tone: "neutral", title: "Release deployed", detail: "Version 2.4 is serving all regions." },
  { tone: "info", title: "Maintenance scheduled", detail: "Telemetry pauses briefly at 02:00 UTC." },
  { tone: "success", title: "Backfill complete", detail: "All historical samples are available." },
  { tone: "warning", title: "Delayed source", detail: "The last sample arrived 8 minutes ago." },
  { tone: "danger", title: "Database unavailable", detail: "Current diagnostics could not be loaded." },
] as const;

<div class="ui-demo-form-grid">
  <PanelHeader
    title="System status"
    subtitle="Updated just now"
    actions={
      <RangePicker
        value="24h"
        options={[
          { value: "1h", href: "?range=1h" },
          { value: "24h", href: "?range=24h" },
        ]}
      />
    }
  />
  <NoticeCard.Grid items={notices}>
    {(notice) => <NoticeCard tone={notice.tone} title={notice.title} detail={notice.detail} />}
  </NoticeCard.Grid>

  <DataPanel title="Routes" subtitle="6 states">
    <div class="ui-demo-row ui-data-panel-demo-body">
      <StatusBadge label="Online" tone="ok" />
      <StatusBadge label="Attention" tone="warning" />
      <StatusBadge label="Failed" tone="error" />
      <StatusBadge label="Degraded" tone="degraded" />
      <StatusBadge
        label="Refreshing telemetry and dependency health"
        tone="running"
        variant="dot"
        title="Refreshing telemetry and dependency health"
      />
      <StatusBadge label="Disabled" tone="neutral" variant="text" />
    </div>
  </DataPanel>
</div>`}
    >
      <div class="ui-demo-form-grid">
        <PanelHeader
          title="System status"
          subtitle="Updated just now"
          actions={
            <RangePicker
              value="24h"
              options={[
                { value: "1h", href: "?range=1h" },
                { value: "24h", href: "?range=24h" },
              ]}
            />
          }
        />
        <NoticeCard.Grid items={notices}>
          {(notice) => <NoticeCard tone={notice.tone} title={notice.title} detail={notice.detail} />}
        </NoticeCard.Grid>
        <DataPanel title="Routes" subtitle="6 states">
          <div class="ui-demo-row ui-data-panel-demo-body">
            <StatusBadge label="Online" tone="ok" />
            <StatusBadge label="Attention" tone="warning" />
            <StatusBadge label="Failed" tone="error" />
            <StatusBadge label="Degraded" tone="degraded" />
            <StatusBadge
              label="Refreshing telemetry and dependency health"
              tone="running"
              variant="dot"
              title="Refreshing telemetry and dependency health"
            />
            <StatusBadge label="Disabled" tone="neutral" variant="text" />
          </div>
        </DataPanel>
      </div>
    </DemoCard>
  );
};

const calendarDemoDate = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 12, 12));
};

const calendarDemoEvents = (month: Date): CalendarEvent[] => {
  const at = (day: number, hour = 0, minute = 0) =>
    new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), day, hour, minute)).toISOString();

  return [
    { id: "kickoff", title: "Month kickoff", start: at(2), end: at(3), allDay: true, color: "emerald" },
    {
      id: "roadmap",
      title: "Roadmap planning",
      description: "Align the next milestones, owners, and open product decisions.",
      start: at(5, 9),
      end: at(5, 12),
      color: "violet",
    },
    { id: "partner", title: "Partner call", start: at(5, 9, 30), end: at(5, 10, 30), color: "red" },
    { id: "review", title: "Design review", start: at(5, 10), end: at(5, 11, 30), color: "cyan" },
    { id: "handover", title: "Ops handover", start: at(9, 8, 30), end: at(9, 9, 15), color: "zinc" },
    { id: "focus", title: "Focus block", start: at(9, 9), end: at(9, 12), color: "blue" },
    { id: "checklist", title: "Launch checklist", start: at(12), end: at(13), allDay: true, color: "amber", display: "marker" },
    { id: "launch", title: "Product launch", start: at(12), end: at(13), allDay: true, color: "red" },
    { id: "standup", title: "Team stand-up", start: at(12, 9), end: at(12, 10), color: "emerald" },
    {
      id: "demo",
      title: "Customer demo",
      description: "Walk through the new workspace flow and capture follow-up questions.",
      start: at(12, 9, 30),
      end: at(12, 11),
      color: "cyan",
    },
    {
      id: "lunch",
      title: "Lunch and learn",
      description: "A practical tour of accessible interaction patterns.",
      start: at(12, 10, 30),
      end: at(12, 12),
      color: "violet",
    },
    {
      id: "retro",
      title: "Retrospective",
      description: "Review what worked, what slowed us down, and one change for next week.",
      start: at(12, 15),
      end: at(12, 16, 30),
      color: "blue",
    },
    { id: "release", title: "Release window", start: at(18), end: at(21), allDay: true, color: "amber" },
    { id: "offsite", title: "Team offsite", start: at(23), end: at(25), allDay: true, color: "emerald" },
    { id: "brand", title: "Brand review", start: at(24, 9), end: at(24, 10, 30), colorHex: "#ec4899" },
    { id: "office-hours", title: "Open office hours", start: at(24, 10), end: at(24, 13), color: "cyan" },
  ];
};

const isHexColor = (value: string | undefined): value is `#${string}` => value?.startsWith("#") ?? false;
/** The calendar's events on the timeline view, from the evening before the date through the week after it. */
const timelineDemoItems = (events: CalendarEvent[]): TimelineItem[] =>
  events.map((event) => ({
    id: event.id,
    label: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    color: isHexColor(event.colorHex) ? event.colorHex : event.color,
  }));
const timelineDemoRange = (date: Date) => ({
  from: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - 1, 20)),
  to: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 8)),
});

/** The month view's quick create: a title for one all-day event over the selected days. */
const CalendarDemoQuickCreate = (props: { onCreate: (title: string) => void }) => {
  const [title, setTitle] = createSignal("");
  const create = () => {
    if (title().trim()) props.onCreate(title().trim());
  };
  return (
    <form
      class="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        create();
      }}
    >
      <TextInput aria-label="Title" placeholder="Title" value={title} onValueChange={setTitle} onSubmit={create} />
      <Button type="submit" variant="primary" size="sm" class="self-end">
        Create
      </Button>
    </form>
  );
};

export const CalendarDemo = () => {
  const initialDate = calendarDemoDate();
  const [date, setDate] = createSignal(initialDate);
  const [view, setView] = createSignal<"day" | "week" | "month" | "year" | "timeline">("month");
  const [selectedEventId, setSelectedEventId] = createSignal<string>();
  const [events, setEvents] = createSignal<CalendarEvent[]>(calendarDemoEvents(initialDate));
  const changeDate = (next: Date) => {
    const current = date();
    if (current.getUTCFullYear() !== next.getUTCFullYear() || current.getUTCMonth() !== next.getUTCMonth()) {
      setEvents(calendarDemoEvents(next));
    }
    setDate(next);
  };
  return (
    <DemoCard
      id="calendar"
      chip={{ kind: "component", name: "Calendar", from: "@k2b/ui" }}
      description="A controlled calendar with overlapping, crowded, all-day, and multi-day events generated for every visible month, and a Timeline added as a fifth view."
      code={`const initialDate = calendarDemoDate();
const [date, setDate] = createSignal(initialDate);
const [events, setEvents] = createSignal(calendarDemoEvents(initialDate));
const [selectedEventId, setSelectedEventId] = createSignal<string>();

const changeDate = (next: Date) => {
  const current = date();
  if (next.getUTCFullYear() !== current.getUTCFullYear() || next.getUTCMonth() !== current.getUTCMonth()) {
    setEvents(calendarDemoEvents(next));
  }
  setDate(next);
};

<Calendar
  date={date()}
  view={view()}
  views={["day", "week", "month", "year"]}
  customViews={[{ value: "timeline", label: "Timeline" }]}
  dateConfig={{ timeZone: "UTC", locale: "en" }}
  events={events()}
  selectedEventId={selectedEventId()}
  onDateChange={changeDate}
  onViewChange={setView}
  onEventActivate={(event) => setSelectedEventId(event.id)}
  onEventDrop={moveEvent}
  onEventResize={resizeEvent}
  // The month view selects days; its quick create adds one all-day event over them.
  selectionMenu={(_range, { quickCreate }) => [{ label: "New all-day event", icon: "ti ti-sun", action: () => quickCreate() }]}
  renderQuickCreate={(range, { close }) => (
    <CalendarDemoQuickCreate
      onCreate={(title) => {
        setEvents((current) => [...current, { id: \`new-\${current.length}\`, title, start: range.start, end: range.end, allDay: true }]);
        close();
      }}
    />
  )}
>
  {/* A new date opens a new strip from the evening before it. */}
  <Show when={view() === "timeline" && date()} keyed>
    {(day) => (
      <Timeline
        items={timelineDemoItems(events())}
        {...timelineDemoRange(day)}
        timeZone="UTC"
        onActivate={(item) => setSelectedEventId(item.id)}
      />
    )}
  </Show>
</Calendar>`}
    >
      <Calendar
        date={date()}
        view={view()}
        views={["day", "week", "month", "year"]}
        customViews={[{ value: "timeline", label: "Timeline" }]}
        dateConfig={{ timeZone: "UTC", locale: "en" }}
        events={events()}
        selectedEventId={selectedEventId()}
        onDateChange={changeDate}
        onViewChange={setView}
        onEventActivate={(event) => setSelectedEventId(event.id)}
        onEventDrop={(event, next) =>
          setEvents((current) =>
            current.map((item) =>
              item.id === event.id
                ? {
                    ...item,
                    start: next.start.toISOString(),
                    end: next.end.toISOString(),
                    allDay: next.allDay,
                  }
                : item,
            ),
          )
        }
        onEventResize={(event, next) =>
          setEvents((current) =>
            current.map((item) =>
              item.id === event.id
                ? {
                    ...item,
                    start: next.start.toISOString(),
                    end: next.end.toISOString(),
                    allDay: next.allDay,
                  }
                : item,
            ),
          )
        }
        // The month view selects days; its quick create adds one all-day event over them.
        selectionMenu={(_range, { quickCreate }) => [{ label: "New all-day event", icon: "ti ti-sun", action: () => quickCreate() }]}
        renderQuickCreate={(range, { close }) => (
          <CalendarDemoQuickCreate
            onCreate={(title) => {
              setEvents((current) => [
                ...current,
                { id: `new-${current.length}`, title, start: range.start, end: range.end, allDay: true },
              ]);
              close();
            }}
          />
        )}
      >
        <Show when={view() === "timeline" && date()} keyed>
          {(day) => (
            <Timeline
              items={timelineDemoItems(events())}
              {...timelineDemoRange(day)}
              timeZone="UTC"
              onActivate={(item) => setSelectedEventId(item.id)}
            />
          )}
        </Show>
      </Calendar>
    </DemoCard>
  );
};

const demos: DemoSection = {
  utilities: () => (
    <DemoGrid columns="one">
      <ThemeDemo />
    </DemoGrid>
  ),
  "base-stylesheet": () => (
    <DemoGrid columns="one">
      <BaseStylesheetDemo />
    </DemoGrid>
  ),
  paper: () => (
    <DemoGrid columns="one">
      <PaperDemo />
    </DemoGrid>
  ),
  "empty-states": () => (
    <DemoGrid columns="one">
      <EmptyDemo />
    </DemoGrid>
  ),
  cards: () => (
    <DemoGrid columns="one">
      <CardsDemo />
      <ResourceCardDemo />
    </DemoGrid>
  ),
  details: () => (
    <DemoGrid columns="one">
      <DetailsDemo />
    </DemoGrid>
  ),
  progress: () => (
    <DemoGrid columns="one">
      <ProgressDemo />
    </DemoGrid>
  ),
  stats: () => (
    <DemoGrid columns="one">
      <StatsDemo />
    </DemoGrid>
  ),
  observability: () => (
    <DemoGrid columns="one">
      <OperationalDemo />
    </DemoGrid>
  ),
};

export default demos;
