import {
  announce,
  Button,
  ButtonLink,
  createHoverPreview,
  dialogCore,
  HoverPreview,
  InlineGuidance,
  NoticeCard,
  prompts,
  StatusBadge,
  TextInput,
  Tooltip,
  toast,
} from "@k2b/ui";
import { createSignal, For, onCleanup } from "solid-js";
import { DemoCard } from "../DemoCard";
import { InstallGuideDemo } from "./mobile-navigation";
import { DemoGrid, type DemoSection } from "./types";

const BlocksDemo = () => (
  <DemoCard
    id="blocks"
    chip={[
      { kind: "component", name: "NoticeCard", from: "@k2b/ui" },
      { kind: "component", name: "NoticeCard.Grid", from: "@k2b/ui" },
      { kind: "component", name: "InlineGuidance", from: "@k2b/ui" },
    ]}
    description="Persistent findings and quiet state-specific guidance with a direct next step."
    code={`const notices = [
  { tone: "neutral", title: "Release note", detail: "Version 2.4 is available." },
  { tone: "info", title: "Import ready", detail: "12 rows validated." },
  { tone: "success", title: "Import complete", detail: "12 rows created." },
  { tone: "warning", title: "Review needed", detail: "2 rows have no owner." },
  { tone: "danger", title: "Source unavailable", detail: "Retrying in the background." },
] as const;

<NoticeCard.Grid items={notices}>
  {(notice) => <NoticeCard {...notice} />}
</NoticeCard.Grid>

<InlineGuidance loading>Loading templates…</InlineGuidance>
<InlineGuidance tone="info" icon="ti ti-info-circle">Your content stays unchanged.</InlineGuidance>
<InlineGuidance tone="success" icon="ti ti-circle-check">Template linked.</InlineGuidance>
<InlineGuidance tone="danger" icon="ti ti-alert-circle">Templates could not be loaded.</InlineGuidance>

<InlineGuidance tone="danger">
  No delivery provider is connected.{" "}
  <ButtonLink variant="text" size="xs" href="/settings/providers">
    Open settings
  </ButtonLink>
</InlineGuidance>`}
  >
    <div class="flex flex-col gap-4">
      <NoticeCard.Grid
        items={[
          { tone: "neutral" as const, title: "Release note", detail: "Version 2.4 is available." },
          { tone: "info" as const, title: "Import ready", detail: "12 rows validated." },
          { tone: "success" as const, title: "Import complete", detail: "12 rows created." },
          { tone: "warning" as const, title: "Review needed", detail: "2 rows have no owner." },
          { tone: "danger" as const, title: "Source unavailable", detail: "Retrying in the background." },
        ]}
      >
        {(notice) => <NoticeCard {...notice} />}
      </NoticeCard.Grid>
      <div class="space-y-3">
        <h3 class="text-sm font-medium">Inline guidance</h3>
        <InlineGuidance loading>Loading templates…</InlineGuidance>
        <InlineGuidance tone="info" icon="ti ti-info-circle">
          Your content stays unchanged.
        </InlineGuidance>
        <InlineGuidance tone="success" icon="ti ti-circle-check">
          Template linked.
        </InlineGuidance>
        <InlineGuidance tone="danger" icon="ti ti-alert-circle">
          Templates could not be loaded.
        </InlineGuidance>
      </div>
      <InlineGuidance tone="danger">
        No delivery provider is connected.{" "}
        <ButtonLink variant="text" size="xs" href="#blocks">
          Open settings
        </ButtonLink>
      </InlineGuidance>
    </div>
  </DemoCard>
);

const BadgesDemo = () => (
  <DemoCard
    id="badges"
    chip={{ kind: "component", name: "StatusBadge", from: "@k2b/ui" }}
    description="One semantic status vocabulary with chip, dot, and text variants."
    code={`<StatusBadge label="Healthy" tone="ok" />
<StatusBadge label="Degraded" tone="degraded" />
<StatusBadge label="Running" tone="running" variant="dot" />
<StatusBadge label="Offline" tone="error" variant="text" />`}
  >
    <div class="ui-demo-row">
      <StatusBadge label="Healthy" tone="ok" />
      <StatusBadge label="Degraded" tone="degraded" />
      <StatusBadge label="Running" tone="running" variant="dot" />
      <StatusBadge label="Offline" tone="error" variant="text" />
    </div>
  </DemoCard>
);

const ToastDemo = () => {
  let progressToast: ReturnType<typeof toast> | undefined;
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => clearInterval(progressTimer));

  const startProgress = () => {
    clearInterval(progressTimer);
    progressToast?.dismiss();
    let done = 0;
    progressToast = toast("0 of 12 files", {
      title: "Exporting archive",
      progress: 0,
      action: { label: "Cancel", onClick: () => stopProgress("Export cancelled") },
    });
    progressTimer = setInterval(() => {
      done += 1;
      if (done < 12) {
        progressToast?.update(`${done} of 12 files`, { progress: done / 12 });
        return;
      }
      clearInterval(progressTimer);
      progressToast?.update("Archive ready", {
        variant: "success",
        title: undefined,
        progress: null,
        action: { label: "View prompts", href: "./prompts" },
      });
    }, 400);
  };

  const stopProgress = (message: string) => {
    clearInterval(progressTimer);
    progressToast?.update(message, { title: undefined, progress: null, action: null });
  };

  return (
    <DemoCard
      id="toast"
      chip={{ kind: "component", name: "toast", from: "@k2b/ui" }}
      description="One calm line per toast: tone glyph, message, an optional text action, and close. Titles only when passed, longer times for errors and actions, and progress in place."
      code={`toast.success("Contact created");
toast.success("Message archived", {
  action: { label: "Undo", onClick: restore },
});
toast.error("Could not save the draft. The server is not reachable.");
toast("Reload the page to use it.", {
  title: "New version available",
  action: { label: "Reload", onClick: () => location.reload() },
  duration: 0,
});

const exportToast = toast("0 of 12 files", {
  title: "Exporting archive",
  progress: 0,
  action: { label: "Cancel", onClick: cancel },
});
exportToast.update("6 of 12 files", { progress: 0.5 });
exportToast.update("Archive ready", {
  variant: "success",
  title: undefined,
  progress: null,
  action: { label: "View prompts", href: "./prompts" },
});`}
    >
      <div class="ui-demo-row">
        <Button variant="secondary" onClick={() => toast.success("Contact created")}>
          Success
        </Button>
        <Button
          variant="secondary"
          onClick={() => toast.success("Message archived", { action: { label: "Undo", onClick: () => toast("Message restored") } })}
        >
          With action
        </Button>
        <Button variant="secondary" onClick={() => toast.error("Could not save the draft. The server is not reachable.")}>
          Error
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            toast("Reload the page to use it.", {
              title: "New version available",
              action: { label: "Reload", onClick: () => window.location.reload() },
              duration: 0,
            })
          }
        >
          Title, sticky
        </Button>
        <Button variant="secondary" onClick={startProgress}>
          Progress
        </Button>
        <Button variant="secondary" onClick={() => toast.dismissAll()}>
          Dismiss all
        </Button>
      </div>
    </DemoCard>
  );
};

const AnnounceDemo = () => {
  const [last, setLast] = createSignal<string | null>(null);
  const say = (message: string, politeness: "polite" | "assertive") => {
    announce(message, { politeness });
    setLast(`${politeness}: ${message}`);
  };

  return (
    <DemoCard
      id="announce"
      chip={{ kind: "component", name: "announce", from: "@k2b/ui" }}
      description="Tells screen readers about an outcome the screen shows but the focused control does not say. Nothing appears and nothing moves; the line below only mirrors what a screen reader hears."
      code={`// A comment posted from a composer that then closes.
announce("Comment posted");
// Rare: an outcome that must interrupt and has no visible counterpart.
announce("Connection lost", { politeness: "assertive" });`}
    >
      <div class="ui-demo-row">
        <Button variant="secondary" onClick={() => say("Comment posted", "polite")}>
          Polite
        </Button>
        <Button variant="secondary" onClick={() => say("Connection lost", "assertive")}>
          Assertive
        </Button>
      </div>
      <p class="truncate text-sm text-dimmed">{last() ?? "Nothing announced yet"}</p>
    </DemoCard>
  );
};

const TooltipDemo = () => (
  <DemoCard
    id="tooltip"
    chip={{ kind: "component", name: "Tooltip", from: "@k2b/ui" }}
    description="Buttons own their tooltip directly. Tooltip.Anchor is the explicit target for non-button content. Long content wraps, remeasures, and stays clamped inside the viewport."
    code={`<Button variant="secondary" tooltip="Copy the public URL" tooltipPlacement="right" tooltipDelay={0}>
  Share
</Button>

<Tooltip.Anchor
  placement="bottom"
  content="A longer explanation wraps before its final viewport position is calculated."
>
  <span tabindex="0">Non-button target</span>
</Tooltip.Anchor>`}
  >
    <div class="ui-tooltip-demo">
      <Button variant="secondary" tooltip="Copy the public URL" tooltipPlacement="right" tooltipDelay={0}>
        Focus or hover
      </Button>
      <Tooltip.Anchor placement="bottom" content="A longer explanation wraps before its final viewport position is calculated.">
        <span class="ui-demo-context-target" tabindex="0">
          Long edge hint
        </span>
      </Tooltip.Anchor>
    </div>
  </DemoCard>
);

const demoMessages = [
  {
    id: "invoice",
    sender: "Paul Probe",
    subject: "Question about invoice 2026-0418",
    time: "09:42",
    status: { tone: "warning" as const, label: "Needs action" },
    text: "Good morning, the invoice from 12 September lists the hall rent twice. Could you send a corrected copy? We will transfer the amount right away.",
  },
  {
    id: "room",
    sender: "Lea Lorem",
    subject: "Room booking for 14 October",
    time: "Yesterday",
    status: { tone: "ok" as const, label: "Done" },
    text: "Thanks for confirming. Do we need our own adapter for the projector, or is one available in the room?",
  },
  {
    id: "minutes",
    sender: "Tim Test",
    subject: "Minutes of the September board meeting",
    time: "Mon",
    status: null,
    text: "Here are the minutes for review. Please send corrections by Friday so we can publish them with the newsletter.",
  },
];

const HoverPreviewDemo = () => {
  let list!: HTMLDivElement;
  let frame!: HTMLDivElement;
  const [opened, setOpened] = createSignal("invoice");
  const preview = createHoverPreview<string>({
    openDelay: 200,
    placement: { beside: () => list, within: () => frame },
    disabled: (id) => id === opened(),
  });
  const message = (id: string) => demoMessages.find((item) => item.id === id) ?? demoMessages[0]!;
  return (
    <DemoCard
      id="hover-preview"
      chip={[
        { kind: "component", name: "createHoverPreview", from: "@k2b/ui" },
        { kind: "component", name: "HoverPreview", from: "@k2b/ui" },
      ]}
      description="Rest the mouse on a row, or press Space on a focused row. One fixed-size card opens beside the list, swaps between rows, and never covers the list; without room beside it, it does not open."
      code={`const preview = createHoverPreview<string>({
  openDelay: 200,
  placement: { beside: () => list, within: () => frame },
  disabled: (id) => id === openedId(),
});

<div ref={list} role="list">
  <For each={messages}>
    {(item) => (
      <div ref={preview.anchor(item.id)} role="listitem">
        <a href={item.href} aria-controls={preview.id} aria-expanded={preview.active() === item.id}>
          {item.subject}
        </a>
      </div>
    )}
  </For>
</div>
<HoverPreview preview={preview} label="Quick look" size="fixed">
  {(id) => <MessageCard id={id} />}
</HoverPreview>`}
    >
      <div ref={frame} class="ui-hover-preview-demo">
        <div ref={list} class="ui-hover-preview-demo__list" role="list" aria-label="Inbox">
          <For each={demoMessages}>
            {(item) => (
              <div
                ref={preview.anchor(item.id)}
                role="listitem"
                class="ui-hover-preview-demo__row"
                data-current={item.id === opened() ? "true" : undefined}
                data-peek={preview.active() === item.id ? "true" : undefined}
              >
                <a
                  href={`#${item.id}`}
                  aria-current={item.id === opened() ? "true" : undefined}
                  aria-controls={preview.id}
                  aria-expanded={preview.active() === item.id}
                  onClick={(event) => {
                    event.preventDefault();
                    setOpened(item.id);
                  }}
                >
                  <strong>{item.sender}</strong>
                  <span>{item.subject}</span>
                </a>
              </div>
            )}
          </For>
        </div>
        <div class="ui-hover-preview-demo__reader">
          <strong>{message(opened()).subject}</strong>
          <p>{message(opened()).text}</p>
        </div>
      </div>
      <HoverPreview preview={preview} label="Quick look" size="fixed">
        {(id) => (
          <div class="ui-hover-preview-demo__card">
            <div class="ui-hover-preview-demo__facts">
              <StatusBadge tone="neutral" variant="text" icon={null} label={message(id).time} />
              {message(id).status && <StatusBadge tone={message(id).status!.tone} label={message(id).status!.label} />}
            </div>
            <strong>{message(id).subject}</strong>
            <span>{message(id).sender}</span>
            <p>{message(id).text}</p>
          </div>
        )}
      </HoverPreview>
    </DemoCard>
  );
};

const demoProjects = [
  { label: "Atlas", desc: "Customer portal", value: "atlas" },
  { label: "Beacon", desc: "Operations dashboard", value: "beacon" },
  { label: "Cedar", desc: "Documentation site", value: "cedar" },
];

const PromptsDemo = () => {
  const openBareNestedDialog = () =>
    prompts.dialog<void>(
      (close) => (
        <section class="ui-dialog-demo-surface">
          <h2>Caller-owned surface</h2>
          <div class="ui-dialog-demo-body">
            <p>
              <code>surface: "bare"</code> means the package renders no surface of its own. Everything you see here is showcase-owned
              chrome, exactly like an application would supply.
            </p>
            <p>The outer dialog stays mounted while the nested confirmation is open.</p>
            <div class="ui-dialog-demo-actions">
              <Button
                variant="secondary"
                onClick={() =>
                  void prompts.confirm("Return to the caller-owned surface?", {
                    title: "Nested confirmation",
                    confirmText: "Return",
                  })
                }
              >
                Open nested confirm
              </Button>
              <Button onClick={() => close()}>Close</Button>
            </div>
          </div>
        </section>
      ),
      { surface: "bare", header: false },
    );

  return (
    <DemoCard
      id="prompts"
      chip={{ kind: "component", name: "prompts", from: "@k2b/ui" }}
      description="Browser-only alert, ordinary and typed confirmation, search, form, and custom-dialog flows, including a safe nested bare-surface example."
      code={`const confirmed = await prompts.confirm("Publish this release?", {
  title: "Publish release",
  confirmText: "Publish",
});

const deleted = await prompts.confirm("Delete Project Atlas?", {
  title: "Delete project",
  confirmText: "Delete project",
  confirmationPhrase: "Project Atlas",
  variant: "danger",
});

const selected = await prompts.search(resolveProjects, {
  title: "Open project",
  placeholder: "Search projects...",
});

const values = await prompts.form({
  title: "New project",
  confirmText: "Create",
  fields: {
    name: { type: "text", label: "Project name", required: true },
  },
});

await prompts.dialog((close) => <MySurface close={close} />, {
  surface: "bare",
  header: false,
});`}
    >
      <div class="ui-demo-row">
        <Button variant="secondary" onClick={() => void prompts.alert("The import is ready.", { title: "Import complete" })}>
          Alert
        </Button>
        <Button
          variant="secondary"
          onClick={() => void prompts.confirm("Publish this release?", { title: "Publish release", confirmText: "Publish" })}
        >
          Confirm
        </Button>
        <Button
          variant="danger"
          onClick={() =>
            void prompts.confirm("Delete Project Atlas and all stored data?", {
              title: "Delete project",
              confirmText: "Delete project",
              confirmationPhrase: "Project Atlas",
              variant: "danger",
            })
          }
        >
          Typed confirm
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            void prompts.search(
              ({ query }) =>
                demoProjects.filter((project) => `${project.label} ${project.desc}`.toLowerCase().includes(query.toLowerCase())),
              {
                title: "Open project",
                placeholder: "Search projects...",
                noResultsText: "No matching projects.",
              },
            )
          }
        >
          Search
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            void prompts.form({
              title: "New project",
              confirmText: "Create",
              fields: {
                name: { type: "text", label: "Project name", required: true },
                visibility: {
                  type: "select",
                  label: "Visibility",
                  default: "private",
                  options: [
                    { id: "private", label: "Private" },
                    { id: "shared", label: "Shared" },
                  ],
                },
              },
            })
          }
        >
          Form
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            void prompts.dialog(
              (close) => (
                <div class="ui-dialog-demo-body">
                  <p>Custom Solid content uses the shared dialog surface.</p>
                  <div class="ui-dialog-demo-actions">
                    <Button onClick={() => close("done")}>Done</Button>
                  </div>
                </div>
              ),
              { title: "Custom dialog", icon: "ti ti-components" },
            )
          }
        >
          Custom
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            void dialogCore.open<void>(
              (close, context) => {
                const [floating, setFloating] = createSignal(false);
                const [text, setText] = createSignal("");
                return (
                  <section class="ui-dialog-demo-body">
                    <h2>Modal and floating window</h2>
                    <p>Switch modes without losing this input or closing the window.</p>
                    <TextInput aria-label="Retained text" placeholder="Type something…" value={text} onValueChange={setText} />
                    <div class="ui-dialog-demo-actions">
                      <Button
                        variant="secondary"
                        onClick={() => {
                          const next = !floating();
                          setFloating(next);
                          context.setPosition(next ? { x: 24, y: 100 } : null);
                          context.setModal(!next);
                        }}
                      >
                        {floating() ? "Center as modal" : "Float beside page"}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => void prompts.confirm("The floating parent will be restored.", { title: "Nested dialog" })}
                      >
                        Nested dialog
                      </Button>
                      <Button onClick={() => close()}>Close</Button>
                    </div>
                  </section>
                );
              },
              { ariaLabel: "Modal and floating window" },
            )
          }
        >
          Modal / floating
        </Button>
        <Button variant="secondary" onClick={() => void openBareNestedDialog()}>
          Bare + nested
        </Button>
      </div>
    </DemoCard>
  );
};

const demos: DemoSection = {
  blocks: () => (
    <DemoGrid columns="one">
      <BlocksDemo />
    </DemoGrid>
  ),
  badges: () => (
    <DemoGrid columns="one">
      <BadgesDemo />
    </DemoGrid>
  ),
  toast: () => (
    <DemoGrid columns="one">
      <ToastDemo />
      <AnnounceDemo />
    </DemoGrid>
  ),
  tooltip: () => (
    <DemoGrid columns="one">
      <TooltipDemo />
    </DemoGrid>
  ),
  "hover-preview": () => (
    <DemoGrid columns="one">
      <HoverPreviewDemo />
    </DemoGrid>
  ),
  prompts: () => (
    <DemoGrid columns="one">
      <PromptsDemo />
    </DemoGrid>
  ),
  "install-guide": () => <InstallGuideDemo />,
};

export default demos;
