import { AppWorkspace, Button, ProgressBar, StatusBadge } from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { DemoCard } from "../DemoCard";

export function LiveWorkspaceDemo() {
  const [step, setStep] = createSignal(0);
  const [automatic, setAutomatic] = createSignal(false);
  const [done, setDone] = createSignal<string[]>([]);
  const [selected, setSelected] = createSignal("import");
  const entries = [
    { id: "import", title: "Import supplier inventory", icon: "ti ti-database", project: "Operations", detail: "Validate columns and reconcile stock levels." },
    { id: "review", title: "Review the quarterly report", icon: "ti ti-file-description", project: "Finance", detail: "The report needs a decision on the forecast assumptions." },
    { id: "website", title: "Refresh the project website", icon: "ti ti-layout", project: "Website", detail: "Check links, publish changes and review the result." },
  ];
  const advance = () => setStep(value => (value + 1) % 4);
  onMount(() => {
    const timer = setInterval(() => { if (automatic()) advance(); }, 2500);
    onCleanup(() => clearInterval(timer));
  });
  const label = () => ["Reading sources", "Needs your input", "Verifying results", "Completed"][step()]!;
  const tone = () => step() === 1 ? "warning" as const : step() === 3 ? "ok" as const : "running" as const;
  const row = (entry: typeof entries[number]) => <AppWorkspace.SidebarItem
    active={selected() === entry.id} onClick={() => setSelected(entry.id)}
    description={<><StatusBadge variant="dot" tone={entry.id === "import" ? tone() : entry.id === "review" ? "warning" : "neutral"}
      label={entry.id === "import" ? label() : entry.id === "review" ? "Needs your input" : "Ready"} />
      <Show when={entry.id === "import"}><span>{step()}/3</span><ProgressBar class="w-10 shrink-0" label="Import progress" size="xs" tone={step() === 3 ? "success" : "info"} value={step() / 3 * 100} /></Show></>}
    preview={{ label: `Details: ${entry.title}`, content: <div class="space-y-3">
      <strong>{entry.title}</strong><p>{entry.detail}</p>
      <dl><dt>Project</dt><dd>{entry.project}</dd><dt>Resources</dt><dd>2 documents · 1 application</dd></dl>
      <Show when={entry.id === "import"}><StatusBadge tone={tone()} label={label()} /><ProgressBar label="Import progress" size="sm" tone={step() === 3 ? "success" : "info"} value={step() / 3 * 100} /></Show>
      <Button size="sm" variant="secondary" onClick={() => setSelected(entry.id)}>Open details</Button>
    </div> }}>
    <AppWorkspace.SidebarItemIcon icon={entry.icon} />
    <AppWorkspace.SidebarItemLabel>{entry.title}</AppWorkspace.SidebarItemLabel>
    <AppWorkspace.SidebarItemAction icon={done().includes(entry.id) ? "ti ti-arrow-back-up" : "ti ti-check"}
      label={done().includes(entry.id) ? `Restore ${entry.title}` : `Mark ${entry.title} done`} visibility="hover"
      onSelect={() => setDone(ids => ids.includes(entry.id) ? ids.filter(id => id !== entry.id) : [...ids, entry.id])} />
  </AppWorkspace.SidebarItem>;
  const navigation = () => <>
    <AppWorkspace.SidebarBody><AppWorkspace.SidebarSection title="Active work" count={entries.length - done().length}>
      <For each={entries.filter(entry => !done().includes(entry.id))}>{row}</For>
    </AppWorkspace.SidebarSection></AppWorkspace.SidebarBody>
    <AppWorkspace.SidebarFooter><AppWorkspace.SidebarSection title="Done" count={done().length} collapsible defaultOpen={false}>
      <For each={entries.filter(entry => done().includes(entry.id))}>{row}</For>
    </AppWorkspace.SidebarSection></AppWorkspace.SidebarFooter>
  </>;
  return <DemoCard id="workspace-live" chip={{ kind: "component", name: "Live workspace navigation", from: "@k2b/ui" }}
    description="Two-line navigation with live state, interactive previews and a Done section. Updates preserve an open preview. Hover a row or use its details button; Escape dismisses it."
    code={`<AppWorkspace.SidebarItem\n  description={<StatusBadge label={status()} tone="running" variant="dot" />}\n  preview={{ label: "Item details", content: <Details /> }}\n>\n  <AppWorkspace.SidebarItemLabel>{title()}</AppWorkspace.SidebarItemLabel>\n</AppWorkspace.SidebarItem>\n<AppWorkspace.SidebarSection title="Done" count={done().length} collapsible defaultOpen={false}>\n  {/* Completed items remain application-owned. */}\n</AppWorkspace.SidebarSection>`}>
    <div class="flex flex-wrap gap-2 mb-3">
      <Button size="sm" onClick={advance}>Next live update</Button>
      <Button size="sm" variant="secondary" onClick={() => setAutomatic(value => !value)}>{automatic() ? "Pause live updates" : "Start live updates"}</Button>
      <Button size="sm" variant="ghost" onClick={() => { setDone([]); setStep(0); setAutomatic(false); }}>Reset demo</Button>
    </div>
    <div style={{ height: "420px", overflow: "hidden", border: "1px solid var(--k2b-border)", "border-radius": "var(--k2b-radius-control)" }}>
      <AppWorkspace layoutState={() => ({ version: 2, sidebarWidth: 300 })}>
        <AppWorkspace.Sidebar>
          <AppWorkspace.SidebarMobileTrigger label="Work overview" />
          <AppWorkspace.SidebarDesktop>{navigation()}</AppWorkspace.SidebarDesktop>
          <AppWorkspace.SidebarMobile>{navigation()}</AppWorkspace.SidebarMobile>
        </AppWorkspace.Sidebar>
        <AppWorkspace.Content><AppWorkspace.Main><div class="p-4 space-y-3">
          <strong>{entries.find(entry => entry.id === selected())?.title}</strong>
          <p>Use the checkmark to move an item to Done, then expand Done to restore it.</p>
          <p>Start live updates and open a preview to watch its content update in place.</p>
          <p>The library only renders state. Applications own subscriptions, progress and completion.</p>
        </div></AppWorkspace.Main></AppWorkspace.Content>
      </AppWorkspace>
    </div>
  </DemoCard>;
}
