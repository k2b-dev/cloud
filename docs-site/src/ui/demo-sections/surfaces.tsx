import {
  Avatar,
  Button,
  Calendar,
  type CalendarEvent,
  DataPanel,
  DescriptionList,
  IconButton,
  LinkCard,
  NotFoundState,
  NoticeCard,
  PanelHeader,
  Paper,
  Placeholder,
  ProgressBar,
  RangePicker,
  StatCell,
  StatGrid,
  StatusBadge,
} from "@k2b/ui";
import { createSignal, type JSX } from "solid-js";
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

const EmptyDemo = () => (
  <DemoCard
    id="empty-states"
    chip={[
      { kind: "component", name: "Placeholder", from: "@k2b/ui" },
      { kind: "component", name: "NotFoundState", from: "@k2b/ui" },
    ]}
    description="The examples intentionally combine compact, panel, centered, and left-aligned placeholders; the code below names each non-default layout choice. NotFoundState handles a route-level dead end."
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
<NotFoundState code="404" title="Project not found" description="It may have been moved." action={{ label: "All projects", href: "/projects" }} />`}
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

const DetailsDemo = () => (
  <DemoCard
    id="details"
    chip={{ kind: "component", name: "DescriptionList", from: "@k2b/ui" }}
    description="Semantic key-value content in a responsive grid or compact inspector rows. Both layouts retain real dl/dt/dd elements and support optional actions."
    code={`{/* Scan-friendly facts */}
<DescriptionList columns={2} items={facts} />

{/* Compact metadata in a detail panel */}
<DescriptionList
  layout="rows"
  size="sm"
  actionVisibility="progressive"
  items={metadata}
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
    </div>
  </DemoCard>
);

const ProgressDemo = () => (
  <DemoCard
    id="progress"
    chip={{ kind: "component", name: "ProgressBar", from: "@k2b/ui" }}
    description="Determinate progress in semantic tones and three compact sizes."
    code={`<ProgressBar value={72.4} label="Upload progress" tone="success" showValue />
<ProgressBar value={38} label="Indexing" size="sm" showValue />
<ProgressBar value={16} label="Storage limit" tone="danger" size="xs" showValue />`}
  >
    <div class="ui-demo-form-grid">
      <ProgressBar value={72.4} label="Upload progress" tone="success" showValue />
      <ProgressBar value={38} label="Indexing" showValue size="sm" />
      <ProgressBar value={16} label="Storage limit" tone="danger" showValue size="xs" />
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
    { id: "checklist", title: "Launch checklist", start: at(12), end: at(13), allDay: true, color: "amber" },
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

export const CalendarDemo = () => {
  const initialDate = calendarDemoDate();
  const [date, setDate] = createSignal(initialDate);
  const [view, setView] = createSignal<"day" | "week" | "month" | "year">("month");
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
      description="A controlled calendar with overlapping, crowded, all-day, and multi-day events generated for every visible month."
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
  dateConfig={{ timeZone: "UTC", locale: "en" }}
  events={events()}
  selectedEventId={selectedEventId()}
  onDateChange={changeDate}
  onViewChange={setView}
  onEventActivate={(event) => setSelectedEventId(event.id)}
  onEventDrop={moveEvent}
  onEventResize={resizeEvent}
/>`}
    >
      <Calendar
        date={date()}
        view={view()}
        views={["day", "week", "month", "year"]}
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
      />
    </DemoCard>
  );
};

const demos: DemoSection = {
  utilities: () => (
    <DemoGrid columns="one">
      <ThemeDemo />
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
