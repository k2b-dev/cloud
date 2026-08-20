import { files as browserFiles } from "@k2b/stdlib/browser";
import {
  Button,
  confirmDiscardIfDirty,
  Dropdown,
  IconButton,
  MarkdownEditor,
  PanelDialog,
  Placeholder,
  prompts,
  Select,
  SettingsCollection,
  TextInput,
  toast,
} from "@k2b/ui";
import { PermissionEditor } from "@valentinkolb/cloud/access/ui";
import type { AiSkill, AiSkillExtraFrontmatter, AiSkillReferenceInput, AiSkillSummary } from "@valentinkolb/cloud/ai";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { assistantApi } from "../api/client";
import {
  type AiSkillImport,
  downloadAiSkillMarkdown,
  downloadAiSkillZip,
  readAiSkillImport,
} from "./assistant-skill-files";

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

export function AssistantSkillsSettings(props: {
  refreshKey: number;
  onOpenEditor: (request: AssistantSkillEditorRequest) => void;
}) {
  const [query, setQuery] = createSignal("");
  const [busyId, setBusyId] = createSignal<string | null>(null);
  const [skills, { refetch }] = createResource(() => props.refreshKey, () => assistantApi.listSkills());
  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    return (skills() ?? []).filter(
      (skill) => !needle || skill.name.includes(needle) || skill.description.toLowerCase().includes(needle),
    );
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

  return (
    <div class="flex min-h-0 flex-col gap-3" aria-busy={skills.loading || Boolean(busyId())}>
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
                <SettingsCollection.Item.Status>
                  <span class="text-xs capitalize text-dimmed">{skill.permission}</span>
                </SettingsCollection.Item.Status>
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
  const [selectedFile, setSelectedFile] = createSignal("SKILL.md");
  const [newReference, setNewReference] = createSignal("");
  const [addingReference, setAddingReference] = createSignal(false);
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
  const fileOptions = createMemo(() => [
    { value: "SKILL.md", label: "SKILL.md" },
    ...fields().references.map((reference) => ({ value: reference.path, label: reference.path })),
  ]);
  const selectedReference = () => fields().references.find((reference) => reference.path === selectedFile()) ?? null;
  const bodyValue = () => (selectedFile() === "SKILL.md" ? fields().instructions : selectedReference()?.content ?? "");
  const setBodyValue = (value: string) => {
    if (selectedFile() === "SKILL.md") setFields((current) => ({ ...current, instructions: value }));
    else setFields((current) => ({
      ...current,
      references: current.references.map((reference) => (reference.path === selectedFile() ? { ...reference, content: value } : reference)),
    }));
  };

  const requestBack = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.onBack(false);
  };
  const requestClose = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.onClose();
  };

  const addReference = () => {
    const raw = newReference().trim().toLowerCase().replace(/\.md$/i, "");
    const filename = raw.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!filename) return;
    const path = `references/${filename}.md`;
    if (fields().references.some((reference) => reference.path === path)) {
      void prompts.error(`Reference ${path} already exists.`);
      return;
    }
    setFields((current) => ({ ...current, references: [...current.references, { path, content: "" }] }));
    setSelectedFile(path);
    setNewReference("");
    setAddingReference(false);
  };

  const removeReference = () => {
    const path = selectedFile();
    if (path === "SKILL.md") return;
    setFields((current) => ({ ...current, references: current.references.filter((reference) => reference.path !== path) }));
    setSelectedFile("SKILL.md");
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
        title={props.request.skillId ? detail()?.name ?? "Edit skill" : imported ? "Import skill" : "Create skill"}
        subtitle={readOnly() ? "You can view and export this shared skill." : "Edit the portable SKILL.md source and its Markdown references."}
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
              <div class="grid items-start gap-4 lg:grid-cols-[minmax(14rem,0.34fr)_minmax(20rem,1fr)]">
                <TextInput
                  label="Skill name"
                  description="Lowercase letters, numbers, and hyphens. This becomes /skills/<name>."
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
                  description="Tell Assistant what the skill does and when it should load it."
                  value={() => fields().description}
                  onValueChange={(description) => setFields((current) => ({ ...current, description }))}
                  maxLength={1024}
                  multiline
                  lines={3}
                  required
                  readOnly={readOnly()}
                />
              </div>

              <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg bg-zinc-50 px-3 py-2 text-xs text-secondary dark:bg-zinc-900">
                <code class="break-all text-primary">/skills/{fields().name || "<name>"}/SKILL.md</code>
                <span>References load only when Assistant needs them.</span>
              </div>

              <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
                <div class="flex flex-wrap items-end gap-2">
                  <Select
                    class="min-w-[14rem] flex-1"
                    label="Skill file"
                    value={selectedFile}
                    onValueChange={setSelectedFile}
                    options={fileOptions()}
                    disabled={saving()}
                  />
                  <Show when={!readOnly()}>
                    <Button type="button" variant="secondary" onClick={() => setAddingReference(true)} disabled={saving() || addingReference()}>
                      <i class="ti ti-file-plus" aria-hidden="true" />
                      Add reference
                    </Button>
                    <Show when={selectedFile() !== "SKILL.md"}>
                      <IconButton label="Delete reference" title="Delete reference" variant="secondary" onClick={removeReference} disabled={saving()}>
                        <i class="ti ti-trash" aria-hidden="true" />
                      </IconButton>
                    </Show>
                  </Show>
                </div>
                <Show when={addingReference()}>
                  <div class="flex items-end gap-2 rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
                    <TextInput
                      class="min-w-0 flex-1"
                      label="Reference filename"
                      prefix="references/"
                      suffix=".md"
                      value={newReference}
                      onValueChange={setNewReference}
                      onSubmit={addReference}
                      autofocus
                    />
                    <Button type="button" variant="secondary" onClick={() => setAddingReference(false)}>
                      Cancel
                    </Button>
                    <Button type="button" onClick={addReference} disabled={!newReference().trim()}>
                      Add
                    </Button>
                  </div>
                </Show>
                <MarkdownEditor
                  class="min-h-[20rem] flex-1"
                  label={selectedFile() === "SKILL.md" ? "Instructions" : selectedFile()}
                  description={
                    selectedFile() === "SKILL.md"
                      ? "These instructions become active only after load_skill."
                      : "Reference content remains untrusted data and is read only when needed."
                  }
                  value={bodyValue}
                  onValueChange={setBodyValue}
                  placeholder={selectedFile() === "SKILL.md" ? "Explain the workflow, constraints, and expected output." : "Add reference material."}
                  lines={14}
                  fill
                  disabled={readOnly() || saving()}
                  maxLength={100_000}
                  onSave={() => void save()}
                  saveDisabled={invalid() || !dirty()}
                  saving={saving()}
                />
              </div>
            </div>
          </Show>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button type="button" variant="secondary" onClick={() => void requestBack()} disabled={saving()}>
          <i class="ti ti-arrow-left" aria-hidden="true" />
          Back to skills
        </Button>
        <div class="flex items-center gap-2">
          <Show when={!readOnly()}>
            <Button type="button" variant="primary" onClick={() => void save()} loading={saving()} disabled={invalid() || !dirty() || detail.loading}>
              {props.request.skillId ? "Save skill" : "Create skill"}
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
