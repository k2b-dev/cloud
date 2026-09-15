import {
  Button,
  Calendar,
  Chat,
  CodeDisplay,
  DataTable,
  DocNote,
  Dropdown,
  FileTree,
  LogEntriesTable,
  MarkdownView,
  NoticeCard,
  Pagination,
  PanelDialog,
  Placeholder,
  ProgressBar,
  SegmentedControl,
  Select,
  StatCell,
  StatGrid,
  StatusBadge,
  StructuredDataPreview,
  TextInput,
  Tooltip,
  toast,
  Widget,
  WidgetPills,
  WidgetStatus,
} from "@k2b/ui";
import { createSignal } from "solid-js";

export default function StandaloneUi() {
  const [theme, setTheme] = createSignal<"light" | "dark">("light");
  const [name, setName] = createSignal("Ada");
  const [role, setRole] = createSignal("member");
  const [date, setDate] = createSignal(new Date("2026-07-28T12:00:00Z"));
  const [density, setDensity] = createSignal<"normal" | "compact">("normal");

  return (
    <div class="k2b-ui" data-theme={theme()}>
      <main
        style={{
          "min-height": "100vh",
          padding: "24px",
          color: "var(--k2b-text)",
          background: "var(--k2b-app-background)",
        }}
      >
        <div style={{ display: "grid", gap: "20px", margin: "0 auto", "max-width": "1120px" }}>
          <header style={{ display: "flex", "align-items": "center", "justify-content": "space-between", gap: "16px" }}>
            <div>
              <p style={{ margin: "0", color: "var(--k2b-text-muted)", "font-size": "12px" }}>No Cloud CSS or runtime</p>
              <h1 style={{ margin: "3px 0 0", "font-size": "24px" }}>@k2b/ui standalone certification</h1>
            </div>
            <Button variant="secondary" data-testid="theme-toggle" onClick={() => setTheme(theme() === "light" ? "dark" : "light")}>
              Toggle theme
            </Button>
          </header>

          <section style={{ display: "grid", gap: "16px", "grid-template-columns": "repeat(auto-fit,minmax(220px,1fr))" }}>
            <TextInput label="Display name" value={name} onValueChange={setName} clearable description="Hydrated controlled input" />
            <Select
              label="Role"
              value={role}
              onValueChange={(value) => value && setRole(value)}
              options={[
                { value: "member", label: "Member" },
                { value: "admin", label: "Administrator" },
              ]}
            />
          </section>

          <StatGrid title="Runtime" columns={3}>
            <StatCell label="Requests" value="12.4k" sub="last 24 hours" />
            <StatCell label="Success" value="99.8%" sub="within SLO" />
            <StatCell label="Latency" value="84ms" sub="p95" />
          </StatGrid>

          <section style={{ display: "flex", "align-items": "center", "flex-wrap": "wrap", gap: "12px" }}>
            <Tooltip.Anchor content="Rendered by the package portal">
              <Button variant="secondary">Focus or hover</Button>
            </Tooltip.Anchor>
            <Button data-testid="toast-trigger" onClick={() => toast.success("Standalone toast")}>
              Show toast
            </Button>
            <div style={{ flex: "1 1 240px" }}>
              <ProgressBar label="Certification" value={100} showValue />
            </div>
          </section>

          <section aria-label="Responsive actions" style={{ display: "grid", gap: "16px", "max-width": "420px", width: "100%" }}>
            <div style={{ display: "flex", gap: "12px" }}>
              <div style={{ flex: "1", "min-width": "0" }}>
                <TextInput label="Find clients" placeholder="Search" value="" readOnly />
              </div>
              <Button data-testid="single-line-action">New client</Button>
            </div>
            <Button wrap data-testid="wrapping-action">
              Create a new monitoring space with a description that deliberately wraps on small screens
            </Button>
            <PanelDialog>
              <PanelDialog.Footer>
                <span>Review the client settings before creating a new client.</span>
                <div style={{ display: "flex", gap: "8px", "margin-left": "auto" }}>
                  <Button variant="secondary">Cancel</Button>
                  <Button disabled>Create client</Button>
                </div>
              </PanelDialog.Footer>
            </PanelDialog>
          </section>

          <Calendar
            date={date()}
            events={[
              {
                id: "review",
                title: "Release review",
                start: "2026-07-28T09:00:00Z",
                end: "2026-07-28T10:00:00Z",
                color: "blue",
              },
            ]}
            view="month"
            views={["month", "week", "day"]}
            timeZone="UTC"
            onDateChange={(next) => setDate(next)}
          />

          <Placeholder
            title="Portable empty state"
            description="The component is styled only by @k2b/ui."
            icon="ti ti-package"
            surface="paper"
          />

          {/*
            Every catalog group is represented below. The fixture is the only
            gate that renders the package with no Tailwind and no Cloud CSS in
            the page, so a group that is missing here can ship structurally
            unstyled without anything failing — which is exactly what happened
            to the content components.
          */}

          <section style={{ display: "flex", "align-items": "center", "flex-wrap": "wrap", gap: "12px" }}>
            <SegmentedControl
              ariaLabel="Density"
              value={density()}
              onValueChange={setDensity}
              options={[
                { value: "normal", label: "Comfortable" },
                { value: "compact", label: "Compact" },
              ]}
            />
            <Dropdown.Root
              items={[
                { label: "Rename", icon: "ti ti-pencil", action: () => {} },
                { sectionLabel: "Links", items: [{ label: "Documentation", href: "/docs" }] },
              ]}
              width="12rem"
            >
              <Dropdown.Trigger label="Record actions">Actions</Dropdown.Trigger>
            </Dropdown.Root>
            <StatusBadge tone="ok" label="Healthy" />
            <StatusBadge tone="warning" label="Degraded" variant="dot" />
          </section>

          <NoticeCard tone="warning" title="One replica is behind" detail="Replication lag is 42 seconds." />

          <DataTable
            rows={[
              { id: "eu", region: "eu-central", requests: 8241, status: "ok" },
              { id: "us", region: "us-east", requests: 4109, status: "degraded" },
            ]}
            columns={[
              { id: "region", header: "Region", value: "region" },
              { id: "requests", header: "Requests", subtitle: "last hour", value: "requests" },
              { id: "status", header: "Status", value: "status" },
            ]}
            density={density()}
          />

          <Pagination currentPage={2} totalPages={7} baseUrl="/ui?page=" />

          <CodeDisplay title="server.ts" language="ts" code={"export const port = 3000;\nconsole.log(port);\n"} />

          <StructuredDataPreview title="Request" data={{ method: "GET", path: "/health", ok: true }} />

          <MarkdownView trustedHtml="<h2>Release notes</h2><p>Standalone rendering with no Cloud CSS.</p>" />

          <DocNote title="Scoped styles" variant="tip">
            Everything on this page is styled by <code>@k2b/ui/styles.css</code> alone.
          </DocNote>

          <FileTree
            entries={[
              { path: "/input/report.csv", size: 2048 },
              { path: "/input/notes.md", size: 512 },
              { path: "/output/summary.json", size: 128 },
            ]}
            selectedPath="/input/report.csv"
          />

          <LogEntriesTable
            entries={[
              {
                id: 1,
                level: "warn",
                source: "gateway",
                message: "Upstream retry",
                metadata: { attempt: 2 },
                createdAt: "2026-07-28T09:15:00.000Z",
              },
              {
                id: 2,
                level: "error",
                source: "worker",
                message: "Job failed",
                metadata: null,
                createdAt: "2026-07-28T09:16:00.000Z",
              },
            ]}
          />

          {/* biome-ignore lint/a11y/useValidAriaRole: Chat.Message maps chat roles to accessible markup. */}
          <Chat.Message role="assistant" timeLabel="09:20">
            Rendered by the generic chat family.
          </Chat.Message>

          <Widget title="Platform health" icon="ti ti-heartbeat">
            <WidgetStatus tone="success" title="Operational" />
            <WidgetPills pills={[{ label: "Checks", value: 48, tone: "emerald" }]} />
          </Widget>
        </div>
      </main>
    </div>
  );
}
