import {
  AppWorkspace,
  Button,
  DescriptionList,
  ProgressBar,
  StatusBadge,
  createNavigation,
  Navigation,
  dialogCore,
  BottomSheet,
  bottomSheetOptions,
} from "@k2b/ui";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { DemoCard } from "../DemoCard";

export function LiveWorkspaceDemo() {
  const [step, setStep] = createSignal(0);
  const [automatic, setAutomatic] = createSignal(false);
  const [done, setDone] = createSignal<string[]>([]);
  const [selected, setSelected] = createSignal("import");
  const entries = [
    {
      id: "import",
      title: "Import supplier inventory",
      icon: "ti ti-database",
      project: "Operations",
      detail: "Validate columns and reconcile stock levels.",
    },
    {
      id: "review",
      title: "Review the quarterly report",
      icon: "ti ti-file-description",
      project: "Finance",
      detail: "The report needs a decision on the forecast assumptions.",
    },
    {
      id: "website",
      title: "Refresh the project website",
      icon: "ti ti-layout",
      project: "Website",
      detail: "Check links, publish changes and review the result.",
    },
  ];
  const advance = () => setStep((value) => (value + 1) % 4);
  onMount(() => {
    const timer = setInterval(() => {
      if (automatic()) advance();
    }, 2500);
    onCleanup(() => clearInterval(timer));
  });
  const label = () => ["Reading sources", "Needs your input", "Verifying results", "Completed"][step()]!;
  const tone = () => (step() === 1 ? ("warning" as const) : step() === 3 ? ("ok" as const) : ("running" as const));
  const row = (entry: (typeof entries)[number]) => (
    <AppWorkspace.SidebarItem
      variant={done().includes(entry.id) ? "row" : "card"}
      context={
        !done().includes(entry.id) ? (
          <span>
            <i class={entry.icon} aria-hidden="true" /> {entry.project}
          </span>
        ) : undefined
      }
      contextMeta={!done().includes(entry.id) ? "12m" : undefined}
      active={selected() === entry.id}
      onClick={() => setSelected(entry.id)}
      description={
        !done().includes(entry.id) && entry.id !== "website" ? (
          <>
            <StatusBadge
              variant="dot"
              tone={entry.id === "import" ? tone() : entry.id === "review" ? "warning" : "neutral"}
              label={entry.id === "import" ? label() : entry.id === "review" ? "Needs your input" : "Ready"}
            />
            <Show when={entry.id === "import"}>
              <span>{step()}/3</span>
              <ProgressBar
                class="w-10 shrink-0"
                label="Import progress"
                size="xs"
                tone={step() === 3 ? "success" : "info"}
                value={(step() / 3) * 100}
              />
            </Show>
          </>
        ) : undefined
      }
      preview={{
        label: `Details: ${entry.title}`,
        content: (
          <div class="flex flex-col items-start gap-4">
            <div class="flex flex-col gap-1">
              <strong>{entry.title}</strong>
              <p class="text-dimmed">{entry.detail}</p>
            </div>
            <DescriptionList
              class="w-full"
              layout="compact"
              size="sm"
              items={[
                {
                  term: (
                    <span class="inline-flex items-center gap-1.5">
                      <i class="ti ti-folder" aria-hidden="true" />
                      Project
                    </span>
                  ),
                  description: entry.project,
                },
                {
                  term: (
                    <span class="inline-flex items-center gap-1.5">
                      <i class="ti ti-paperclip" aria-hidden="true" />
                      Resources
                    </span>
                  ),
                  description: "2 documents · 1 app",
                },
              ]}
            />
            <Show when={entry.id === "import"}>
              <div class="flex w-full flex-col items-start gap-2">
                <StatusBadge tone={tone()} label={label()} />
                <ProgressBar
                  class="w-full"
                  label="Import progress"
                  size="sm"
                  tone={step() === 3 ? "success" : "info"}
                  value={(step() / 3) * 100}
                />
              </div>
            </Show>
            <Button size="sm" variant="secondary" onClick={() => setSelected(entry.id)}>
              Open details
            </Button>
          </div>
        ),
      }}
    >
      <AppWorkspace.SidebarItemLabel marquee={false}>{entry.title}</AppWorkspace.SidebarItemLabel>
      <AppWorkspace.SidebarItemAction
        icon={done().includes(entry.id) ? "ti ti-arrow-back-up" : "ti ti-check"}
        label={done().includes(entry.id) ? `Restore ${entry.title}` : `Mark ${entry.title} done`}
        visibility="hover"
        onSelect={() => setDone((ids) => (ids.includes(entry.id) ? ids.filter((id) => id !== entry.id) : [...ids, entry.id]))}
      />
    </AppWorkspace.SidebarItem>
  );
  const navigation = () => (
    <>
      <AppWorkspace.SidebarBody>
        <AppWorkspace.SidebarSection title="Active work" count={entries.length - done().length}>
          <For each={entries.filter((entry) => !done().includes(entry.id))}>{row}</For>
        </AppWorkspace.SidebarSection>
      </AppWorkspace.SidebarBody>
      <AppWorkspace.SidebarFooter>
        <AppWorkspace.SidebarSection title="Done" count={done().length} collapsible defaultOpen={false}>
          <For each={entries.filter((entry) => done().includes(entry.id))}>{row}</For>
        </AppWorkspace.SidebarSection>
      </AppWorkspace.SidebarFooter>
    </>
  );
  const menu = createNavigation({
    items: () =>
      entries.map((entry) => ({
        id: entry.id,
        label: entry.title,
        action: entry.id,
        icon: entry.icon,
        active: selected() === entry.id,
        description: entry.id === "import" ? label() : entry.detail,
        actions: [
          {
            id: `done:${entry.id}`,
            action: `done:${entry.id}`,
            label: done().includes(entry.id) ? "Restore" : "Mark done",
            icon: "ti ti-check",
          },
        ],
      })),
    onAction: (id) => {
      if (id.startsWith("done:")) {
        const item = id.slice(5);
        setDone((ids) => (ids.includes(item) ? ids.filter((value) => value !== item) : [...ids, item]));
      } else setSelected(id);
    },
  });
  const openMenu = () =>
    dialogCore.open<void>(
      (close, context) => (
        <BottomSheet onDismiss={context.requestDismiss}>
          <BottomSheet.Header title="Work overview" close={() => void context.requestDismiss()} />
          <BottomSheet.Body>
            <Navigation navigation={menu} label="Work overview" beforeSelect={() => close()} />
          </BottomSheet.Body>
        </BottomSheet>
      ),
      bottomSheetOptions,
    );
  return (
    <DemoCard
      id="workspace-live"
      chip={{ kind: "component", name: "Live workspace navigation", from: "@k2b/ui" }}
      description="Context cards for active work and simple rows for completed work, with live state, interactive previews and a Done section. Updates preserve an open preview. Hover a row or use its details button; Escape dismisses it."
      code={`<AppWorkspace.SidebarItem\n  variant="card"\n  context="Operations"\n  contextMeta="12m"\n  description={<StatusBadge label={status()} tone="running" variant="dot" />}\n  preview={{ label: "Item details", content: <Details /> }}\n>\n  <AppWorkspace.SidebarItemLabel>{title()}</AppWorkspace.SidebarItemLabel>\n</AppWorkspace.SidebarItem>\n<AppWorkspace.SidebarSection title="Done" count={done().length} collapsible defaultOpen={false}>\n  {/* Completed items remain application-owned. */}\n</AppWorkspace.SidebarSection>`}
    >
      <div class="flex flex-wrap gap-2 mb-3">
        <Button size="sm" class="lg:hidden" onClick={() => void openMenu()}>
          Work overview
        </Button>
        <Button size="sm" onClick={advance}>
          Next live update
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setAutomatic((value) => !value)}>
          {automatic() ? "Pause live updates" : "Start live updates"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDone([]);
            setStep(0);
            setAutomatic(false);
          }}
        >
          Reset demo
        </Button>
      </div>
      <div
        style={{ height: "420px", overflow: "hidden", border: "1px solid var(--k2b-border)", "border-radius": "var(--k2b-radius-control)" }}
      >
        <AppWorkspace layoutState={() => ({ version: 2, sidebarWidth: 300 })}>
          <AppWorkspace.Sidebar>
            <AppWorkspace.SidebarDesktop>{navigation()}</AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <div class="p-4 space-y-3">
                <strong>{entries.find((entry) => entry.id === selected())?.title}</strong>
                <p>Use the checkmark to move an item to Done, then expand Done to restore it.</p>
                <p>Start live updates and open a preview to watch its content update in place.</p>
                <p>The library only renders state. Applications own subscriptions, progress and completion.</p>
              </div>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </div>
    </DemoCard>
  );
}
