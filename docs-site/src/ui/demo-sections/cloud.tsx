import { Chat, type ChatCommand, Widget, WidgetHero, WidgetList, WidgetPills, WidgetStat, WidgetStatus } from "@k2b/ui";
import type { AiPublicModelProfile } from "@k2b/cloud/ai";
import { AiChatActionsProvider, aiChatModelOptions, createAiChatTimeline } from "@k2b/cloud/ai/ui";
import { createSignal } from "solid-js";
import { DemoCard } from "../DemoCard";
import { DemoGrid, type DemoSection } from "./types";

const cloudComposerModels: AiPublicModelProfile[] = [
  {
    id: "fast",
    label: "vLLM Qwen 3.6",
    provider: "vllm",
    model: "qwen3.6",
    capabilities: ["streaming", "tools"],
    dataBoundary: "private",
    contextWindow: 262000,
  },
  {
    id: "vision",
    label: "OpenRouter Vision",
    provider: "openrouter",
    model: "openai/gpt-4.1-mini",
    capabilities: ["streaming", "tools", "vision"],
    dataBoundary: "hosted",
    contextWindow: 128000,
  },
];

const EmptyCloudTimeline = () => {
  const items = createAiChatTimeline({ messages: () => [], activeTurn: () => null });
  return <Chat.Timeline items={items()} emptyTitle="Start a conversation" />;
};

const AssistantDemo = () => {
  const [draft, setDraft] = createSignal("");
  const [selectedModelId, setSelectedModelId] = createSignal(cloudComposerModels[0]!.id);
  const commands: ChatCommand[] = [
    {
      name: "summarize",
      description: "Prepare a summary request",
      icon: "ti ti-list-details",
      action: ({ setValue }) => setValue("Summarize this:\n"),
    },
  ];
  return (
    <>
      <DemoCard
        id="ai-message-list"
        chip={[
          { kind: "component", name: "Chat.Timeline", from: "@k2b/ui" },
          { kind: "component", name: "createAiChatTimeline", from: "@k2b/cloud/ai/ui" },
        ]}
        description="The generic timeline owns chat presentation. Cloud projects its persisted messages and active turn into that contract."
        code={`const items = createAiChatTimeline({ messages: () => [], activeTurn: () => null });

<AiChatActionsProvider>
  <Chat.Timeline items={items()} emptyTitle="Start a conversation" />
</AiChatActionsProvider>`}
      >
        <div class="k2b-ui h-48 overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
          <AiChatActionsProvider>
            <EmptyCloudTimeline />
          </AiChatActionsProvider>
        </div>
      </DemoCard>

      <DemoCard
        id="ai-composer"
        chip={[
          { kind: "component", name: "Chat.Composer", from: "@k2b/ui" },
          { kind: "component", name: "aiChatModelOptions", from: "@k2b/cloud/ai/ui" },
        ]}
        description="The generic composer owns interaction and accessibility. Cloud only adapts model profiles and outgoing payloads."
        code={`<Chat.Composer
  value={draft()}
  onValueChange={setDraft}
  models={aiChatModelOptions(models)}
  selectedModelId={selectedModelId()}
  onModelChange={setSelectedModelId}
  commands={commands}
  contextUsage={{
    usage: latestUsage,
    loopUsage: latestLoopUsage,
    contextWindow: 262_000,
    modelLabel: "vLLM Qwen 3.6",
  }}
  onSubmit={(input) => sendMessage(aiComposerSendInput(input))}
/>`}
      >
        <div class="k2b-ui rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <Chat.Composer
            value={draft()}
            onValueChange={setDraft}
            models={aiChatModelOptions(cloudComposerModels)}
            selectedModelId={selectedModelId()}
            onModelChange={setSelectedModelId}
            commands={commands}
            onSubmit={() => true}
            contextUsage={{
              usage: { input: 15_876, output: 32, total: 15_908 },
              loopUsage: { input: 69_944, output: 819, total: 70_763 },
              contextWindow: 262_000,
              modelLabel: "vLLM Qwen 3.6",
            }}
          />
        </div>
      </DemoCard>
    </>
  );
};

const BackendRequiredNote = (props: { title: string; children: string }) => (
  <div class="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/35 dark:text-amber-100">
    <p class="font-semibold">{props.title}</p>
    <p class="mt-1 text-xs leading-relaxed">{props.children}</p>
  </div>
);

const PermissionsReference = () => (
  <DemoCard
    id="permission-editor"
    chip={[
      { kind: "component", name: "PermissionEditor", from: "@k2b/cloud/access/ui" },
      { kind: "component", name: "EntitySearch", from: "@k2b/cloud/account/ui" },
      { kind: "component", name: "ResourceApiKeys", from: "@k2b/cloud/access/ui" },
    ]}
    description="Backend-required access integration reference with no simulated grants, directory, or credentials."
    code={`import { PermissionEditor, ResourceApiKeys } from "@k2b/cloud/access/ui";
import { EntitySearch } from "@k2b/cloud/account/ui";

<PermissionEditor
  initialEntries={entries}
  grantAccess={(principal, permission) => access.grant(resourceId, principal, permission)}
  updateAccess={(accessId, permission) => access.update(resourceId, accessId, permission)}
  revokeAccess={(accessId) => access.revoke(resourceId, accessId)}
/>;

<EntitySearch includeUsers includeGroups onSelect={selectPrincipal} />;

<ResourceApiKeys
  initialKeys={keys}
  createKey={(input) => access.createKey(resourceId, input)}
  revokeKey={(credentialId) => access.revokeKey(resourceId, credentialId)}
/>;`}
  >
    <BackendRequiredNote title="Real identity and persistence required">
      PermissionEditor and EntitySearch depend on Cloud accounts routes, while every grant and API-key mutation must be authorized and
      persisted by the owning service. The catalog therefore shows the public contract without pretending that mutations succeed.
    </BackendRequiredNote>
  </DemoCard>
);

const ResourcePickerReference = () => (
  <DemoCard
    id="cloud-resource-picker"
    chip={[
      {
        kind: "component",
        name: "openCloudResourcePicker",
        from: "@k2b/cloud/browser/resource-picker",
      },
    ]}
    description="Backend-required resource selection through the authenticated Universal Search catalog."
    code={`import { openCloudResourcePicker } from "@k2b/cloud/browser/resource-picker";

const selected = await openCloudResourcePicker({
  title: "Add Cloud reference",
  excludeRefs: currentReferences,
  requireReader: true,
});

if (selected) {
  await saveReference(selected.ref, selected.title);
}`}
  >
    <BackendRequiredNote title="Real search providers and permissions required">
      The picker discovers live applications through the authenticated Universal Search route. The catalog shows its public contract without
      inventing resources or implying that a selection is authorized without the owning provider.
    </BackendRequiredNote>
  </DemoCard>
);

const DashboardWidgetsDemo = () => (
  <DemoCard
    id="dashboard-widget-composition"
    chip={[
      { kind: "component", name: "Widget", from: "@k2b/ui" },
      { kind: "component", name: "WidgetStat", from: "@k2b/ui" },
      { kind: "component", name: "WidgetList", from: "@k2b/ui" },
      { kind: "component", name: "WidgetPills", from: "@k2b/ui" },
      { kind: "component", name: "WidgetStatus", from: "@k2b/ui" },
      { kind: "component", name: "WidgetHero", from: "@k2b/ui" },
    ]}
    description="Public Cloud widget primitives rendered from bounded fixture data; endpoint discovery remains a server concern."
    code={`<Widget title="Account requests" icon="ti ti-users" size="compact">
  <WidgetStat value={7} label="Open" sub="Needs review" accent={{ tone: "amber", icon: "ti ti-clock" }} />
  <WidgetPills pills={[{ label: "New", value: 3, tone: "blue" }, { label: "Waiting", value: 4, tone: "amber" }]} />
</Widget>
<Widget title="Recent notes" icon="ti ti-notebook" size="compact">
  <WidgetList grow items={recentNotes} />
</Widget>
<Widget title="Service health" icon="ti ti-heartbeat" size="compact">
  <WidgetStatus tone="success" title="All systems operational" message="8 services report healthy." />
  <WidgetHero title="No active incidents" icon="ti ti-circle-check" tone="emerald" />
</Widget>`}
  >
    <div class="ui-cloud-widget-demo grid gap-4 lg:grid-cols-3">
      <Widget title="Account requests" icon="ti ti-users" size="compact">
        <WidgetStat value={7} label="Open" sub="Needs review" accent={{ tone: "amber", icon: "ti ti-clock" }} />
        <WidgetPills
          pills={[
            { label: "New", value: 3, tone: "blue" },
            { label: "Waiting", value: 4, tone: "amber" },
          ]}
        />
      </Widget>
      <Widget title="Recent notes" icon="ti ti-notebook" size="compact">
        <WidgetList
          grow
          items={[
            { icon: "ti ti-file-text", label: "Release plan", sub: "Platform", meta: "2m" },
            { icon: "ti ti-file-text", label: "Incident review", sub: "Operations", meta: "1h" },
          ]}
        />
      </Widget>
      <Widget title="Service health" icon="ti ti-heartbeat" size="compact">
        <WidgetStatus tone="success" title="All systems operational" message="8 services report healthy." />
        <WidgetHero title="No active incidents" icon="ti ti-circle-check" tone="emerald" />
      </Widget>
    </div>
  </DemoCard>
);

const demos: DemoSection = {
  "assistant-chat": () => (
    <DemoGrid columns="one">
      <AssistantDemo />
    </DemoGrid>
  ),
  permissions: () => (
    <DemoGrid columns="one">
      <PermissionsReference />
    </DemoGrid>
  ),
  "dashboard-widgets": () => (
    <DemoGrid columns="one">
      <DashboardWidgetsDemo />
    </DemoGrid>
  ),
  "resource-picker": () => (
    <DemoGrid columns="one">
      <ResourcePickerReference />
    </DemoGrid>
  ),
};

export default demos;
