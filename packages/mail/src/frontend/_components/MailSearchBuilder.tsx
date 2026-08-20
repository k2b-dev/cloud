import { mutation } from "@k2b/stdlib/solid";
import {
  Button,
  DateTimePicker,
  dialogCore,
  IconButton,
  NoticeCard,
  NumberInput,
  PanelDialog,
  panelDialogFixedOptions,
  prompts,
  SegmentedControl,
  Select,
  TextInput,
  toast,
} from "@k2b/ui";
import { createMemo, createSignal, Index, onCleanup, Show } from "solid-js";
import { apiClient } from "../../api/client";
import type { MailSearchExpression, SavedConversationViewScope } from "../../contracts";
import { type MailSearchState, serializeMailSearchState } from "../../search-state";
import type { SavedConversationView } from "../../service/saved-views";
import { readApiError } from "./api-response";
import {
  appendMailSearchExpression,
  applyMailSearchNegation,
  countMailSearchNodes,
  createMailSearchCondition,
  ensureMailSearchRootGroup,
  type MailSearchFieldKey,
  type MailSearchNodePath,
  mailSearchExpressionDepth,
  MAIL_SEARCH_FIELD_GROUPS,
  mailSearchFieldKey,
  mailSearchFieldOptionsFor,
  normalizeMailSearchExpression,
  removeMailSearchExpression,
  toggleMailSearchNegation,
  unwrapMailSearchNot,
  updateMailSearchExpression,
} from "./mail-search-builder-model";

const MAX_SEARCH_NODES = 100;
const MAX_SEARCH_DEPTH = 8;
const UNASSIGNED_VALUE = "__unassigned__";

export type MailSearchBuilderResult =
  | { action: "apply"; state: MailSearchState; serialized: string }
  | { action: "saved"; view: SavedConversationView }
  | { action: "clear" };

function MailSearchConditionEditor(props: {
  mailboxId: string;
  expression: MailSearchExpression;
  path: MailSearchNodePath;
  canRemove: boolean;
  nodeCount: number;
  onReplace: (path: MailSearchNodePath, expression: MailSearchExpression) => void;
  onToggleNot: (path: MailSearchNodePath) => void;
  onAppend: (path: MailSearchNodePath, expression: MailSearchExpression) => void;
  onRemove: (path: MailSearchNodePath) => void;
}) {
  const state = createMemo(() => unwrapMailSearchNot(props.expression));
  const node = () => state().expression;
  const group = () => {
    const current = node();
    return current.type === "and" || current.type === "or" ? current : null;
  };
  const isGroup = () => group() !== null;
  const atMaximumDepth = () => props.path.length + 2 >= MAX_SEARCH_DEPTH;
  const groupHasCapacity = () => (group()?.expressions.length ?? 0) < 20;
  const canAddCondition = () => props.nodeCount < MAX_SEARCH_NODES && groupHasCapacity();
  const canAddGroup = () => props.nodeCount < MAX_SEARCH_NODES - 1 && groupHasCapacity() && !atMaximumDepth();
  const canToggleNot = () =>
    state().negated ||
    (props.nodeCount < MAX_SEARCH_NODES && props.path.length + mailSearchExpressionDepth(props.expression) + 1 <= MAX_SEARCH_DEPTH);

  const replace = (next: Exclude<MailSearchExpression, { type: "not" }>) =>
    props.onReplace(props.path, applyMailSearchNegation(next, state().negated));

  const fetchAssignableUsers = async (query: string, signal: AbortSignal) => {
    const response = await apiClient.mailboxes[":mailboxId"]["assignable-users"].$get(
      {
        param: { mailboxId: props.mailboxId },
        query: { search: query.trim() || undefined, limit: "50" },
      },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, "Could not load mailbox users"));
    const users = await response.json();
    return [
      { id: UNASSIGNED_VALUE, label: "Unassigned", icon: "ti ti-user-off" },
      ...users.map((user) => ({ id: user.id, label: user.displayName, description: user.description, icon: "ti ti-user" })),
    ];
  };
  const fetchFolders = async (_query: string, signal: AbortSignal) => {
    const response = await apiClient.mailboxes[":mailboxId"].folders.$get({ param: { mailboxId: props.mailboxId } }, { init: { signal } });
    if (!response.ok) throw new Error(await readApiError(response, "Could not load mailbox folders"));
    return (await response.json())
      .filter((folder) => folder.selectable)
      .map((folder) => ({ id: folder.id, label: folder.name, description: folder.role, icon: "ti ti-folder" }));
  };
  const fetchLocalTags = async (query: string, signal: AbortSignal) => {
    const response = await apiClient.mailboxes[":mailboxId"]["local-tags"].$get(
      { param: { mailboxId: props.mailboxId } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await readApiError(response, "Could not load mailbox tags"));
    const normalized = query.trim().toLocaleLowerCase();
    return (await response.json())
      .filter((tag) => !normalized || tag.name.toLocaleLowerCase().includes(normalized))
      .map((tag) => ({ id: tag.id, label: tag.name, icon: "ti ti-tag", color: tag.color }));
  };

  return (
    <div
      class={`rounded-[var(--ui-radius-control)] border border-[var(--ui-border)] ${isGroup() ? "bg-[var(--ui-surface-subtle)] p-2" : "p-2"}`}
    >
      <div class="flex min-w-0 items-start gap-2">
        <IconButton
          type="button"
          class={`shrink-0 ${state().negated ? "text-red-600 dark:text-red-300" : ""}`}
          label={state().negated ? "Include this condition" : "Exclude this condition"}
          title={state().negated ? "Currently excluded. Click to include." : "Exclude this condition"}
          disabled={!canToggleNot()}
          onClick={() => props.onToggleNot(props.path)}
        >
          <i class={`ti ${state().negated ? "ti-circle-minus" : "ti-circle-plus"}`} aria-hidden="true" />
        </IconButton>

        <div class="min-w-0 flex-1">
          <Show
            when={isGroup()}
            fallback={
              <div class="grid min-w-0 grid-cols-1 gap-2 xl:grid-cols-[minmax(10rem,0.7fr)_minmax(14rem,1.3fr)]">
                <Select
                  label="Field"
                  value={() => mailSearchFieldKey(props.expression) ?? "text:any"}
                  onValueChange={(value) =>
                    props.onReplace(
                      props.path,
                      applyMailSearchNegation(createMailSearchCondition(value as MailSearchFieldKey), state().negated),
                    )
                  }
                  options={mailSearchFieldOptionsFor(props.expression)}
                  groups={MAIL_SEARCH_FIELD_GROUPS}
                  defaultGroup="recommended"
                  groupsAriaLabel="Filter search fields"
                />
                <SearchConditionValue
                  expression={props.expression}
                  replace={replace}
                  fetchAssignableUsers={fetchAssignableUsers}
                  fetchFolders={fetchFolders}
                  fetchLocalTags={fetchLocalTags}
                />
              </div>
            }
          >
            <div class="flex flex-col gap-2">
              <div class="flex min-w-0 items-center gap-2">
                <Select
                  label="Match"
                  value={() => group()?.type ?? null}
                  onValueChange={(value) => {
                    const current = group();
                    if (!current) return;
                    replace({ type: value === "or" ? "or" : "and", expressions: current.expressions });
                  }}
                  options={[
                    { id: "and", label: "All conditions", icon: "ti ti-list-check" },
                    { id: "or", label: "Any condition", icon: "ti ti-list-details" },
                  ]}
                />
                <span class="shrink-0 self-end pb-2 text-xs text-dimmed">{group()?.type === "and" ? "must match" : "may match"}</span>
              </div>
              <div class="flex flex-col gap-2">
                <Index each={group()?.expressions ?? []}>
                  {(child, index) => (
                    <MailSearchConditionEditor
                      mailboxId={props.mailboxId}
                      expression={child()}
                      path={[...props.path, index]}
                      canRemove={(group()?.expressions.length ?? 0) > 1}
                      nodeCount={props.nodeCount}
                      onReplace={props.onReplace}
                      onToggleNot={props.onToggleNot}
                      onAppend={props.onAppend}
                      onRemove={props.onRemove}
                    />
                  )}
                </Index>
              </div>
              <div class="flex flex-wrap items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={!canAddCondition()}
                  onClick={() => props.onAppend(props.path, createMailSearchCondition("text:any"))}
                >
                  <i class="ti ti-plus" aria-hidden="true" /> Condition
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  type="button"
                  disabled={!canAddGroup()}
                  onClick={() => props.onAppend(props.path, { type: "and", expressions: [createMailSearchCondition("text:any")] })}
                >
                  <i class="ti ti-brackets-contain" aria-hidden="true" /> Group
                </Button>
                <Show when={atMaximumDepth()}>
                  <span class="text-xs text-dimmed">Maximum nesting reached</span>
                </Show>
              </div>
            </div>
          </Show>
        </div>

        <IconButton
          type="button"
          class="shrink-0"
          label="Remove condition"
          title={props.canRemove ? "Remove condition" : "A group needs at least one condition"}
          disabled={!props.canRemove}
          onClick={() => props.onRemove(props.path)}
        >
          <i class="ti ti-trash" aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}

function SearchConditionValue(props: {
  expression: MailSearchExpression;
  replace: (expression: Exclude<MailSearchExpression, { type: "not" }>) => void;
  fetchAssignableUsers: (
    query: string,
    signal: AbortSignal,
  ) => Promise<Array<{ id: string; label: string; description?: string; icon?: string }>>;
  fetchFolders: (query: string, signal: AbortSignal) => Promise<Array<{ id: string; label: string; description?: string; icon?: string }>>;
  fetchLocalTags: (
    query: string,
    signal: AbortSignal,
  ) => Promise<Array<{ id: string; label: string; description?: string; icon?: string; color?: string }>>;
}) {
  const node = () => unwrapMailSearchNot(props.expression).expression;
  const textTerm = () => node() as Extract<MailSearchExpression, { type: "text" }>;
  const dateTerm = () => node() as Extract<MailSearchExpression, { type: "date" }>;
  const sizeTerm = () => node() as Extract<MailSearchExpression, { type: "size" }>;
  const statusTerm = () => node() as Extract<MailSearchExpression, { type: "work_status" }>;
  const assigneeTerm = () => node() as Extract<MailSearchExpression, { type: "assignee" }>;
  const snoozedTerm = () => node() as Extract<MailSearchExpression, { type: "snoozed" }>;
  const folderTerm = () => node() as Extract<MailSearchExpression, { type: "folder_id" }>;
  const localTagTerm = () => node() as Extract<MailSearchExpression, { type: "local_tag_id" }>;

  return (
    <>
      <Show when={node().type === "text"}>
        <div class="grid min-w-0 grid-cols-[minmax(0,1fr)_9rem] gap-2">
          <TextInput
            label="Search text"
            placeholder="Enter search text"
            value={() => textTerm().query}
            onValueChange={(query) => props.replace({ ...textTerm(), query })}
            maxLength={500}
          />
          <Select
            label="Match"
            value={() => textTerm().match}
            onValueChange={(match) =>
              props.replace({ ...textTerm(), match: match as Extract<MailSearchExpression, { type: "text" }>["match"] })
            }
            options={[
              { id: "words", label: "All words" },
              { id: "phrase", label: "Phrase" },
              { id: "contains", label: "Contains" },
              { id: "exact", label: "Exact" },
            ]}
          />
        </div>
      </Show>
      <Show when={node().type === "date"}>
        <div class="grid min-w-0 grid-cols-[11rem_minmax(0,1fr)] gap-2">
          <Select
            label="Comparison"
            value={() => dateTerm().operator}
            onValueChange={(operator) =>
              props.replace({ ...dateTerm(), operator: operator as Extract<MailSearchExpression, { type: "date" }>["operator"] })
            }
            options={[
              { id: "before", label: "Before" },
              { id: "on_or_before", label: "On or before" },
              { id: "after", label: "After" },
              { id: "on_or_after", label: "On or after" },
            ]}
          />
          <DateTimePicker
            label="Date and time"
            value={() => dateTerm().value}
            onValueChange={(value) => {
              if (value) props.replace({ ...dateTerm(), value });
            }}
            required
          />
        </div>
      </Show>
      <Show when={node().type === "size"}>
        <div class="grid min-w-0 grid-cols-[11rem_minmax(0,1fr)] gap-2">
          <Select
            label="Comparison"
            value={() => sizeTerm().operator}
            onValueChange={(operator) =>
              props.replace({ ...sizeTerm(), operator: operator as Extract<MailSearchExpression, { type: "size" }>["operator"] })
            }
            options={[
              { id: "less_than", label: "Less than" },
              { id: "at_most", label: "At most" },
              { id: "equal", label: "Exactly" },
              { id: "at_least", label: "At least" },
              { id: "greater_than", label: "Greater than" },
            ]}
          />
          <NumberInput
            label="Size"
            value={() => sizeTerm().bytes / (1024 * 1024)}
            onValueChange={(megabytes) => {
              if (megabytes !== null) props.replace({ ...sizeTerm(), bytes: Math.max(0, Math.round(megabytes * 1024 * 1024)) });
            }}
            min={0}
            decimalPlaces={2}
            allowNegative={false}
            showSteppers={false}
            suffix="MB"
          />
        </div>
      </Show>
      <Show when={node().type === "work_status"}>
        <Select
          label="Work status"
          value={() => statusTerm().value}
          onValueChange={(value) => props.replace({ ...statusTerm(), value: value as "needs_action" | "waiting" | "done" })}
          options={[
            { id: "needs_action", label: "Needs action", icon: "ti ti-message-reply" },
            { id: "waiting", label: "Waiting for reply", icon: "ti ti-hourglass" },
            { id: "done", label: "Done", icon: "ti ti-checkbox" },
          ]}
        />
      </Show>
      <Show when={node().type === "assignee"}>
        <Select
          label="Assignee"
          value={() => assigneeTerm().userId ?? UNASSIGNED_VALUE}
          selectedLabel={() => (assigneeTerm().userId ? undefined : "Unassigned")}
          onValueChange={(value) => props.replace({ ...assigneeTerm(), userId: value === UNASSIGNED_VALUE ? null : value })}
          fetchData={props.fetchAssignableUsers}
        />
      </Show>
      <Show when={node().type === "snoozed"}>
        <Select
          label="Snoozed state"
          value={() => String(snoozedTerm().value)}
          onValueChange={(value) => props.replace({ ...snoozedTerm(), value: value === "true" })}
          options={[
            { id: "true", label: "Snoozed", icon: "ti ti-alarm-snooze" },
            { id: "false", label: "Not snoozed", icon: "ti ti-alarm-off" },
          ]}
        />
      </Show>
      <Show when={node().type === "folder_id"}>
        <Select
          label="Folder"
          value={() => folderTerm().folderId}
          selectedLabel={() => (folderTerm().folderId ? undefined : "Choose a folder")}
          onValueChange={(folderId) => props.replace({ ...folderTerm(), folderId: folderId ?? "" })}
          fetchData={props.fetchFolders}
        />
      </Show>
      <Show when={node().type === "local_tag_id"}>
        <Select
          label="Tag"
          value={() => localTagTerm().tagId}
          selectedLabel={() => (localTagTerm().tagId ? undefined : "Choose a tag")}
          onValueChange={(tagId) => props.replace({ ...localTagTerm(), tagId: tagId ?? "" })}
          fetchData={props.fetchLocalTags}
        />
      </Show>
      <Show when={node().type === "assigned_to_me"}>
        <p class="flex h-full items-center text-sm text-secondary">Uses the current viewer.</p>
      </Show>
      <Show when={node().type === "all"}>
        <p class="flex h-full items-center text-sm text-secondary">Matches every visible conversation.</p>
      </Show>
    </>
  );
}

const isMailSearchGroup = (expression: MailSearchExpression): boolean => {
  const node = unwrapMailSearchNot(expression).expression;
  return node.type === "and" || node.type === "or";
};

function MailSearchRootEditor(props: {
  mailboxId: string;
  expression: MailSearchExpression;
  nodeCount: number;
  onReplace: (path: MailSearchNodePath, expression: MailSearchExpression) => void;
  onToggleNot: (path: MailSearchNodePath) => void;
  onAppend: (path: MailSearchNodePath, expression: MailSearchExpression) => void;
  onRemove: (path: MailSearchNodePath) => void;
}) {
  const [advancedOpen, setAdvancedOpen] = createSignal(false);
  const rootGroup = createMemo(() => {
    const node = unwrapMailSearchNot(props.expression).expression;
    return node.type === "and" || node.type === "or" ? node : null;
  });
  const rootChildren = () => rootGroup()?.expressions ?? [];
  const standardFilterCount = createMemo(() => rootChildren().filter((child) => !isMailSearchGroup(child)).length);
  const advancedGroupCount = createMemo(() => rootChildren().filter(isMailSearchGroup).length);
  const rootHasCapacity = () => props.nodeCount < MAX_SEARCH_NODES && rootChildren().length < 20;
  const canAddGroup = () => props.nodeCount < MAX_SEARCH_NODES - 1 && rootChildren().length < 20;

  const addRootFilter = (condition: MailSearchExpression) => {
    if (!rootHasCapacity()) return;
    props.onAppend([], condition);
  };

  const removeCondition = (path: MailSearchNodePath) => {
    if (path.length === 1 && rootChildren().length === 1) {
      const type = rootGroup()?.type ?? "and";
      props.onReplace([], { type, expressions: [createMailSearchCondition("text:any")] });
      return;
    }
    props.onRemove(path);
  };

  const addAdvancedGroup = () => {
    if (!canAddGroup()) return;
    props.onAppend([], { type: "or", expressions: [createMailSearchCondition("text:subject")] });
    setAdvancedOpen(true);
  };

  return (
    <>
      <PanelDialog.Section
        title="Filters"
        subtitle={
          standardFilterCount() === 0
            ? "No filters are active."
            : `${standardFilterCount()} filter${standardFilterCount() === 1 ? "" : "s"} active.`
        }
        icon="ti ti-filter"
        actions={
          <Show when={rootChildren().length > 1}>
            <div class="whitespace-nowrap">
              <SegmentedControl<"and" | "or">
                ariaLabel="How filters are combined"
                value={() => rootGroup()?.type ?? "and"}
                onValueChange={(type) => {
                  const current = rootGroup();
                  if (current) props.onReplace([], { type, expressions: current.expressions });
                }}
                options={[
                  { value: "and", label: "Match all" },
                  { value: "or", label: "Match any" },
                ]}
              />
            </div>
          </Show>
        }
      >
        <Show when={standardFilterCount() > 0} fallback={<p class="text-sm text-dimmed">Add a filter to narrow the mailbox search.</p>}>
          <div class="flex flex-col gap-2">
            <Index each={rootChildren()}>
              {(child, index) => (
                <Show when={!isMailSearchGroup(child())}>
                  <MailSearchConditionEditor
                    mailboxId={props.mailboxId}
                    expression={child()}
                    path={[index]}
                    canRemove
                    nodeCount={props.nodeCount}
                    onReplace={props.onReplace}
                    onToggleNot={props.onToggleNot}
                    onAppend={props.onAppend}
                    onRemove={removeCondition}
                  />
                </Show>
              )}
            </Index>
          </div>
        </Show>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class="self-start"
          disabled={!rootHasCapacity()}
          onClick={() => addRootFilter(createMailSearchCondition("text:subject"))}
        >
          <i class="ti ti-plus" aria-hidden="true" /> Add filter
        </Button>
      </PanelDialog.Section>

      <PanelDialog.Section
        title="Advanced conditions"
        subtitle="Optional logic for searches with alternative or nested groups."
        icon="ti ti-brackets-contain"
      >
        <details
          class="group rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)]"
          open={advancedOpen()}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
        >
          <summary class="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-sm font-medium">
            <i class="ti ti-brackets-contain text-dimmed" aria-hidden="true" />
            <span class="min-w-0 flex-1">
              {advancedGroupCount() === 0
                ? "Add alternative or nested conditions"
                : `${advancedGroupCount()} advanced group${advancedGroupCount() === 1 ? "" : "s"}`}
            </span>
            <span class="text-xs font-normal text-dimmed">Optional</span>
            <i class="ti ti-chevron-down text-dimmed transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div class="flex flex-col gap-2 px-3 pb-3">
            <Show when={advancedGroupCount() > 0} fallback={<p class="text-sm text-dimmed">No advanced condition groups are active.</p>}>
              <Index each={rootChildren()}>
                {(child, index) => (
                  <Show when={isMailSearchGroup(child())}>
                    <MailSearchConditionEditor
                      mailboxId={props.mailboxId}
                      expression={child()}
                      path={[index]}
                      canRemove
                      nodeCount={props.nodeCount}
                      onReplace={props.onReplace}
                      onToggleNot={props.onToggleNot}
                      onAppend={props.onAppend}
                      onRemove={removeCondition}
                    />
                  </Show>
                )}
              </Index>
            </Show>
            <Button variant="ghost" size="sm" type="button" class="self-start" disabled={!canAddGroup()} onClick={addAdvancedGroup}>
              <i class="ti ti-plus" aria-hidden="true" /> Add condition group
            </Button>
          </div>
        </details>
      </PanelDialog.Section>
    </>
  );
}

function MailSearchBuilderDialog(props: {
  mailboxId: string;
  initialState: MailSearchState | null;
  initialQuery: string;
  mode: "search" | "saved_view";
  initialSavedView: SavedConversationView | null;
  canWrite: boolean;
  close: (result?: MailSearchBuilderResult) => void;
}) {
  const initialExpression =
    props.initialState?.expression ??
    (props.initialQuery.trim()
      ? { type: "text" as const, field: "any" as const, query: props.initialQuery.trim(), match: "words" as const }
      : props.mode === "saved_view"
        ? { type: "all" as const }
        : createMailSearchCondition("text:any"));
  const [expression, setExpression] = createSignal(ensureMailSearchRootGroup(initialExpression));
  const [sort, setSort] = createSignal<MailSearchState["sort"]>(props.initialState?.sort ?? "relevance");
  const [savedViewName, setSavedViewName] = createSignal(props.initialSavedView?.name ?? "");
  const [savedViewScope, setSavedViewScope] = createSignal<SavedConversationViewScope>(props.initialSavedView?.scope ?? "private");
  const [error, setError] = createSignal<string | null>(null);
  let disposed = false;
  const nodeCount = createMemo(() => countMailSearchNodes(expression()));
  const canUpdateInitialView = () => props.initialSavedView?.scope === "private" || props.canWrite;

  const replace = (path: MailSearchNodePath, next: MailSearchExpression) => {
    setExpression((current) => updateMailSearchExpression(current, path, () => next));
    setError(null);
  };

  const apply = () => {
    const state = { expression: normalizeMailSearchExpression(expression()), sort: sort() } satisfies MailSearchState;
    const serialized = serializeMailSearchState(state);
    if (!serialized.ok) return setError(serialized.error);
    props.close({ action: "apply", state, serialized: serialized.value });
  };

  const saveViewMutation = mutation.create<
    { view: SavedConversationView; updated: boolean },
    { existing: SavedConversationView | null; name: string; scope: SavedConversationViewScope; state: MailSearchState }
  >({
    mutation: async ({ existing, name, scope, state }, { abortSignal }) => {
      const response = existing
        ? await apiClient.mailboxes[":mailboxId"]["saved-views"][":viewId"].$patch(
            {
              param: { mailboxId: props.mailboxId, viewId: existing.id },
              json: { expectedRevision: existing.revision, name, filter: state },
            },
            { init: { signal: abortSignal } },
          )
        : await apiClient.mailboxes[":mailboxId"]["saved-views"].$post(
            {
              param: { mailboxId: props.mailboxId },
              json: { name, scope, filter: state },
            },
            { init: { signal: abortSignal } },
          );
      if (!response.ok) throw new Error(await readApiError(response, "Failed to save view"));
      return { view: await response.json(), updated: Boolean(existing) };
    },
    onSuccess: ({ view, updated }) => {
      toast.success(updated ? "Saved view updated" : "Saved view created");
      props.close({ action: "saved", view });
    },
    onError: (cause) => setError(cause.message),
  });
  const saving = saveViewMutation.loading;

  const saveView = async (existing: SavedConversationView | null, details?: { name: string; scope: SavedConversationViewScope }) => {
    const state = { expression: normalizeMailSearchExpression(expression()), sort: sort() } satisfies MailSearchState;
    const serialized = serializeMailSearchState(state);
    if (!serialized.ok) return setError(serialized.error);
    const name = (details?.name ?? savedViewName()).trim();
    if (!name) return setError("Enter a name for the saved view.");
    setError(null);
    await saveViewMutation.mutate({ existing, name, scope: details?.scope ?? savedViewScope(), state });
  };

  const saveAsView = async () => {
    const values = await prompts.form({
      title: "Save search as view",
      fields: {
        name: { type: "text", label: "Name", required: true },
        scope: {
          type: "select",
          label: "Visibility",
          default: "private",
          options: [
            { id: "private", label: "Only me" },
            ...(props.canWrite ? [{ id: "mailbox", label: "Everyone with mailbox access" }] : []),
          ],
        },
      },
      confirmText: "Save view",
    });
    if (!values || disposed) return;
    await saveView(null, { name: values.name, scope: values.scope === "mailbox" ? "mailbox" : "private" });
  };

  onCleanup(() => {
    disposed = true;
    saveViewMutation.abort();
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={props.mode === "saved_view" ? (props.initialSavedView ? "Edit saved view" : "New saved view") : "Search mailbox"}
        subtitle={
          props.mode === "saved_view"
            ? "Choose which conversations appear in this reusable mailbox view."
            : "Find conversations with text and filters."
        }
        icon="ti ti-adjustments-search"
        close={() => props.close()}
      />
      <PanelDialog.Body scrollPreserveKey={`mail-search-builder:${props.mailboxId}`}>
        <Show when={props.mode === "saved_view"}>
          <PanelDialog.Section title="Saved view" subtitle="Choose how the view appears in mailbox navigation." icon="ti ti-bookmark">
            <div class="grid grid-cols-1 gap-2 md:grid-cols-2">
              <TextInput label="Name" value={savedViewName} onValueChange={setSavedViewName} maxLength={120} required />
              <Select
                label={props.initialSavedView ? "Visibility (fixed after creation)" : "Visibility"}
                value={savedViewScope}
                onValueChange={(value) => setSavedViewScope(value === "mailbox" ? "mailbox" : "private")}
                options={
                  props.initialSavedView
                    ? [
                        {
                          id: props.initialSavedView.scope,
                          label: props.initialSavedView.scope === "mailbox" ? "Everyone with mailbox access" : "Only me",
                        },
                      ]
                    : [
                        { id: "private", label: "Only me" },
                        ...(props.canWrite ? [{ id: "mailbox", label: "Everyone with mailbox access" }] : []),
                      ]
                }
              />
            </div>
          </PanelDialog.Section>
        </Show>
        <MailSearchRootEditor
          mailboxId={props.mailboxId}
          expression={expression()}
          nodeCount={nodeCount()}
          onReplace={replace}
          onToggleNot={(path) => {
            setExpression((current) => toggleMailSearchNegation(current, path));
            setError(null);
          }}
          onAppend={(path, child) => {
            setExpression((current) => appendMailSearchExpression(current, path, child));
            setError(null);
          }}
          onRemove={(path) => {
            setExpression((current) => removeMailSearchExpression(current, path));
            setError(null);
          }}
        />
        <PanelDialog.Section
          title="Result order"
          subtitle="Choose whether the closest match or the newest conversation appears first."
          icon="ti ti-sort-descending"
        >
          <Select
            label="Sort by"
            value={sort}
            onValueChange={(value) => setSort(value === "newest" ? "newest" : "relevance")}
            options={[
              { id: "relevance", label: "Best match", icon: "ti ti-sparkles" },
              { id: "newest", label: "Newest first", icon: "ti ti-calendar-down" },
            ]}
          />
        </PanelDialog.Section>
        <Show when={error()}>
          {(message) => (
            <NoticeCard tone="danger" icon={false} role="alert">
              <i class="ti ti-alert-circle" aria-hidden="true" /> {message()}
            </NoticeCard>
          )}
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Show when={props.mode === "search"} fallback={<span />}>
          <Button variant="ghost" size="sm" type="button" onClick={() => props.close({ action: "clear" })}>
            Clear search
          </Button>
        </Show>
        <div class="flex items-center gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={() => props.close()}>
            Cancel
          </Button>
          <Show
            when={props.mode === "search"}
            fallback={
              <Button size="sm" type="button" disabled={saving()} onClick={() => void saveView(props.initialSavedView)}>
                <i class={`ti ${saving() ? "ti-loader-2 animate-spin" : "ti-device-floppy"}`} aria-hidden="true" />
                {props.initialSavedView ? "Save view" : "Create view"}
              </Button>
            }
          >
            <Button variant="secondary" size="sm" type="button" disabled={saving()} onClick={() => void saveAsView()}>
              <i class="ti ti-bookmark-plus" aria-hidden="true" /> Save as view
            </Button>
            <Show when={canUpdateInitialView() ? props.initialSavedView : null}>
              {(view) => (
                <Button variant="secondary" size="sm" type="button" disabled={saving()} onClick={() => void saveView(view())}>
                  <i class="ti ti-device-floppy" aria-hidden="true" /> Update view
                </Button>
              )}
            </Show>
            <Button size="sm" type="button" onClick={apply}>
              <i class="ti ti-search" aria-hidden="true" /> Search
            </Button>
          </Show>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export const openMailSearchBuilder = (params: {
  mailboxId: string;
  initialState: MailSearchState | null;
  initialQuery: string;
  mode?: "search" | "saved_view";
  initialSavedView?: SavedConversationView | null;
  canWrite: boolean;
}): Promise<MailSearchBuilderResult | undefined> =>
  dialogCore.open<MailSearchBuilderResult>(
    (close) => (
      <MailSearchBuilderDialog
        {...params}
        mode={params.mode ?? "search"}
        initialSavedView={params.initialSavedView ?? null}
        close={close}
      />
    ),
    panelDialogFixedOptions,
  );
