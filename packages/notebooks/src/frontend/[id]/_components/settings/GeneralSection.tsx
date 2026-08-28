import type { DateContext } from "@k2b/stdlib";
import { mutation as mutations } from "@k2b/stdlib/solid";
import { IconInput, prompts, Select, SettingsField, SettingsGroup, SettingsModal, SettingsPanelFooter, TextInput, useLocale } from "@k2b/ui";
import { createEffect, createMemo, createSignal, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import { buildNoteTitleTemplateContext, renderNoteTitleTemplate } from "@/lib/note-title-template";
import type { Notebook, NoteTreeNode } from "../sidebar/types";
import type { NoteSelectOption } from "./types";
import { flattenNoteOptions, readErrorMessage } from "./utils";
import { notebookSettingsMessages } from "./messages";

export function GeneralSection(props: {
  notebook: Notebook;
  tree: NoteTreeNode[];
  canWrite: boolean;
  dateConfig: DateContext;
  onNotebookChange: (notebook: Notebook) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const locale = useLocale();
  const t = () => notebookSettingsMessages.resolve([locale()]).t;
  const options = createMemo(() => flattenNoteOptions(props.tree, t().untitled));
  const [base, setBase] = createSignal({
    name: props.notebook.name,
    description: props.notebook.description ?? "",
    icon: props.notebook.icon ?? "",
    homepageNoteId: props.notebook.homepageNoteId ?? "",
    defaultNoteTitleTemplate: props.notebook.defaultNoteTitleTemplate,
  });
  const [name, setName] = createSignal(base().name);
  const [description, setDescription] = createSignal(base().description);
  const [icon, setIcon] = createSignal(base().icon);
  const [homepageNoteId, setHomepageNoteId] = createSignal(base().homepageNoteId);
  const [defaultNoteTitleTemplate, setDefaultNoteTitleTemplate] = createSignal(base().defaultNoteTitleTemplate);

  const titlePreview = createMemo(() => {
    try {
      return {
        title: renderNoteTitleTemplate(
          defaultNoteTitleTemplate(),
          buildNoteTitleTemplateContext({
            notebook: { id: props.notebook.id, name: name().trim() || props.notebook.name },
            note: { id: "ABC123", depth: 0 },
            dateConfig: props.dateConfig,
          }),
        ),
        error: null,
      };
    } catch (error) {
      return { title: null, error: error instanceof Error ? error.message : t().invalidTitleTemplate };
    }
  });

  const selectedLabel = () => options().find((option) => option.id === homepageNoteId())?.label;
  const dirty = () =>
    name() !== base().name ||
    description() !== base().description ||
    icon() !== base().icon ||
    homepageNoteId() !== base().homepageNoteId ||
    defaultNoteTitleTemplate() !== base().defaultNoteTitleTemplate;
  const changeCount = () =>
    Number(name() !== base().name) +
    Number(description() !== base().description) +
    Number(icon() !== base().icon) +
    Number(homepageNoteId() !== base().homepageNoteId) +
    Number(defaultNoteTitleTemplate() !== base().defaultNoteTitleTemplate);

  createEffect(() => props.onDirtyChange(dirty()));
  onCleanup(() => props.onDirtyChange(false));

  const discard = () => {
    const current = base();
    setName(current.name);
    setDescription(current.description);
    setIcon(current.icon);
    setHomepageNoteId(current.homepageNoteId);
    setDefaultNoteTitleTemplate(current.defaultNoteTitleTemplate);
  };

  const fetchNotes = async (query: string, signal: AbortSignal): Promise<NoteSelectOption[]> => {
    if (signal.aborted) return [];
    const q = query.trim().toLowerCase();
    const filtered = q ? options().filter((option) => `${option.label} ${option.description ?? ""}`.toLowerCase().includes(q)) : options();
    return filtered.slice(0, 50);
  };

  const mutation = mutations.create({
    mutation: async () => {
      if (!name().trim()) throw new Error(t().nameRequired);
      if (titlePreview().error) throw new Error(titlePreview().error!);
      const res = await apiClient[":id"].$patch({
        param: { id: props.notebook.id },
        json: {
          name: name().trim(),
          description: description().trim() || null,
          icon: icon().trim() || null,
          homepageNoteId: homepageNoteId() || null,
          defaultNoteTitleTemplate: defaultNoteTitleTemplate(),
        },
      });
      if (!res.ok) throw new Error(await readErrorMessage(res, t().updateFailed));
      return (await res.json()) as Notebook;
    },
    onSuccess: (next) => {
      setBase({
        name: next.name,
        description: next.description ?? "",
        icon: next.icon ?? "",
        homepageNoteId: next.homepageNoteId ?? "",
        defaultNoteTitleTemplate: next.defaultNoteTitleTemplate,
      });
      props.onNotebookChange(next);
    },
    onError: (err) => prompts.error(err.message),
  });

  return (
    <>
      <SettingsGroup title={t().identity} description={t().identityDescription}>
        <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
          <SettingsField
            label={t().name}
            description={t().nameDescription}
            error={() => (!name().trim() ? t().nameRequired : undefined)}
            changed={() => name() !== base().name}
          >
            <TextInput aria-label={t().name} value={name} onValueChange={setName} icon="ti ti-notebook" required disabled={!props.canWrite} />
          </SettingsField>
          <SettingsField
            label={t().icon}
            description={t().iconDescription}
            error={() => undefined}
            changed={() => icon() !== base().icon}
          >
            <IconInput
              aria-label={t().icon}
              value={icon}
              onValueChange={(value) => setIcon(value ?? "")}
              placeholder={t().searchIcons}
              disabled={!props.canWrite}
            />
          </SettingsField>
        </div>
        <SettingsField
          label={t().description}
          description={t().descriptionHelp}
          error={() => undefined}
          changed={() => description() !== base().description}
        >
          <TextInput
            aria-label={t().description}
            value={description}
            onValueChange={setDescription}
            multiline
            lines={2}
            placeholder={t().descriptionPlaceholder}
            icon="ti ti-align-left"
            disabled={!props.canWrite}
          />
        </SettingsField>
      </SettingsGroup>

      <SettingsGroup title={t().newNotes} description={t().newNotesDescription}>
        <SettingsField
          label={t().homepage}
          description={t().homepageDescription}
          error={() => undefined}
          changed={() => homepageNoteId() !== base().homepageNoteId}
        >
          <Select
            aria-label={t().homepage}
            value={homepageNoteId}
            onValueChange={(value) => setHomepageNoteId(value ?? "")}
            selectedLabel={selectedLabel}
            fetchData={fetchNotes}
            placeholder={t().selectNote}
            icon="ti ti-home"
            activeIcon="ti ti-search"
            clearable
            disabled={!props.canWrite}
          />
        </SettingsField>

        <SettingsField
          label={t().defaultTitle}
          description={t().defaultTitleDescription}
          error={() => titlePreview().error ?? undefined}
          changed={() => defaultNoteTitleTemplate() !== base().defaultNoteTitleTemplate}
        >
          <TextInput
            aria-label={t().defaultTitle}
            value={defaultNoteTitleTemplate}
            onValueChange={setDefaultNoteTitleTemplate}
            multiline
            lines={3}
            icon="ti ti-template"
            required
            disabled={!props.canWrite}
            monospace
            maxLength={2_000}
          />
        </SettingsField>

        <div class="flex flex-col gap-1 text-xs">
          <div class="flex items-baseline gap-2">
            <span class="font-semibold">{t().preview}</span>
            <span class={titlePreview().error ? "text-dimmed" : "font-medium"}>{titlePreview().title ?? t().unavailable}</span>
          </div>
          <p class="text-dimmed">
            {t().variables}: <code>notebook.id</code>, <code>notebook.name</code>, <code>note.id</code>, <code>note.depth</code>,{" "}
            <code>parent.exists</code>, <code>parent.id</code>, <code>parent.title</code>, <code>parent.path</code>, <code>date</code>,{" "}
            <code>time</code>, <code>datetime</code>, {t().and} <code>timezone</code>.
          </p>
        </div>
      </SettingsGroup>

      <Show when={!props.canWrite}>
        <p class="text-xs text-dimmed">{t().readOnlySettings}</p>
      </Show>

      <Show when={props.canWrite}>
        <SettingsModal.Footer>
          <SettingsPanelFooter
            changeCount={changeCount}
            loading={mutation.loading}
            onDiscard={discard}
            onSave={() => mutation.mutate(undefined)}
          />
        </SettingsModal.Footer>
      </Show>
    </>
  );
}
