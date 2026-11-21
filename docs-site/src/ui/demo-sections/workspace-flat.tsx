import { AppWorkspace, Breadcrumbs, Button, FloatingPill, IconButton, SegmentedControl, StatusRow, ViewTabs } from "@k2b/ui";
import { createSignal, For } from "solid-js";
import { DemoCard } from "../DemoCard";

type Mode = "facts" | "selection" | "state";

const tasks = ["Check the delivery note for hall 3", "Follow up the Hofmann offer", "Prepare the stocktaking south", "Renew the carrier contract"];

/** The flat shell: hairline columns with grips, the 56 px head with tab marks, the status row, and the quiet sidebar entry. */
export function FlatWorkspaceDemo() {
  const [mode, setMode] = createSignal<Mode>("facts");
  return (
    <DemoCard
      id="workspace-flat"
      chip={[
        { kind: "component", name: "AppWorkspace", from: "@k2b/ui" },
        { kind: "component", name: "StatusRow", from: "@k2b/ui" },
        { kind: "component", name: "ViewTabs", from: "@k2b/ui" },
      ]}
      description="Columns part with one hairline; a draggable boundary shows its grip. The head is 56 px and the current view is a mark on its line. The status row keeps its lead statement in place for figures, a selection, or a disturbance. The main action also waits as a quiet first row of the sidebar."
      code={`<AppWorkspace.Sidebar label="Spaces">
  <AppWorkspace.SidebarDesktop>
    <AppWorkspace.SidebarBody>
      <AppWorkspace.SidebarItem href="?new=task" icon="ti ti-plus">New task</AppWorkspace.SidebarItem>
      …
    </AppWorkspace.SidebarBody>
  </AppWorkspace.SidebarDesktop>
</AppWorkspace.Sidebar>
<AppWorkspace.Head views={<ViewTabs label="Views" current="list" items={views} />} primary={newTask} />
<AppWorkspace.Content>
  <AppWorkspace.Main>
    <StatusRow lead="4 tasks open" facts={facts} filters={filters} selection={selection} state={state} />
    {rows}
  </AppWorkspace.Main>
</AppWorkspace.Content>`}
    >
      <SegmentedControl
        ariaLabel="Status row state"
        value={mode}
        onValueChange={setMode}
        options={[
          { value: "facts", label: "Figures" },
          { value: "selection", label: "Selection" },
          { value: "state", label: "Disturbance" },
        ]}
      />
      <div style={{ height: "24rem", "margin-top": "0.75rem", container: "k2b-app-area / inline-size" }}>
        <AppWorkspace>
          <AppWorkspace.Sidebar label="Spaces">
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarBody>
                <AppWorkspace.SidebarItem href="?new=task" icon="ti ti-plus">
                  New task
                </AppWorkspace.SidebarItem>
                <AppWorkspace.SidebarItem href="?space=logistics" icon="ti ti-truck" active meta="12">
                  Logistics
                </AppWorkspace.SidebarItem>
                <AppWorkspace.SidebarItem href="?space=sales" icon="ti ti-briefcase" meta="5">
                  Sales
                </AppWorkspace.SidebarItem>
              </AppWorkspace.SidebarBody>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Head
            views={
              <ViewTabs
                label="Views"
                current="list"
                items={[
                  { id: "list", label: "List", href: "?view=list", count: 12 },
                  { id: "board", label: "Board", href: "?view=board" },
                  { id: "calendar", label: "Calendar", href: "?view=calendar" },
                ]}
              />
            }
            primary={{ label: "New task", icon: "ti ti-plus", href: "?new=task" }}
          />
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <StatusRow
                lead="4 tasks open"
                facts={[
                  { value: "2", label: "overdue" },
                  { value: "3", label: "this week" },
                ]}
                filters={
                  <Button size="sm" variant="ghost">
                    Tag
                  </Button>
                }
                selection={
                  mode() === "selection"
                    ? {
                        count: 2,
                        actions: (
                          <Button size="sm" variant="ghost">
                            Move
                          </Button>
                        ),
                      }
                    : undefined
                }
                state={mode() === "state" ? { label: "Sync paused", icon: "ti ti-refresh", next: "14:05" } : undefined}
              />
              <ul style={{ margin: 0, padding: "0 1.25rem", "list-style": "none" }}>
                <For each={tasks}>{(task) => <li style={{ padding: "0.625rem 0" }}>{task}</li>}</For>
              </ul>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </div>
    </DemoCard>
  );
}

/** A place with a path: the path replaces the tabs, the view switch is a segment at the end. */
export function PathHeadDemo() {
  const [view, setView] = createSignal("list");
  return (
    <DemoCard
      id="workspace-path-head"
      chip={[{ kind: "component", name: "Breadcrumbs", from: "@k2b/ui" }]}
      description="A head shows views or a path, never both. Narrow the host: the front levels wait behind “…” and the current folder stays."
      code={`<AppWorkspace.Head
  views={<Breadcrumbs label="Path" items={[{ label: "My files", href: "/files" }, …, { label: "Spring fair" }]} />}
  actions={<SegmentedControl label="View" value={view()} onValueChange={setView} options={…} />}
  primary={{ label: "Upload", icon: "ti ti-upload", href: "?upload" }}
/>`}
    >
      <div style={{ height: "10rem", container: "k2b-app-area / inline-size", resize: "horizontal", overflow: "auto", "min-width": "20rem" }}>
        <AppWorkspace>
          <AppWorkspace.Head
            views={
              <Breadcrumbs
                label="Path"
                items={[
                  { label: "My files", href: "#root" },
                  { label: "Projects", href: "#projects" },
                  { label: "2026", href: "#2026" },
                  { label: "Spring fair" },
                ]}
              />
            }
            actions={
              <SegmentedControl
                ariaLabel="View"
                value={view}
                onValueChange={setView}
                options={[
                  { value: "list", label: "List", icon: "ti ti-list" },
                  { value: "grid", label: "Grid", icon: "ti ti-layout-grid" },
                ]}
              />
            }
            primary={{ label: "Upload", icon: "ti ti-upload", href: "?upload" }}
          />
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <p style={{ padding: "0 1.25rem" }}>Stand plan.pdf</p>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </div>
    </DemoCard>
  );
}

/** A reading column: no head and no status row; views and actions float in the pill. */
export function ReadingColumnDemo() {
  return (
    <DemoCard
      id="workspace-reading"
      chip={[{ kind: "component", name: "FloatingPill", from: "@k2b/ui" }]}
      description="Running text gets the whole height at a 720 px measure; the pill floats at the column's top end and takes no room."
      code={`<AppWorkspace.Main width="reading">
  <FloatingPill label="Note views and actions">…</FloatingPill>
  <article>{note}</article>
</AppWorkspace.Main>`}
    >
      <div style={{ height: "16rem", container: "k2b-app-area / inline-size" }}>
        <AppWorkspace head={false}>
          <AppWorkspace.Content>
            <AppWorkspace.Main width="reading">
              <FloatingPill label="Note views and actions">
                <IconButton label="Edit" size="sm" variant="ghost">
                  <i class="ti ti-pencil" aria-hidden="true" />
                </IconButton>
                <IconButton label="Read" size="sm" variant="ghost">
                  <i class="ti ti-book" aria-hidden="true" />
                </IconButton>
                <FloatingPill.Separator />
                <IconButton label="Share" size="sm" variant="ghost">
                  <i class="ti ti-share" aria-hidden="true" />
                </IconButton>
              </FloatingPill>
              <article>
                <h2 style={{ "margin-top": "3.5rem" }}>Spring fair</h2>
                <p>Stand, people, and material for three days at the north site. Set-up starts the day before at 2 pm.</p>
                <p>Three people staff the stand each day: two from sales, one from purchasing.</p>
              </article>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </div>
    </DemoCard>
  );
}
