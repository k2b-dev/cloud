import { files as browserFiles } from "@k2b/stdlib/browser";
import {
  Button,
  confirmDiscardIfDirty,
  Dropdown,
  dialogCore,
  IconButton,
  MarkdownEditor,
  NoticeCard,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  SettingsCollection,
  StatusBadge,
  TextInput,
  toast,
} from "@k2b/ui";
import { PermissionEditor } from "@valentinkolb/cloud/access/ui";
import type { AiSkill, AiSkillExtraFrontmatter, AiSkillReferenceInput, AiSkillSummary } from "@valentinkolb/cloud/ai";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { assistantApi } from "../api/client";
import { type AiSkillImport, downloadAiSkillMarkdown, downloadAiSkillZip, readAiSkillImport } from "./assistant-skill-files";

export type AssistantSkillEditorRequest = { skillId?: string; imported?: AiSkillImport };

type SkillFields = {
  name: string;
  description: string;
  instructions: string;
  extraFrontmatter: AiSkillExtraFrontmatter;
  references: AiSkillReferenceInput[];
};

const emptySkill = (): SkillFields => ({ name: "", description: "", instructions: "", extraFrontmatter: {}, references: [] });
const fieldsFromSkill = (skill: AiSkill): SkillFields => ({
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  extraFrontmatter: skill.extraFrontmatter,
  references: skill.references.map((reference) => ({ ...reference })),
});
const fieldsFromImport = (skill: AiSkillImport): SkillFields => ({
  name: skill.name,
  description: skill.description,
  instructions: skill.instructions,
  extraFrontmatter: skill.extraFrontmatter,
  references: skill.references.map((reference) => ({ ...reference })),
});

const skillFieldsEqual = (left: SkillFields, right: SkillFields): boolean => JSON.stringify(left) === JSON.stringify(right);
const referenceName = (path: string): string => path.replace(/^references\//, "").replace(/\.md$/i, "");
const normalizedReferenceName = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");
const referencePath = (name: string): string => `references/${normalizedReferenceName(name)}.md`;

const openSkillAccess = async (skill: AiSkillSummary): Promise<void> => {
  const entries = await assistantApi.listSkillAccess(skill.id).catch(async (error) => {
    await prompts.error(error instanceof Error ? error.message : "Failed to load skill access");
    return null;
  });
  if (!entries) return;
  await prompts.dialog<void>(
    () => (
      <div class="flex min-h-0 flex-col gap-3">
        <p class="text-sm text-secondary">Share this skill through Cloud permissions. At least one administrator must remain.</p>
        <PermissionEditor
          initialEntries={entries}
          canEdit
          allowPublic
          allowServiceAccounts
          grantAccess={(principal, permission) => assistantApi.grantSkillAccess(skill.id, principal, permission)}
          updateAccess={(accessId, permission) => assistantApi.updateSkillAccess(skill.id, accessId, permission)}
          revokeAccess={(accessId) => assistantApi.revokeSkillAccess(skill.id, accessId)}
        />
      </div>
    ),
    { title: `Access to ${skill.name}`, icon: "ti ti-users", size: "large" },
  );
};

export function AssistantSkillsSettings(props: { refreshKey: number; onOpenEditor: (request: AssistantSkillEditorRequest) => void }) {
  const [query, setQuery] = createSignal("");
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [skills, { refetch }] = createResource(
    () => props.refreshKey,
    () => assistantApi.listSkills(),
  );
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return (skills() ?? []).filter((skill) => !needle || skill.name.includes(needle) || skill.description.toLowerCase().includes(needle));
  });

  const importSkill = async () => {
    try {
      const file = await browserFiles.showFileDialog({ accept: ".md,.zip,text/markdown,application/zip" });
      props.onOpenEditor({ imported: await readAiSkillImport(file) });
    } catch (error) {
      if (error instanceof Error && /cancel|select/i.test(error.message)) return;
      await prompts.error(error instanceof Error ? error.message : "Failed to import skill");
    }
  };

  const withSkill = async (skill: AiSkillSummary, action: (detail: AiSkill) => void | Promise<void>) => {
    if (busyId()) return;
    setBusyId(skill.id);
    try {
      await action(await assistantApi.getSkill(skill.id));
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : "Failed to load skill");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (skill: AiSkillSummary) => {
    if (!(await prompts.confirm(`Delete "${skill.name}"?`, { title: "Delete skill", variant: "danger", confirmText: "Delete" }))) return;
    setBusyId(skill.id);
    try {
      await assistantApi.deleteSkill(skill.id);
      await refetch();
      toast.success("Skill deleted");
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : "Failed to delete skill");
    } finally {
      setBusyId(null);
    }
  };

  const setEnabled = async (skill: AiSkillSummary, enabled: boolean) => {
    if (busyId()) return;
    setBusyId(skill.id);
    try {
      await assistantApi.setSkillEnabled(skill.id, enabled);
      await refetch();
      toast.success(enabled ? "Skill enabled for you" : "Skill disabled for you");
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : "Failed to update skill preference");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div class="flex min-h-0 flex-col gap-3" aria-busy={skills.loading || Boolean(busyId())}>
      <NoticeCard
        tone="info"
        title="Skills teach Assistant how to handle specific tasks"
        detail="Each Skill combines reusable instructions with optional extra information. Shared Skills start enabled for you; turn off any you don't want Assistant to use."
      />
      <div class="flex items-center gap-2">
        <TextInput
          class="min-w-0 flex-1"
          type="search"
          aria-label="Search skills"
          icon="ti ti-search"
          value={query}
          onValueChange={setQuery}
          placeholder="Search skills"
          disabled={Boolean(busyId())}
        />
        <Dropdown.Root
          position="bottom-left"
          width="12rem"
          disabled={Boolean(busyId())}
          items={[
            { label: "Create skill", icon: "ti ti-plus", action: () => props.onOpenEditor({}) },
            { label: "Import skill", icon: "ti ti-upload", action: () => void importSkill() },
          ]}
        >
          <Dropdown.Trigger variant="primary" label="Add skill">
            <i class="ti ti-plus" aria-hidden="true" />
            Add
            <i class="ti ti-chevron-down" aria-hidden="true" />
          </Dropdown.Trigger>
        </Dropdown.Root>
      </div>

      <Show when={skills.loading}>
        <Placeholder state="loading" title="Loading skills" />
      </Show>
      <Show when={skills.error}>
        <Placeholder
          state="error"
          title="Could not load skills"
          description={skills.error.message}
          action={
            <Button size="xs" variant="secondary" onClick={() => void refetch()}>
              Retry
            </Button>
          }
        />
      </Show>
      <Show when={!skills.loading && !skills.error}>
        <SettingsCollection
          title={<span class="sr-only">Available skills</span>}
          class="[&>.k2b-settings-collection__header]:sr-only"
          empty={query().trim() ? "No matching skills. Try a different search." : "No skills yet. Create or import one to get started."}
        >
          <For each={filtered()}>
            {(skill) => (
              <SettingsCollection.Item
                title={
                  <button
                    type="button"
                    class="text-left text-inherit hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--k2b-focus-ring)]"
                    onClick={() => props.onOpenEditor({ skillId: skill.id })}
                  >
                    {skill.name}
                  </button>
                }
                description={`${skill.description}${skill.referenceCount ? ` · ${skill.referenceCount} reference${skill.referenceCount === 1 ? "" : "s"}` : ""}`}
                icon={<i class="ti ti-sparkles" aria-hidden="true" />}
              >
                <Show when={!skill.enabled}>
                  <SettingsCollection.Item.Status>
                    <StatusBadge tone="neutral" icon={null} label="Disabled" />
                  </SettingsCollection.Item.Status>
                </Show>
                <SettingsCollection.Item.Actions>
                  <Dropdown.Root
                    position="bottom-left"
                    width="13rem"
                    disabled={Boolean(busyId())}
                    items={[
                      {
                        label: skill.permission === "read" ? "View" : "Edit",
                        icon: skill.permission === "read" ? "ti ti-eye" : "ti ti-pencil",
                        action: () => props.onOpenEditor({ skillId: skill.id }),
                      },
                      {
                        label: skill.enabled ? "Disable" : "Enable",
                        icon: skill.enabled ? "ti ti-player-pause" : "ti ti-player-play",
                        action: () => void setEnabled(skill, !skill.enabled),
                      },
                      {
                        label: "Export ZIP",
                        icon: "ti ti-download",
                        action: () => void withSkill(skill, downloadAiSkillZip),
                      },
                      ...(skill.referenceCount === 0
                        ? [
                            {
                              label: "Download SKILL.md",
                              icon: "ti ti-file-type-md",
                              action: () => void withSkill(skill, downloadAiSkillMarkdown),
                            },
                          ]
                        : []),
                      ...(skill.permission === "admin"
                        ? [
                            { label: "Manage access", icon: "ti ti-users", action: () => void openSkillAccess(skill) },
                            { label: "Delete", icon: "ti ti-trash", variant: "danger" as const, action: () => void remove(skill) },
                          ]
                        : []),
                    ]}
                  >
                    <Dropdown.Trigger appearance="plain" iconOnly label={`Actions for ${skill.name}`} title={`Actions for ${skill.name}`}>
                      <i class={busyId() === skill.id ? "ti ti-loader-2 k2b-spin" : "ti ti-dots"} aria-hidden="true" />
                    </Dropdown.Trigger>
                  </Dropdown.Root>
                </SettingsCollection.Item.Actions>
              </SettingsCollection.Item>
            )}
          </For>
        </SettingsCollection>
      </Show>
    </div>
  );
}

function AssistantSkillReferenceEditor(props: {
  reference?: AiSkillReferenceInput;
  existingPaths: readonly string[];
  readOnly: boolean;
  close: () => void;
  onSave: (reference: AiSkillReferenceInput) => void;
  onRemove?: () => void;
}) {
  const initialName = props.reference ? referenceName(props.reference.path) : "";
  const initialContent = props.reference?.content ?? "";
  const [name, setName] = createSignal(initialName);
  const [content, setContent] = createSignal(initialContent);
  const path = () => referencePath(name());
  const duplicate = () => props.existingPaths.some((existing) => existing !== props.reference?.path && existing === path());
  const invalid = () => !normalizedReferenceName(name()) || duplicate();
  const dirty = () => name() !== initialName || content() !== initialContent;
  const requestClose = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  const save = () => {
    if (props.readOnly || invalid()) return;
    props.onSave({ path: path(), content: content() });
    props.close();
  };
  const remove = async () => {
    if (!props.reference || !props.onRemove) return;
    const confirmed = await prompts.confirm(`Remove "${initialName}" from this Skill?`, {
      title: "Remove reference",
      confirmText: "Remove reference",
      variant: "danger",
    });
    if (!confirmed) return;
    props.onRemove();
    props.close();
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.reference ? "Edit reference" : "Create reference"}
        subtitle={props.readOnly ? "View supporting context for this Skill." : "Add supporting context Assistant can read when needed."}
        icon="ti ti-file-text"
        close={() => void requestClose()}
      />
      <PanelDialog.Body scrollPreserveKey="assistant-skill-reference-editor">
        <div class="flex flex-col gap-4">
          <TextInput
            label="Reference name"
            description="Use a short, recognizable name such as product-rules."
            value={name}
            onValueChange={setName}
            error={duplicate() ? "A reference with this name already exists." : undefined}
            maxLength={186}
            required
            readOnly={props.readOnly}
            autofocus={!props.reference}
          />
          <MarkdownEditor
            label="Content"
            description="Add the supporting information Assistant may need for this workflow."
            value={content}
            onValueChange={setContent}
            placeholder="Add supporting context."
            lines={14}
            maxLength={100_000}
            disabled={props.readOnly}
            onSave={save}
            saveDisabled={invalid() || !dirty()}
          />
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div>
          <Show when={!props.readOnly && props.reference}>
            <Button type="button" variant="danger" onClick={() => void remove()}>
              <i class="ti ti-trash" aria-hidden="true" />
              Remove reference
            </Button>
          </Show>
        </div>
        <div class="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => void requestClose()}>
            {props.readOnly ? "Close" : "Cancel"}
          </Button>
          <Show when={!props.readOnly}>
            <Button type="button" onClick={save} disabled={invalid() || !dirty()}>
              Save reference
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

function AssistantSkillReferencesEditor(props: {
  references: () => AiSkillReferenceInput[];
  readOnly: boolean;
  saving: boolean;
  close: () => void;
  onChange: (references: AiSkillReferenceInput[]) => void;
}) {
  const openReferenceEditor = async (reference?: AiSkillReferenceInput) => {
    await dialogCore.open<void>(
      (close) => (
        <AssistantSkillReferenceEditor
          reference={reference}
          existingPaths={props.references().map((item) => item.path)}
          readOnly={props.readOnly}
          close={() => close()}
          onSave={(next) =>
            props.onChange(
              reference ? props.references().map((item) => (item.path === reference.path ? next : item)) : [...props.references(), next],
            )
          }
          onRemove={reference ? () => props.onChange(props.references().filter((item) => item.path !== reference.path)) : undefined}
        />
      ),
      { ...panelDialogOptions, cancelBehavior: "ignore" },
    );
  };

  return (
    <PanelDialog>
      <PanelDialog.Header
        title="Extra info"
        subtitle="Manage supporting information Assistant can read when this Skill needs it."
        icon="ti ti-files"
        close={props.close}
      />
      <PanelDialog.Body scrollPreserveKey="assistant-skill-references-editor">
        <Show
          when={props.references().length > 0}
          fallback={
            <Placeholder
              state="empty"
              surface="paper"
              variant="panel"
              icon="ti ti-files"
              title="No extra info yet"
              description="Add supporting information Assistant can read when this Skill needs it."
              action={
                !props.readOnly ? (
                  <Button type="button" onClick={() => void openReferenceEditor()} disabled={props.saving}>
                    <i class="ti ti-plus" aria-hidden="true" />
                    Add reference
                  </Button>
                ) : undefined
              }
            />
          }
        >
          <SettingsCollection title={<span class="sr-only">References</span>}>
            <Show when={!props.readOnly}>
              <SettingsCollection.Action>
                <Button type="button" size="sm" variant="input" onClick={() => void openReferenceEditor()} disabled={props.saving}>
                  <i class="ti ti-plus" aria-hidden="true" />
                  Add reference
                </Button>
              </SettingsCollection.Action>
            </Show>
            <For each={props.references()}>
              {(reference) => (
                <SettingsCollection.Item
                  title={
                    <button
                      type="button"
                      class="text-left text-inherit hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--k2b-focus-ring)]"
                      onClick={() => void openReferenceEditor(reference)}
                    >
                      {referenceName(reference.path)}
                    </button>
                  }
                  icon={<i class="ti ti-file-text" aria-hidden="true" />}
                >
                  <SettingsCollection.Item.Actions>
                    <IconButton
                      label={`${props.readOnly ? "View" : "Edit"} reference ${referenceName(reference.path)}`}
                      title={props.readOnly ? "View reference" : "Edit reference"}
                      variant="ghost"
                      onClick={() => void openReferenceEditor(reference)}
                      disabled={props.saving}
                    >
                      <i class={props.readOnly ? "ti ti-eye" : "ti ti-pencil"} aria-hidden="true" />
                    </IconButton>
                  </SettingsCollection.Item.Actions>
                </SettingsCollection.Item>
              )}
            </For>
          </SettingsCollection>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <div />
        <Button type="button" variant="secondary" onClick={props.close}>
          Done
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function AssistantSkillEditor(props: {
  request: AssistantSkillEditorRequest;
  onBack: (changed: boolean) => void;
  onClose: () => void;
}) {
  const [detail] = createResource(
    () => props.request.skillId,
    (skillId) => assistantApi.getSkill(skillId),
  );
  const imported = props.request.imported;
  const initialFields = imported ? fieldsFromImport(imported) : emptySkill();
  const [fields, setFields] = createSignal<SkillFields>(initialFields);
  // Imported content has not been persisted yet and must therefore remain saveable.
  const [baseline, setBaseline] = createSignal<SkillFields>(props.request.skillId ? initialFields : emptySkill());
  const [saving, setSaving] = createSignal(false);
  let initialized = Boolean(imported || !props.request.skillId);

  createEffect(() => {
    const skill = detail();
    if (!skill || initialized) return;
    initialized = true;
    const next = fieldsFromSkill(skill);
    setFields(next);
    setBaseline(next);
  });

  const readOnly = () => Boolean(detail() && detail()!.permission === "read");
  const dirty = () => !skillFieldsEqual(fields(), baseline());

  const requestBack = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.onBack(false);
  };
  const requestClose = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.onClose();
  };

  const openReferencesEditor = async () => {
    await dialogCore.open<void>(
      (close) => (
        <AssistantSkillReferencesEditor
          references={() => fields().references}
          readOnly={readOnly()}
          saving={saving()}
          close={() => close()}
          onChange={(references) => setFields((current) => ({ ...current, references }))}
        />
      ),
      { ...panelDialogOptions, cancelBehavior: "ignore" },
    );
  };

  const save = async () => {
    if (readOnly() || saving()) return;
    setSaving(true);
    try {
      const input = fields();
      const saved = props.request.skillId
        ? await assistantApi.updateSkill(props.request.skillId, detail()!.revision, input)
        : await assistantApi.createSkill(input);
      setBaseline(fieldsFromSkill(saved));
      toast.success(props.request.skillId ? "Skill saved" : "Skill created");
      props.onBack(true);
    } catch (error) {
      await prompts.error(error instanceof Error ? error.message : "Failed to save skill");
    } finally {
      setSaving(false);
    }
  };

  const invalid = () => !fields().name.trim() || !fields().description.trim() || !fields().instructions.trim();

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.request.skillId ? (detail()?.name ?? "Edit skill") : imported ? "Import skill" : "Create skill"}
        subtitle={
          readOnly() ? "You can view and export this shared Skill." : "Define reusable instructions and optional supporting references."
        }
        icon="ti ti-sparkles"
        close={() => void requestClose()}
        closeDisabled={saving()}
      />
      <PanelDialog.Body scrollPreserveKey="assistant-skill-editor">
        <Show when={!detail.loading} fallback={<Placeholder state="loading" title="Loading skill" />}>
          <Show
            when={!detail.error}
            fallback={<Placeholder state="error" title="Could not load skill" description={detail.error?.message} />}
          >
            <div class="flex min-h-[32rem] flex-1 flex-col gap-4">
              <Show
                when={readOnly()}
                fallback={
                  <NoticeCard
                    tone="info"
                    title="Description controls when this Skill loads"
                    detail="Assistant sees the name and description before deciding to load a Skill. Say what to do and when to use it."
                  />
                }
              >
                <NoticeCard tone="neutral" title="This Skill is read only" detail="You can view and export it, but you cannot change it." />
              </Show>
              <div class="flex flex-col gap-4">
                <TextInput
                  label="Skill name"
                  description="Use a short, action-oriented name with lowercase letters, numbers, and hyphens."
                  value={() => fields().name}
                  onValueChange={(name) => setFields((current) => ({ ...current, name }))}
                  maxLength={64}
                  placeholder="weekly-status"
                  required
                  readOnly={readOnly()}
                  autofocus={!props.request.skillId}
                />
                <TextInput
                  label="Description"
                  description="Start with an action and say when to use it. Keep it short, direct, and specific."
                  value={() => fields().description}
                  onValueChange={(description) => setFields((current) => ({ ...current, description }))}
                  maxLength={1024}
                  placeholder="Create weekly status reports from recent work. Use when asked for progress updates."
                  multiline
                  lines={3}
                  required
                  readOnly={readOnly()}
                />
              </div>

              <MarkdownEditor
                class="min-h-[18rem] flex-1"
                label="Instructions"
                description="Define the expected outcome, important constraints, and workflow. Include only guidance that changes how Assistant should work."
                value={() => fields().instructions}
                onValueChange={(instructions) => setFields((current) => ({ ...current, instructions }))}
                placeholder="Explain the workflow, constraints, and expected output."
                lines={12}
                fill
                disabled={readOnly() || saving()}
                maxLength={100_000}
                onSave={() => void save()}
                saveDisabled={invalid() || !dirty()}
                saving={saving()}
              />
            </div>
          </Show>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button type="button" variant="input" onClick={() => void openReferencesEditor()} disabled={saving()}>
          <i class="ti ti-files" aria-hidden="true" />
          Extra info
          <Show when={fields().references.length > 0}>
            <span class="text-xs text-dimmed">{fields().references.length}</span>
          </Show>
        </Button>
        <div class="flex items-center gap-2">
          <Button type="button" variant="secondary" onClick={() => void requestBack()} disabled={saving()}>
            Cancel
          </Button>
          <Show when={!readOnly()}>
            <Button
              type="button"
              variant="primary"
              onClick={() => void save()}
              loading={saving()}
              disabled={invalid() || !dirty() || detail.loading}
            >
              {props.request.skillId ? "Save skill" : "Create skill"}
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
