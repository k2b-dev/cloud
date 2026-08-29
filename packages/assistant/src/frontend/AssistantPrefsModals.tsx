import {
  Button,
  confirmDiscardIfDirty,
  Dropdown,
  IconButton,
  Placeholder,
  prompts,
  Select,
  SettingsCollection,
  SettingsGroup,
  SettingsModal,
  SettingsPanelFooter,
  StatusBadge,
  Switch,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import type { AiApprovalPreferenceView, AiMemory, AiMemoryKind, AiUserPrefs } from "@valentinkolb/cloud/ai";
import { coreClient } from "@valentinkolb/cloud/clients/core";
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { assistantConversationHref } from "./assistant-navigation";
import { openAssistantMemoryLearningActivity } from "./AssistantMemoryLearningActivity";
import { AssistantSkillEditor, type AssistantSkillEditorRequest, AssistantSkillsSettings } from "./AssistantSkillsSettings";
import { assistantBrowserText, useAssistantCopy, useAssistantText } from "./ui-copy";

// Kept in sync with the server limits; browser code does not import server-only constants.
const MEMORY_MAX_CHARS = 500;

type AssistantPrefsTab = "personalization" | "skills" | "system-prompt" | "approvals";

const readApiError = async (response: Response, fallback: string): Promise<string> => {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : fallback;
};

const loadApprovalPreferences = async (): Promise<AiApprovalPreferenceView[]> => {
  const response = await coreClient.ai["approval-preferences"].$get();
  if (!response.ok) throw new Error(await readApiError(response, "Failed to load remembered approvals"));
  return (await response.json()).approvals;
};

function ApprovalPreferences() {
  const text = useAssistantText();
  const copy = useAssistantCopy();
  const [approvals, { refetch }] = createResource(loadApprovalPreferences);
  const [revokingId, setRevokingId] = createSignal<string | null>(null);

  const revoke = async (approval: AiApprovalPreferenceView) => {
    if (revokingId()) return;
    setRevokingId(approval.id);
    try {
      const response = await coreClient.ai["approval-preferences"][":preferenceId"].$delete({
        param: { preferenceId: approval.id },
      });
      if (!response.ok) throw new Error(await readApiError(response, text("Failed to revoke approval")));
      await refetch();
      toast.success(copy().approvalAgain({ title: approval.title }));
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : text("Failed to revoke approval"));
    } finally {
      setRevokingId(null);
    }
  };

  return (
    <div aria-busy={approvals.loading || Boolean(revokingId())}>
      <Show when={approvals.error}>
        <div class="flex items-center justify-between gap-3 rounded-lg border border-red-200 p-3 text-sm dark:border-red-900">
          <span class="text-red-700 dark:text-red-300">{approvals.error.message}</span>
          <Button size="xs" variant="secondary" onClick={() => void refetch()}>
            {text("Retry")}
          </Button>
        </div>
      </Show>
      <Show when={approvals.loading}>
        <Placeholder state="loading" title={text("Loading remembered approvals")} />
      </Show>
      <Show when={!approvals.loading && !approvals.error}>
        <SettingsCollection
          title={text("Remembered approvals")}
          description={text("Actions listed here can run without asking again. Revoking a decision applies immediately.")}
          empty={text("No remembered approvals. Actions will ask before they run.")}
        >
          <For each={approvals()}>
            {(approval) => (
              <SettingsCollection.Item
                title={approval.title}
                description={approval.app?.name ?? text("Cloud AI tool")}
                icon={<i class={approval.app?.icon ?? "ti ti-tool"} style={{ color: approval.app?.accent }} aria-hidden="true" />}
              >
                <SettingsCollection.Item.Actions>
                  <IconButton
                    label={`Revoke approval for ${approval.title}`}
                    title={text("Revoke approval")}
                    size="sm"
                    loading={revokingId() === approval.id}
                    disabled={Boolean(revokingId())}
                    onClick={() => void revoke(approval)}
                  >
                    <i class="ti ti-shield-x" aria-hidden="true" />
                  </IconButton>
                </SettingsCollection.Item.Actions>
              </SettingsCollection.Item>
            )}
          </For>
        </SettingsCollection>
      </Show>
    </div>
  );
}

function SystemPromptPanel() {
  const text = useAssistantText();
  const [prompt, { refetch }] = createResource(() => assistantApi.getSystemPromptPreview());
  return (
    <SettingsGroup
      title={text("Effective instructions")}
      description={text("The complete prompt for a new chat with the current model, enabled Skills, personalization, and organization rules.")}
    >
      <Show when={prompt.loading}>
        <Placeholder state="loading" title={text("Loading system prompt")} />
      </Show>
      <Show when={prompt.error}>
        <div class="flex flex-col items-center gap-2">
          <Placeholder state="error" title={text("Could not load system prompt")} description={prompt.error.message} />
          <Button size="xs" variant="secondary" onClick={() => void refetch()}>
            {text("Retry")}
          </Button>
        </div>
      </Show>
      <Show when={prompt()?.prompt}>
        {(value) => (
          <pre class="max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-3 font-mono text-[11px] leading-relaxed text-zinc-700 [box-shadow:var(--ui-control-recess)] dark:bg-zinc-900 dark:text-zinc-300">
            {value()}
          </pre>
        )}
      </Show>
    </SettingsGroup>
  );
}

type EditableMemoryKind = Exclude<AiMemoryKind, "workflow">;

const memoryKindLabel = (kind: AiMemoryKind): string => {
  if (kind === "preference") return "Preference";
  if (kind === "workflow") return "Workflow";
  return "Fact";
};

const memoryKindIcon = (kind: AiMemoryKind): string => {
  if (kind === "preference") return "ti ti-adjustments";
  if (kind === "workflow") return "ti ti-route";
  return "ti ti-info-circle";
};

const openAddPersonalizationDialog = (): Promise<{ kind: EditableMemoryKind; content: string } | undefined> =>
  prompts.dialog<{ kind: EditableMemoryKind; content: string } | undefined>(
    (close) => {
      const text = useAssistantText();
      const [kind, setKind] = createSignal<EditableMemoryKind>("fact");
      const [content, setContent] = createSignal("");
      return (
        <form
          class="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const value = content().trim();
            if (value) close({ kind: kind(), content: value });
          }}
        >
          <p class="text-sm text-secondary">{text("Add a durable fact about you or a preference for future answers. New entries start pinned.")}</p>
          <Select
            label={text("Type")}
            value={kind}
            onValueChange={(value) => setKind(value as EditableMemoryKind)}
            options={[
              { value: "fact", label: text("Fact") },
              { value: "preference", label: text("Preference") },
            ]}
          />
          <TextInput
            label={text("Personalization")}
            value={content}
            onValueChange={setContent}
            multiline
            lines={8}
            maxLength={MEMORY_MAX_CHARS}
            placeholder={text("Prefers concise answers in German.")}
            autofocus
          />
          <div class="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" type="button" onClick={() => close()}>
              {text("Cancel")}
            </Button>
            <Button size="sm" type="submit" disabled={!content().trim()}>
              {text("Add personalization")}
            </Button>
          </div>
        </form>
      );
    },
    { title: assistantBrowserText("Add personalization"), icon: "ti ti-user-cog", size: "large" },
  );

function MemorySettings(props: { prefs: AiUserPrefs; onDirtyChange: (dirty: boolean) => void }) {
  const text = useAssistantText();
  const copy = useAssistantCopy();
  const locale = useLocale();
  const [query, setQuery] = createSignal("");
  const [hasSavedPersonalization, setHasSavedPersonalization] = createSignal<boolean>();
  const [memories, { refetch }] = createResource(query, async (q) => {
    const items = await assistantApi.listMemories({ q: q.trim() || undefined, limit: 50 });
    if (!q.trim()) setHasSavedPersonalization(items.length > 0);
    return items;
  });
  const [memoryEnabled, setMemoryEnabled] = createSignal(props.prefs.memoryEnabled);
  const [learningEnabled, setLearningEnabled] = createSignal(props.prefs.memoryLearningEnabled);
  const [savedPreferences, setSavedPreferences] = createSignal({
    memoryEnabled: props.prefs.memoryEnabled,
    learningEnabled: props.prefs.memoryLearningEnabled,
  });
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const changeCount = () =>
    Number(memoryEnabled() !== savedPreferences().memoryEnabled) + Number(learningEnabled() !== savedPreferences().learningEnabled);
  const discardSettings = () => {
    setMemoryEnabled(savedPreferences().memoryEnabled);
    setLearningEnabled(savedPreferences().learningEnabled);
  };
  createEffect(() => props.onDirtyChange(changeCount() > 0));
  onCleanup(() => props.onDirtyChange(false));

  const saveSettings = async () => {
    setBusyId("settings");
    try {
      await assistantApi.updatePrefs({ memoryEnabled: memoryEnabled(), memoryLearningEnabled: learningEnabled() });
      setSavedPreferences({ memoryEnabled: memoryEnabled(), learningEnabled: learningEnabled() });
      toast.success(text("Personalization settings saved"));
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : text("Failed to save personalization settings"));
    } finally {
      setBusyId(null);
    }
  };

  const addMemory = async () => {
    if (busyId()) return;
    const value = await openAddPersonalizationDialog();
    if (!value || busyId()) return;
    setBusyId("new");
    try {
      await assistantApi.createMemory({ ...value, priority: "pinned" });
      await refetch();
      toast.success(text("Personalization added"));
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : text("Failed to add personalization"));
    } finally {
      setBusyId(null);
    }
  };

  const editMemory = async (memory: AiMemory) => {
    const result = await prompts.form({
      title: text("Edit personalization"),
      size: "large",
      confirmText: text("Save"),
      fields: {
        message: { type: "info", content: text("Edit this personalization entry.") },
        value: {
          type: "text",
          label: false,
          default: memory.content,
          multiline: true,
          lines: 8,
          maxLength: MEMORY_MAX_CHARS,
        },
      },
    });
    const value = result?.value ?? null;
    if (value === null || value.trim() === memory.content || !value.trim()) return;
    setBusyId(memory.id);
    try {
      await assistantApi.updateMemory(memory.id, { content: value.trim() });
      await refetch();
      toast.success(text("Personalization updated"));
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : text("Failed to update personalization"));
    } finally {
      setBusyId(null);
    }
  };

  const togglePinned = async (memory: AiMemory) => {
    setBusyId(memory.id);
    try {
      await assistantApi.updateMemory(memory.id, { priority: memory.priority === "pinned" ? "normal" : "pinned" });
      await refetch();
      toast.success(text(memory.priority === "pinned" ? "Personalization unpinned" : "Personalization pinned"));
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : text("Failed to update personalization"));
    } finally {
      setBusyId(null);
    }
  };

  const removeMemory = async (memory: AiMemory) => {
    if (!(await prompts.confirm(copy().deleteNamed({ name: memory.content }), { title: text("Delete personalization"), variant: "danger" }))) return;
    setBusyId(memory.id);
    try {
      await assistantApi.deleteMemory(memory.id);
      await refetch();
      toast.success(text("Personalization deleted"));
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : text("Failed to delete personalization"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <div class="flex flex-col gap-6" aria-busy={Boolean(busyId()) || memories.loading}>
        <SettingsGroup title={text("Use personalization")} description={text("Choose how Assistant uses and learns durable context about you.")}>
          <Switch
            label={text("Use personalization in Assistant chats")}
            description={text("Relevant personal facts, preferences, and workflow defaults are added to new turns.")}
            value={memoryEnabled}
            onValueChange={setMemoryEnabled}
            disabled={Boolean(busyId())}
          />
          <Switch
            label={text("Learn personalization from private chats")}
            description={text("After a private-chat turn completes, Assistant may save durable facts, preferences, and repeated Cloud workflow defaults.")}
            value={learningEnabled}
            onValueChange={setLearningEnabled}
            disabled={Boolean(busyId())}
          />
          <Show when={savedPreferences().learningEnabled}>
            <div class="flex items-center justify-between gap-3 rounded-md bg-[var(--ui-surface-subtle)] px-3 py-2">
              <div class="min-w-0">
                <p class="text-sm font-medium text-primary">{text("Learning activity")}</p>
                <p class="text-xs text-dimmed">{text("Review background runs and the personalization they changed.")}</p>
              </div>
              <Button size="sm" variant="secondary" class="shrink-0" onClick={() => void openAssistantMemoryLearningActivity()}>
                <i class="ti ti-history" aria-hidden="true" /> {text("View activity")}
              </Button>
            </div>
          </Show>
        </SettingsGroup>

        <SettingsGroup title={text("Saved personalization")} description={text("Facts, preferences, and workflow defaults Assistant may carry into future conversations.")}>
          <Show when={memories.loading}>
            <Placeholder state="loading" title={text("Loading personalization")} />
          </Show>
          <Show when={memories.error}>
            <Placeholder
              state="error"
              title={text("Could not load personalization")}
              description={memories.error.message}
              action={
                <Button size="xs" variant="secondary" onClick={() => void refetch()}>
                  {text("Retry")}
                </Button>
              }
            />
          </Show>
          <Show when={!memories.loading && !memories.error}>
            <Show
              when={hasSavedPersonalization()}
              fallback={
                <Placeholder
                  state="empty"
                  title={text("No personalization yet")}
                  description={text("Add a fact or preference Assistant can use in future conversations.")}
                  action={
                    <Button variant="ghost" loading={busyId() === "new"} disabled={Boolean(busyId())} onClick={() => void addMemory()}>
                      <i class="ti ti-plus" aria-hidden="true" />
                      {text("Add personalization")}
                    </Button>
                  }
                />
              }
            >
              <div class="grid gap-1">
                <div class="flex items-center gap-2">
                  <TextInput
                    class="min-w-0 flex-1"
                    aria-label={text("Search personalization")}
                    type="search"
                    icon="ti ti-search"
                    value={query}
                    onValueChange={setQuery}
                    placeholder={text("Search personalization")}
                    disabled={Boolean(busyId())}
                  />
                  <IconButton
                    label={text("Add personalization")}
                    title={text("Add personalization")}
                    variant="input"
                    loading={busyId() === "new"}
                    disabled={Boolean(busyId())}
                    onClick={() => void addMemory()}
                  >
                    <i class="ti ti-plus" aria-hidden="true" />
                  </IconButton>
                </div>

                <SettingsCollection
                  title={<span class="sr-only">{text("Personalization entries")}</span>}
                  class="[&>.k2b-settings-collection__header]:sr-only"
                  empty={text("No matching personalization. Try a different search.")}
                >
                  <For each={memories()}>
                    {(memory) => (
                      <SettingsCollection.Item
                        title={memory.content}
                        description={
                          <>
                            {text(memoryKindLabel(memory.kind))}
                            <Show when={memory.priority === "pinned"}>
                              {" · "}
                              <span class="font-medium text-blue-600 dark:text-blue-400">{text("Pinned")}</span>
                            </Show>
                            {` · ${text("Updated")} ${new Date(memory.updatedAt).toLocaleDateString(locale())}`}
                          </>
                        }
                        icon={<i class={memoryKindIcon(memory.kind)} aria-hidden="true" />}
                      >
                        <Show when={memory.sourceConversationId}>
                          {(conversationId) => (
                            <SettingsCollection.Item.Status>
                              <a
                                class="inline-flex rounded-full focus-ui"
                                href={assistantConversationHref(globalThis.location?.href ?? "/app/assistant", conversationId())}
                              >
                                <StatusBadge tone="neutral" icon="ti ti-arrow-up-right" label={text("Go to source")} />
                              </a>
                            </SettingsCollection.Item.Status>
                          )}
                        </Show>
                        <SettingsCollection.Item.Actions>
                          <Dropdown.Root
                            position="bottom-left"
                            width="10rem"
                            label={text("Personalization actions")}
                            disabled={Boolean(busyId())}
                            items={[
                              { label: text("Edit"), icon: "ti ti-pencil", action: () => void editMemory(memory) },
                              {
                                label: text(memory.priority === "pinned" ? "Unpin" : "Pin"),
                                icon: memory.priority === "pinned" ? "ti ti-xbox-x" : "ti ti-pin",
                                action: () => void togglePinned(memory),
                              },
                              { label: text("Delete"), icon: "ti ti-trash", variant: "danger", action: () => void removeMemory(memory) },
                            ]}
                          >
                            <Dropdown.Trigger appearance="plain" iconOnly label={text("Personalization actions")} title={text("Personalization actions")}>
                              <i class="ti ti-dots" aria-hidden="true" />
                            </Dropdown.Trigger>
                          </Dropdown.Root>
                        </SettingsCollection.Item.Actions>
                      </SettingsCollection.Item>
                    )}
                  </For>
                </SettingsCollection>
              </div>
            </Show>
          </Show>
        </SettingsGroup>
      </div>
      <SettingsModal.Footer>
        <SettingsPanelFooter
          changeCount={changeCount}
          loading={() => busyId() === "settings"}
          onDiscard={discardSettings}
          onSave={() => void saveSettings()}
        />
      </SettingsModal.Footer>
    </>
  );
}

function PrefsDialog(props: { prefs: AiUserPrefs; initialTab: AssistantPrefsTab; close: () => void }) {
  const text = useAssistantText();
  const [activeTab, setActiveTab] = createSignal<AssistantPrefsTab>(props.initialTab);
  const [personalizationDirty, setPersonalizationDirty] = createSignal(false);
  const [skillEditor, setSkillEditor] = createSignal<AssistantSkillEditorRequest>();
  const [skillsRefreshKey, setSkillsRefreshKey] = createSignal(0);
  const requestClose = async () => {
    if (await confirmDiscardIfDirty(personalizationDirty)) props.close();
  };
  return (
    <div class="dialog-fixed-frame flex min-h-0 flex-col overflow-hidden">
      <Show
        when={skillEditor()}
        fallback={
          <SettingsModal
            title={text("Assistant settings")}
            activeTab={activeTab()}
            onTabChange={(tab) => setActiveTab(tab as AssistantPrefsTab)}
            onClose={() => void requestClose()}
            closeLabel={text("Close Assistant settings")}
          >
            <SettingsModal.Tab
              id="personalization"
              title={text("Personalization")}
              icon="ti ti-user-cog"
              description={text("Facts, preferences, and workflow defaults Assistant may carry into future conversations.")}
            >
              <MemorySettings prefs={props.prefs} onDirtyChange={setPersonalizationDirty} />
            </SettingsModal.Tab>

            <SettingsModal.Tab
              id="skills"
              title={text("Skills")}
              icon="ti ti-sparkles"
              description={text("Create, import, and share reusable Assistant workflows.")}
            >
              <Show when={activeTab() === "skills"}>
                <AssistantSkillsSettings refreshKey={skillsRefreshKey()} onOpenEditor={setSkillEditor} />
              </Show>
            </SettingsModal.Tab>

            <SettingsModal.Tab
              id="system-prompt"
              title={text("System prompt")}
              icon="ti ti-code"
              description={text("Inspect the complete instructions and context applied to new chats.")}
            >
              <Show when={activeTab() === "system-prompt"}>
                <SystemPromptPanel />
              </Show>
            </SettingsModal.Tab>

            <SettingsModal.Tab
              id="approvals"
              title={text("Approvals")}
              icon="ti ti-shield-check"
              description={text("Manage actions Assistant may run without asking each time.")}
            >
              <ApprovalPreferences />
            </SettingsModal.Tab>
          </SettingsModal>
        }
      >
        {(request) => (
          <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--ui-radius-frame)] bg-[var(--k2b-surface)] [box-shadow:var(--ui-shadow-float)]">
            <AssistantSkillEditor
              request={request()}
              onBack={(changed) => {
                setSkillEditor(undefined);
                setActiveTab("skills");
                if (changed) setSkillsRefreshKey((value) => value + 1);
              }}
              onClose={props.close}
            />
          </div>
        )}
      </Show>
    </div>
  );
}

export const openAssistantPrefsModal = async (initialTab: AssistantPrefsTab = "personalization"): Promise<void> => {
  let prefs: AiUserPrefs;
  try {
    prefs = await assistantApi.getPrefs();
  } catch (error) {
    await prompts.error(error instanceof Error ? error.message : assistantBrowserText("Failed to load AI preferences"));
    return;
  }
  await prompts.dialog<void>((close) => <PrefsDialog prefs={prefs} initialTab={initialTab} close={() => close()} />, {
    surface: "bare",
    header: false,
    size: "wide",
  });
};
