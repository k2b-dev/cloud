import { Button, ButtonLink, InlineGuidance, NoticeCard, prompts, StatusBadge, Tooltip, toast } from "@k2b/ui";
import { DemoCard } from "../DemoCard";
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

  return (
    <DemoCard
      id="toast"
      chip={{ kind: "component", name: "toast", from: "@k2b/ui" }}
      description="Transient success and error feedback with navigation actions, in-place updates, and explicit dismissal."
      code={`const exportToast = toast("Preparing archive", {
  title: "Export",
  duration: 0,
});

exportToast.update("Archive ready", {
  variant: "success",
  action: { label: "View prompts", href: "./prompts" },
  duration: 5_000,
});
exportToast.dismiss();

toast.error("Could not save");`}
    >
      <div class="ui-demo-row">
        <Button
          variant="secondary"
          onClick={() =>
            toast.success("Project saved", {
              action: { label: "View prompts", href: "./prompts" },
            })
          }
        >
          Success + link
        </Button>
        <Button variant="secondary" onClick={() => toast.error("Could not save the project")}>
          Error toast
        </Button>
        <Button
          variant="secondary"
          onClick={() => {
            progressToast?.dismiss();
            progressToast = toast("Preparing archive", { title: "Export", duration: 0 });
          }}
        >
          Start sticky toast
        </Button>
        <Button
          variant="secondary"
          onClick={() =>
            progressToast?.update("Archive ready", {
              variant: "success",
              action: { label: "View prompts", href: "./prompts" },
              duration: 5_000,
            })
          }
        >
          Update it
        </Button>
        <Button variant="secondary" onClick={() => progressToast?.dismiss()}>
          Dismiss it
        </Button>
      </div>
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
    </DemoGrid>
  ),
  tooltip: () => (
    <DemoGrid columns="one">
      <TooltipDemo />
    </DemoGrid>
  ),
  prompts: () => (
    <DemoGrid columns="one">
      <PromptsDemo />
    </DemoGrid>
  ),
};

export default demos;
