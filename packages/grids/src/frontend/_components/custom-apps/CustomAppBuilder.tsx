import type { DateContext } from "@k2b/stdlib";
import { dnd, mutation as mutations } from "@k2b/stdlib/solid";
import {
  AppWorkspace,
  Button,
  ButtonLink,
  DetailPanel,
  dialogCore,
  IconButton,
  IconInput,
  InlineGuidance,
  MultiSelectInput,
  NoticeCard,
  NumberInput,
  PanelDialog,
  panelDialogOptions,
  panelDialogWorkspaceOptions,
  prompts,
  Select,
  StatusBadge,
  Switch,
  TextInput,
  Toolbar,
} from "@k2b/ui";
import type { WorkflowJsonValue } from "@valentinkolb/cloud/workflows";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "../../../api/client";
import type { PublicDslQueryPreviewResponse as DslQueryPreviewResponse } from "../../../api/gql-public";
import type { PublicField as Field, PublicView as View } from "../../../api/public-dto";
import { customAppPageRecordFieldIds } from "../../../custom-apps/conditions";
import { customAppContextKeys, customAppGlobalContextKeys } from "../../../custom-apps/context-keys";
import type {
  CustomAppAction,
  CustomAppBlock,
  CustomAppDefinition,
  CustomAppDiagnostic,
  CustomAppRowAction,
  CustomAppSidebarAction,
} from "../../../custom-apps/contracts";
import { type CustomAppBlockDragMeta, type CustomAppBlockDropMeta, CustomAppPageLayout } from "../../custom-app/PageLayout";
import { isRecordInputField } from "../fields/field-render";
import { ScopedPermissionEditor } from "../permissions/ScopedPermissionEditor";
import { errorMessage } from "../utils/api-helpers";
import { WorkflowEditor } from "../workflows/WorkflowEditor";
import type { PublicCustomApp } from "../workspace/workspace-public-state-model";
import CustomAppBlockPreview from "./CustomAppBlockPreview";
import { CustomAppAvailabilitySection, CustomAppGqlField } from "./CustomAppGqlField";
import { CustomAppMarkdownField } from "./CustomAppMarkdownField";
import {
  applyCustomAppBlockDrop,
  type CustomAppBlockDropIntent,
  type CustomAppLayoutIds,
  normalizeCustomAppPageLayout,
  sameCustomAppBlockDropIntent,
  selectCustomAppBlockDropTarget,
} from "./custom-app-builder-dnd";
import {
  appendCustomAppBlockRow,
  customAppPageParameterUsage,
  moveCustomAppPage,
  removeCustomAppPageParameter,
  renameCustomAppPage,
  renameCustomAppPageParameter,
} from "./custom-app-builder-model";
import { createCustomAppBuilderState } from "./custom-app-builder-state";
import type { CustomAppCatalog } from "./custom-app-catalog";

type PublicCustomAppDraftSave = { app: PublicCustomApp; valid: boolean; diagnostics: CustomAppDiagnostic[] };

type CustomAppPage = CustomAppDefinition["pages"][number];
type CustomAppRow = CustomAppPage["rows"][number];
type CustomAppColumn = CustomAppRow["columns"][number];
type SelectedBlock = {
  block: CustomAppBlock;
  blockIndex: number;
  column: CustomAppColumn;
  row: CustomAppRow;
};
type SelectedAction = { action: CustomAppAction | CustomAppRowAction; index: number; owner: "actions" | "rows" };
type CustomAppWorkflowAction = Extract<CustomAppAction, { kind: "workflow" }>;
type CustomAppGqlSource = Extract<Extract<CustomAppBlock, { type: "records" }>["source"], { kind: "gql" }>;
type CustomAppWorkflowLauncher = CustomAppCatalog["workflowLaunchers"][number] & {
  config: Extract<CustomAppCatalog["workflowLaunchers"][number]["config"], { kind: "customApp" }>;
};
type CustomAppScannerLauncher = CustomAppCatalog["workflowLaunchers"][number] & {
  config: Extract<CustomAppCatalog["workflowLaunchers"][number]["config"], { kind: "scanner" }>;
};
type AddBlockOptionBase = {
  icon: string;
  label: string;
  description: string;
};
type AddBlockOption = AddBlockOptionBase & ({ action: () => void; disabled?: false } | { action?: never; disabled: true });
type AddBlockSection = { id: string; label: string; options: readonly AddBlockOption[] };
const iconInputValue = (slug: string | undefined): string | null => (slug ? `ti ti-${slug}` : null);
const iconSlug = (value: string | null): string | undefined => value?.replace(/^ti ti-/, "") || undefined;

const isStarterChartGroupField = (field: Field): boolean =>
  !["file", "formula", "html_template", "json", "lookup", "rollup"].includes(field.type) && field.deletedAt === null;

export const customAppStarterGqlSources = (
  catalog: CustomAppCatalog,
): { records: CustomAppGqlSource | null; metrics: CustomAppGqlSource | null; chart: CustomAppGqlSource | null } => {
  let records: CustomAppGqlSource | null = null;
  let metrics: CustomAppGqlSource | null = null;
  for (const table of catalog.tables) {
    const fields = (catalog.fieldsByTable[table.id] ?? []).filter((field) => field.deletedAt === null);
    if (fields.length === 0) continue;
    records ??= { kind: "gql", query: `from table {${table.id}}` };
    metrics ??= { kind: "gql", query: `from table {${table.id}}\naggregate count(*) as total` };
    const chartField = fields.find(isStarterChartGroupField);
    if (chartField) {
      return {
        records,
        metrics,
        chart: {
          kind: "gql",
          query: `from table {${table.id}}\ngroup by {${chartField.id}}\naggregate count(*) as total`,
        },
      };
    }
  }
  return { records, metrics, chart: null };
};

const localId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
const chartTypeFrom = (value: string): Extract<CustomAppBlock, { type: "chart" }>["chartType"] | null => {
  switch (value) {
    case "bar":
    case "line":
    case "donut":
      return value;
    default:
      return null;
  }
};

const fieldsForView = (view: View, fieldsByTable: CustomAppCatalog["fieldsByTable"], fieldsById: ReadonlyMap<string, Field>): Field[] => {
  const tableFields = (fieldsByTable[view.tableId] ?? [])
    .filter((field) => field.deletedAt === null)
    .sort((left, right) => left.position - right.position);
  const configured = (view.ui.columns ?? [])
    .flatMap((column) => ("fieldId" in column ? [fieldsById.get(column.fieldId)] : []))
    .filter((field): field is Field => Boolean(field && field.deletedAt === null));
  if (configured.length > 0) return configured.slice(0, 30);
  const visible = tableFields.filter((field) => !field.hideInTable);
  return (visible.length > 0 ? visible : tableFields).slice(0, 30);
};

const blockMeta: Record<CustomAppBlock["type"], { icon: string; label: string }> = {
  actions: { icon: "ti ti-bolt", label: "Actions" },
  chart: { icon: "ti ti-chart-bar", label: "Chart" },
  comments: { icon: "ti ti-messages", label: "Comments" },
  form: { icon: "ti ti-forms", label: "Form" },
  html: { icon: "ti ti-code", label: "Rendered HTML" },
  markdown: { icon: "ti ti-markdown", label: "Markdown" },
  metrics: { icon: "ti ti-chart-dots", label: "Metrics" },
  record: { icon: "ti ti-id", label: "Record" },
  records: { icon: "ti ti-table", label: "Records" },
  referenced_records: { icon: "ti ti-table-share", label: "Referenced records" },
  scanner: { icon: "ti ti-scan", label: "Scanner" },
};

export const isCustomAppBlockSourceDiagnostic = (diagnostic: CustomAppDiagnostic, blockId: string): boolean =>
  diagnostic.path.includes(blockId) && diagnostic.path.includes("source");

export const isCustomAppAvailabilityDiagnostic = (diagnostic: CustomAppDiagnostic, targetId: string): boolean =>
  diagnostic.path.includes(targetId) && diagnostic.path.includes("availableWhen");

export const blankCustomAppDefinition = (app: PublicCustomApp): CustomAppDefinition => ({
  schemaVersion: 5,
  kind: "grids.custom-app",
  id: app.id,
  baseId: app.baseId,
  name: app.name,
  ...(app.icon ? { icon: app.icon } : {}),
  startPageId: "home",
  pages: [
    {
      id: "home",
      title: "Home",
      navigation: { visible: true },
      parameters: {},
      rows: [
        {
          id: "content",
          columns: [{ id: "main", span: 12, blocks: [{ id: "intro", type: "markdown", markdown: "" }] }],
        },
      ],
    },
  ],
});

function PageParameterIdInput(props: { id: string; existingIds: readonly string[]; onRename: (id: string) => void }) {
  const [value, setValue] = createSignal(props.id);
  const error = createMemo(() => {
    const next = value().trim();
    if (!/^[a-z][a-z0-9_]{0,79}$/.test(next)) return "Use lowercase letters, numbers, and underscores.";
    if (next !== props.id && props.existingIds.includes(next)) return "This parameter ID is already used.";
    return undefined;
  });
  createEffect(() => setValue(props.id));
  const commit = () => {
    const next = value().trim();
    if (!error() && next !== props.id) props.onRename(next);
  };
  return (
    <TextInput
      label="Parameter ID"
      description={`Used as @params.${props.id} in GQL and Markdown, and as part of page links.`}
      value={value}
      onValueChange={setValue}
      error={error}
      onBlur={commit}
      required
    />
  );
}

function PageIdInput(props: { id: string; existingIds: readonly string[]; onRename: (id: string) => void }) {
  const [value, setValue] = createSignal(props.id);
  const error = createMemo(() => {
    const next = value().trim();
    if (!/^[a-z][a-z0-9-]{0,79}$/.test(next)) return "Use lowercase letters, numbers, and hyphens.";
    if (next !== props.id && props.existingIds.includes(next)) return "This Page ID is already used.";
    return undefined;
  });
  createEffect(() => setValue(props.id));
  const commit = () => {
    const next = value().trim();
    if (!error() && next !== props.id) props.onRename(next);
  };
  return (
    <TextInput
      label="Page ID"
      description="Used in page URLs. Existing links change; references inside this app update automatically."
      value={value}
      onValueChange={setValue}
      error={error}
      onBlur={commit}
      required
    />
  );
}

function WorkflowPrerequisiteGuidance(props: {
  hasWorkflows: boolean;
  kind: "action" | "row";
  rowTableName?: string | null;
  onOpen: () => void;
}) {
  const subject = () => (props.kind === "row" ? "Row actions" : "Workflow actions");
  return (
    <InlineGuidance tone="danger">
      {props.hasWorkflows
        ? `${subject()} need an enabled App run option. Open a workflow and add or enable one.`
        : props.kind === "row" && props.rowTableName
          ? `${subject()} need a workflow with a ${props.rowTableName} record input and an App run option.`
          : `${subject()} need a workflow with an App run option.`}{" "}
      <Button variant="text" size="xs" onClick={props.onOpen}>
        {props.hasWorkflows ? "Open workflows" : "Create workflow"}
      </Button>
    </InlineGuidance>
  );
}

function JsonValueInput(props: { label: string; value: WorkflowJsonValue; onValueChange: (value: WorkflowJsonValue) => void }) {
  const serialize = () => JSON.stringify(props.value, null, 2) ?? "null";
  const [value, setValue] = createSignal(serialize());
  const [error, setError] = createSignal<string>();
  createEffect(() => setValue(serialize()));
  const commit = () => {
    try {
      props.onValueChange(JSON.parse(value()) as WorkflowJsonValue);
      setError(undefined);
    } catch {
      setError("Enter valid JSON before leaving this field.");
    }
  };
  return (
    <TextInput
      label={props.label}
      description="JSON supports text, numbers, booleans, arrays, objects, and null."
      value={value}
      onValueChange={setValue}
      onBlur={commit}
      error={error}
      markdown
    />
  );
}

function CustomAppLifecycleActions(props: {
  app: PublicCustomApp;
  baseId: string;
  beforeDelete?: () => Promise<void>;
  onUnpublished: (app: PublicCustomApp) => void;
}) {
  const unpublishMutation = mutations.create<PublicCustomApp | null, void>({
    mutation: async (_, { abortSignal }) => {
      const confirmed = await prompts.confirm(
        `Unpublish "${props.app.name}"? Its public URL will stop working immediately. The draft and access grants are preserved.`,
        {
          title: "Unpublish app",
          icon: "ti ti-world-off",
          confirmText: "Unpublish",
          variant: "danger",
        },
      );
      if (!confirmed) return null;
      const response = await apiClient.apps[":appId"].unpublish.$post(
        { param: { appId: props.app.id } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not unpublish the App."));
      return (await response.json()) as PublicCustomApp;
    },
    onSuccess: (unpublished) => {
      if (!unpublished) return;
      props.onUnpublished(unpublished);
      prompts.success("App unpublished. The draft is unchanged.");
    },
    onError: (error) => prompts.error(error.message),
  });

  const deleteMutation = mutations.create<boolean, void>({
    mutation: async (_, { abortSignal }) => {
      const confirmed = await prompts.confirm(
        `Delete "${props.app.name}"? The app and its live URL will be removed. Base tables and records are not affected. This cannot be undone in the UI.`,
        {
          title: "Delete app",
          icon: "ti ti-trash",
          confirmText: "Delete app",
          variant: "danger",
        },
      );
      if (!confirmed) return false;
      await props.beforeDelete?.();
      const response = await apiClient.apps[":appId"].$delete({ param: { appId: props.app.id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not delete the App."));
      return true;
    },
    onSuccess: (deleted) => {
      if (!deleted) return;
      window.location.assign(`/app/grids/${encodeURIComponent(props.baseId)}?edit=true`);
    },
    onError: (error) => prompts.error(error.message),
  });

  return (
    <div class="flex flex-wrap gap-2">
      <Show when={props.app.publishedAt}>
        <Button
          size="sm"
          variant="secondary"
          loading={unpublishMutation.loading()}
          disabled={deleteMutation.loading()}
          onClick={() => unpublishMutation.mutate(undefined)}
        >
          <i class="ti ti-world-off" aria-hidden="true" /> Unpublish app
        </Button>
      </Show>
      <Button
        size="sm"
        variant="danger"
        loading={deleteMutation.loading()}
        disabled={unpublishMutation.loading()}
        onClick={() => deleteMutation.mutate(undefined)}
      >
        <i class="ti ti-trash" aria-hidden="true" /> Delete app
      </Button>
    </div>
  );
}

function InvalidCustomAppDraft(props: { app: PublicCustomApp; baseId: string }) {
  const replaceMutation = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const confirmed = await prompts.confirm(
        "Replace the incompatible draft with a new blank schema v5 definition? This cannot be undone.",
        {
          title: "Replace incompatible draft",
          icon: "ti ti-file-plus",
          confirmText: "Replace draft",
          variant: "danger",
        },
      );
      if (!confirmed) return;
      const response = await apiClient.apps[":appId"].draft.$put(
        { param: { appId: props.app.id }, json: { definition: blankCustomAppDefinition(props.app) } },
        { init: { signal: abortSignal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, "Could not replace the incompatible draft."));
      window.location.reload();
    },
    onError: (error) => prompts.error(error.message),
  });
  const restoreMutation = mutations.create<void, void>({
    mutation: async (_, { abortSignal }) => {
      const response = await apiClient.apps[":appId"].restore.$post({ param: { appId: props.app.id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not restore the live version."));
      window.location.reload();
    },
    onError: (error) => prompts.error(error.message),
  });

  return (
    <AppWorkspace.Main class="p-4" mobilePane="main">
      <div class="mx-auto flex w-full max-w-2xl flex-col gap-4">
        <NoticeCard
          tone="danger"
          title="This draft cannot be opened"
          detail="This editor only accepts App schema v5. The incompatible draft cannot run or publish until you restore the live version or replace it."
          role="alert"
        >
          <ul class="list-disc space-y-1 pl-4 text-sm">
            <For each={props.app.draftDiagnostics}>{(diagnostic) => <li>{diagnostic.message}</li>}</For>
          </ul>
        </NoticeCard>
        <div class="flex flex-wrap gap-2">
          <Show when={props.app.publishedDefinition}>
            <Button
              variant="secondary"
              loading={restoreMutation.loading()}
              disabled={replaceMutation.loading()}
              onClick={() => restoreMutation.mutate(undefined)}
            >
              <i class="ti ti-restore" aria-hidden="true" /> Restore live version
            </Button>
          </Show>
          <Button
            variant="danger"
            loading={replaceMutation.loading()}
            disabled={restoreMutation.loading()}
            onClick={() => replaceMutation.mutate(undefined)}
          >
            <i class="ti ti-file-plus" aria-hidden="true" /> Replace with blank schema v5 draft
          </Button>
        </div>
        <NoticeCard
          tone="warning"
          title="App lifecycle"
          detail="You can still take the live app offline or delete it without replacing the incompatible draft."
        >
          <CustomAppLifecycleActions app={props.app} baseId={props.baseId} onUnpublished={() => window.location.reload()} />
        </NoticeCard>
      </div>
    </AppWorkspace.Main>
  );
}

const newPage = (definition: CustomAppDefinition): CustomAppPage => {
  const pageNumber = definition.pages.length + 1;
  return {
    id: localId("page"),
    title: `Page ${pageNumber}`,
    navigation: { visible: true },
    parameters: {},
    rows: [
      {
        id: localId("row"),
        columns: [
          {
            id: localId("column"),
            span: 12,
            blocks: [{ id: localId("markdown"), type: "markdown", markdown: "" }],
          },
        ],
      },
    ],
  };
};

type CustomAppBuilderProps = {
  app: PublicCustomApp;
  baseId: string;
  catalog: CustomAppCatalog;
  editMode: boolean;
  dateConfig?: DateContext;
  initialInspectorMode?: "app" | "page";
};

export default function CustomAppBuilder(props: CustomAppBuilderProps) {
  if (!props.app.draftDefinition) return <InvalidCustomAppDraft app={props.app} baseId={props.baseId} />;
  return <CustomAppBuilderEditor {...props} initialDefinition={props.app.draftDefinition} />;
}

function CustomAppBuilderEditor(props: CustomAppBuilderProps & { initialDefinition: CustomAppDefinition }) {
  const [app, setApp] = createSignal(props.app);
  const draft = createCustomAppBuilderState(props.initialDefinition);
  const [diagnostics, setDiagnostics] = createSignal<CustomAppDiagnostic[]>([]);
  const [saveState, setSaveState] = createSignal<"idle" | "saving" | "saved" | "error" | "invalid">(
    props.app.draftValid === false ? "invalid" : "idle",
  );
  const [saveError, setSaveError] = createSignal<string | null>(
    props.app.draftValid === false ? "The saved draft must be fixed before it can be published." : null,
  );
  const [selectedPageId, setSelectedPageId] = createSignal(props.initialDefinition.startPageId);
  const [selectedBlockId, setSelectedBlockId] = createSignal<string | null>(null);
  const [selectedActionId, setSelectedActionId] = createSignal<string | null>(null);
  const [previewResults, setPreviewResults] = createSignal<Record<string, DslQueryPreviewResponse>>({});
  const [inspectorOpen, setInspectorOpen] = createSignal(props.editMode);
  const [inspectorMode, setInspectorMode] = createSignal<"app" | "page" | "block" | "action">(props.initialInspectorMode ?? "page");
  const selectedPage = createMemo(() => draft.draft().pages.find((page) => page.id === selectedPageId()) ?? draft.draft().pages[0]!);
  const alternateStartPage = createMemo(() =>
    draft.draft().pages.find((page) => page.id !== selectedPage().id && Object.keys(page.parameters).length === 0),
  );
  const selectedBlock = createMemo<SelectedBlock | null>(() => {
    const blockId = selectedBlockId();
    if (!blockId) return null;
    for (const row of selectedPage().rows) {
      for (const column of row.columns) {
        const blockIndex = column.blocks.findIndex((block) => block.id === blockId);
        if (blockIndex >= 0) return { block: column.blocks[blockIndex]!, blockIndex, column, row };
      }
    }
    return null;
  });
  const selectedSourceBlock = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "records" || block?.type === "metrics" || block?.type === "chart" ? block : null;
  });
  const selectedRecordBlock = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "record" ? block : null;
  });
  const selectedRecordsBlock = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "records" ? block : null;
  });
  const selectedReferencedRecordsBlock = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "referenced_records" ? block : null;
  });
  const selectedRecordsLikeBlock = createMemo(() => selectedRecordsBlock() ?? selectedReferencedRecordsBlock());
  const selectedFormBlock = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "form" ? block : null;
  });
  const selectedChartBlock = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "chart" ? block : null;
  });
  const selectedActionsBlock = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "actions" ? block : null;
  });
  const selectedAction = createMemo<SelectedAction | null>(() => {
    const actionId = selectedActionId();
    if (!actionId) return null;
    const actions = selectedActionsBlock()?.actions ?? [];
    const actionIndex = actions.findIndex((action) => action.id === actionId);
    if (actionIndex >= 0) return { action: actions[actionIndex]!, index: actionIndex, owner: "actions" };
    const rowActions = selectedRecordsLikeBlock()?.rowActions ?? [];
    const rowIndex = rowActions.findIndex((action) => action.id === actionId);
    return rowIndex < 0 ? null : { action: rowActions[rowIndex]!, index: rowIndex, owner: "rows" };
  });
  const selectedNavigateAction = createMemo(() => {
    const action = selectedAction()?.action;
    return selectedAction()?.owner === "actions" && action?.kind === "navigate" ? action : null;
  });
  const selectedWorkflowAction = createMemo(() => {
    const action = selectedAction()?.action;
    return action?.kind === "workflow" ? action : null;
  });
  const selectedActionCount = createMemo(() =>
    selectedAction()?.owner === "rows"
      ? (selectedRecordsLikeBlock()?.rowActions?.length ?? 0)
      : (selectedActionsBlock()?.actions.length ?? 0),
  );
  const contextKeys = createMemo(() => customAppContextKeys(selectedPage()));
  const markdownInlineTokens = createMemo(() =>
    contextKeys()
      .filter((key) => key !== "auth.subjects")
      .map((key) => `@${key}`),
  );
  const blockCount = createMemo(() =>
    selectedPage().rows.reduce((total, row) => total + row.columns.reduce((sum, column) => sum + column.blocks.length, 0), 0),
  );
  const tablesById = createMemo(() => new Map(props.catalog.tables.map((table) => [table.id, table])));
  const tableOptions = createMemo(() =>
    props.catalog.tables.map((table) => ({ value: table.id, label: table.name, icon: table.icon ?? "ti ti-table" })),
  );
  const pageRecordTableOptions = createMemo(() =>
    tableOptions().map((option) => ({
      ...option,
      disabled: !(props.catalog.fieldsByTable[option.value] ?? []).some((field) => field.deletedAt === null),
    })),
  );
  const views = createMemo(() =>
    Object.values(props.catalog.viewsByTable)
      .flat()
      .filter((view) => view.deletedAt === null)
      .sort((left, right) => left.position - right.position),
  );
  const fieldsById = createMemo(
    () =>
      new Map(
        Object.values(props.catalog.fieldsByTable)
          .flat()
          .map((field) => [field.id, field]),
      ),
  );
  const viewResources = createMemo(() =>
    views().map((view) => ({ view, fields: fieldsForView(view, props.catalog.fieldsByTable, fieldsById()) })),
  );
  const viewsById = createMemo(() => new Map(views().map((view) => [view.id, view])));
  const viewOptions = createMemo(() =>
    viewResources().map(({ view, fields }) => ({
      value: view.id,
      label: view.name,
      description: tablesById().get(view.tableId)?.name ?? "Saved view",
      icon: view.icon ?? "ti ti-table",
      disabled: fields.length === 0,
    })),
  );
  const readyViews = createMemo(() => viewResources().filter((resource) => resource.fields.length > 0));
  const starterGqlSources = createMemo(() => customAppStarterGqlSources(props.catalog));
  const forms = createMemo(() =>
    Object.values(props.catalog.formsByTable)
      .flat()
      .filter((form): form is typeof form & { id: string } => Boolean(form.id) && form.deletedAt === null && form.isActive)
      .sort((left, right) => left.position - right.position),
  );
  const formsById = createMemo(() => new Map(forms().map((form) => [form.id, form])));
  const workflowsById = createMemo(() => new Map(props.catalog.workflows.map((workflow) => [workflow.id, workflow])));
  const workflowLaunchers = createMemo(() =>
    props.catalog.workflowLaunchers.filter(
      (launcher): launcher is CustomAppWorkflowLauncher => launcher.config.kind === "customApp" && workflowsById().has(launcher.workflowId),
    ),
  );
  const workflowLauncherOptions = createMemo(() =>
    workflowLaunchers().map((launcher) => ({
      value: launcher.id,
      label: launcher.config.label || launcher.name,
      description: workflowsById().get(launcher.workflowId)?.name ?? "App run option",
      icon: "ti ti-player-play",
    })),
  );
  const scannerLaunchers = createMemo(() =>
    props.catalog.workflowLaunchers.filter(
      (launcher): launcher is CustomAppScannerLauncher => launcher.config.kind === "scanner" && workflowsById().has(launcher.workflowId),
    ),
  );
  const scannerLauncherOptions = createMemo(() =>
    scannerLaunchers().map((launcher) => ({
      value: launcher.id,
      label: launcher.name,
      description: workflowsById().get(launcher.workflowId)?.name ?? "Scanner workflow",
      icon: "ti ti-scan",
    })),
  );
  const formOptions = createMemo(() =>
    forms().map((form) => ({
      value: form.id,
      label: form.name,
      description: tablesById().get(form.tableId)?.name ?? "Active form",
      icon: "ti ti-forms",
    })),
  );
  const sidebarActions = createMemo(() => draft.draft().sidebar?.actions ?? []);
  const updateSidebarAction = (actionId: string, update: (action: CustomAppSidebarAction) => CustomAppSidebarAction) =>
    setDefinition((definition) => ({
      ...definition,
      sidebar: {
        actions: (definition.sidebar?.actions ?? []).map((action) => (action.id === actionId ? update(action) : action)),
      },
    }));
  const removeSidebarAction = (actionId: string) =>
    setDefinition((definition) => ({
      ...definition,
      sidebar: { actions: (definition.sidebar?.actions ?? []).filter((action) => action.id !== actionId) },
    }));
  const addSidebarForm = () => {
    const form = forms()[0];
    if (!form) return;
    setDefinition((definition) => ({
      ...definition,
      sidebar: {
        actions: [
          ...(definition.sidebar?.actions ?? []),
          { id: localId("form"), kind: "form", label: form.name, icon: "forms", tone: "success", formId: form.id, fixedValues: {} },
        ],
      },
    }));
    setInspectorMode("app");
    setInspectorOpen(true);
  };
  const formBindingOptions = (formId: string) => {
    const form = formsById().get(formId);
    if (!form) return [];
    const fields = new Map((props.catalog.fieldsByTable[form.tableId] ?? []).map((field) => [field.id, field]));
    return form.config.fields.flatMap((entry) => {
      if (entry.kind !== "user_input") return [];
      const field = fields.get(entry.fieldId);
      return field && field.deletedAt === null ? [{ field, label: entry.label || field.name }] : [];
    });
  };
  const selectedRecordsView = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "records" && block.source.kind === "view" ? (viewsById().get(block.source.viewId) ?? null) : null;
  });
  const selectedRecordsFields = createMemo(() => {
    const view = selectedRecordsView();
    return view ? (viewResources().find((resource) => resource.view.id === view.id)?.fields ?? []) : [];
  });
  const selectedRecordsFieldOptions = createMemo(() =>
    selectedRecordsFields().map((field) => ({
      id: field.id,
      label: field.name,
      description: field.type,
      icon: field.icon ?? "ti ti-column-insert-right",
    })),
  );
  const selectedRecordsUsesTable = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "records" && block.display.kind === "table";
  });
  const referencedRecordsCandidates = createMemo(() => {
    const targetTableId = selectedPage().record?.tableId;
    if (!targetTableId) return [];
    return props.catalog.tables.flatMap((table) => {
      const fields = (props.catalog.fieldsByTable[table.id] ?? []).filter((field) => field.deletedAt === null);
      const relations = fields.filter(
        (field) => field.type === "relation" && (field.config as { targetTableId?: unknown }).targetTableId === targetTableId,
      );
      return relations.length > 0 && fields.length > 0 ? [{ table, fields: fields.slice(0, 30), relations }] : [];
    });
  });
  const selectedSourceTableId = createMemo(() => {
    const referenced = selectedReferencedRecordsBlock();
    if (referenced) return referenced.sourceTableId;
    const block = selectedSourceBlock();
    if (!block) return null;
    if (block.source.kind === "view") return viewsById().get(block.source.viewId)?.tableId ?? null;
    if (!draft.dirty()) {
      const compiled = app().draftCapabilities?.recordQueries.find(
        (capability) => capability.pageId === selectedPage().id && capability.blockId === block.id,
      );
      if (compiled) return compiled.primaryTableId;
    }
    const preview = previewResults()[block.id];
    if (!preview?.ok) return null;
    return preview.columns.find((column) => column.tableId)?.tableId ?? preview.rows.find((row) => row.tableId)?.tableId ?? null;
  });
  const selectedSourceRecordFields = createMemo(() => {
    const tableId = selectedSourceTableId();
    return tableId ? (props.catalog.fieldsByTable[tableId] ?? []).filter((field) => field.deletedAt === null).slice(0, 30) : [];
  });
  const referencedSourceOptions = createMemo(() =>
    referencedRecordsCandidates().map(({ table }) => ({ id: table.id, label: table.name, icon: table.icon ?? "ti ti-table" })),
  );
  const selectedReferencedSource = createMemo(() => {
    const block = selectedReferencedRecordsBlock();
    return block ? (referencedRecordsCandidates().find((candidate) => candidate.table.id === block.sourceTableId) ?? null) : null;
  });
  const referencedRelationOptions = createMemo(() =>
    (selectedReferencedSource()?.relations ?? []).map((field) => ({
      id: field.id,
      label: field.name,
      description: "Relation to this page record",
      icon: field.icon ?? "ti ti-link",
    })),
  );
  const referencedFieldOptions = createMemo(() =>
    (selectedReferencedSource()?.fields ?? []).map((field) => ({
      id: field.id,
      label: field.name,
      description: field.type,
      icon: field.icon ?? "ti ti-column-insert-right",
    })),
  );
  const rowInputForLauncher = (launcher: CustomAppWorkflowLauncher) => {
    if (launcher.config.inputMode !== "prompt") return null;
    const tableId = selectedSourceTableId();
    const workflow = workflowsById().get(launcher.workflowId);
    if (!tableId || !workflow) return null;
    return (
      workflow.plan.inputs.find((input) => input.type === "record" && workflow.plan.bindings[`inputs.${input.name}.table`] === tableId) ??
      null
    );
  };
  const preferredRowWorkflowLauncher = () => workflowLaunchers().find(rowInputForLauncher) ?? workflowLaunchers()[0] ?? null;
  const defaultRowWorkflowInputs = (launcher: CustomAppWorkflowLauncher): CustomAppRowAction["inputs"] => {
    const input = rowInputForLauncher(launcher);
    return input ? { [input.name]: { source: "ROW", path: "id" } } : {};
  };
  const recordsNavigationPageOptions = createMemo(() => {
    const tableId = selectedSourceTableId();
    if (!tableId) return [];
    return draft
      .draft()
      .pages.filter((page) => {
        const parameters = Object.values(page.parameters);
        return parameters.length > 0 && parameters.every((parameter) => parameter.tableId === tableId);
      })
      .map((page) => ({ id: page.id, label: page.title }));
  });
  const documentTemplateOptions = createMemo(() => {
    const tableId = selectedPage().record?.tableId;
    if (!tableId) return [];
    return (props.catalog.documentTemplatesByTable[tableId] ?? [])
      .filter((template) => template.enabled)
      .map((template) => ({
        id: template.id,
        label: template.name,
        description: template.description ?? undefined,
        icon: "ti ti-file-text",
      }));
  });
  const selectedForm = createMemo(() => {
    const block = selectedBlock()?.block;
    return block?.type === "form" ? (formsById().get(block.formId) ?? null) : null;
  });
  const selectedFormBindingOptions = createMemo(() => {
    const form = selectedForm();
    if (!form) return [];
    const fields = new Map((props.catalog.fieldsByTable[form.tableId] ?? []).map((field) => [field.id, field]));
    return form.config.fields.flatMap((entry) => {
      if (entry.kind !== "user_input") return [];
      const field = fields.get(entry.fieldId);
      if (!field || field.deletedAt !== null) return [];
      const targetTableId = field.type === "relation" && typeof field.config.targetTableId === "string" ? field.config.targetTableId : null;
      return [{ field, label: entry.label || field.name, targetTableId }];
    });
  });
  const diagnosticsForSelection = createMemo(() => {
    const selectedId = selectedBlockId();
    const pageId = selectedPage().id;
    return diagnostics().filter((diagnostic) => {
      if (selectedId && diagnostic.path.includes(selectedId)) return true;
      if (!selectedId && diagnostic.path.includes(pageId)) return true;
      return !diagnostic.path.includes("blocks") && !diagnostic.path.includes("pages");
    });
  });
  const panelDiagnostics = createMemo(() => {
    if (inspectorMode() === "page") {
      return diagnosticsForSelection().filter((diagnostic) => !isCustomAppAvailabilityDiagnostic(diagnostic, selectedPage().id));
    }
    const block = selectedSourceBlock();
    const selected = selectedBlock()?.block;
    if (!selected) return diagnosticsForSelection();
    if (inspectorMode() === "action") {
      const actionId = selectedActionId();
      return diagnosticsForSelection().filter(
        (diagnostic) => actionId && diagnostic.path.includes(actionId) && !isCustomAppAvailabilityDiagnostic(diagnostic, actionId),
      );
    }
    return diagnosticsForSelection().filter(
      (diagnostic) =>
        !isCustomAppAvailabilityDiagnostic(diagnostic, selected.id) &&
        !(block?.source.kind === "gql" && isCustomAppBlockSourceDiagnostic(diagnostic, block.id)),
    );
  });
  const diagnosticFor = (blockId: string, segment: string) =>
    diagnostics().find((diagnostic) => diagnostic.path.includes(blockId) && diagnostic.path.includes(segment))?.message;

  const selectPage = (pageId: string) => {
    setSelectedPageId(pageId);
    setSelectedBlockId(null);
    setSelectedActionId(null);
    if (!props.editMode) return;
    setInspectorMode("page");
    setInspectorOpen(true);
  };

  const selectBlock = (blockId: string) => {
    setSelectedBlockId(blockId);
    setSelectedActionId(null);
    setInspectorMode("block");
    setInspectorOpen(true);
  };

  const selectAction = (actionId: string) => {
    setSelectedActionId(actionId);
    setInspectorMode("action");
    setInspectorOpen(true);
  };

  const setDefinition = (update: (current: CustomAppDefinition) => CustomAppDefinition) => {
    setDiagnostics([]);
    draft.set(update(draft.snapshot()));
  };

  const patchPage = (patch: Partial<CustomAppPage>, preserveDiagnostics = false) => {
    const pageId = selectedPage().id;
    const update = (definition: CustomAppDefinition): CustomAppDefinition => ({
      ...definition,
      pages: definition.pages.map((page) => (page.id === pageId ? { ...page, ...patch } : page)),
    });
    if (preserveDiagnostics) draft.set(update(draft.snapshot()));
    else setDefinition(update);
  };

  const updateSelectedBlock = (update: (block: CustomAppBlock) => CustomAppBlock) => {
    const selected = selectedBlock();
    if (!selected) return;
    draft.updateBlock(selectedPage().id, selected.block.id, update);
  };

  const updateSelectedAction = (update: (action: CustomAppAction | CustomAppRowAction) => CustomAppAction | CustomAppRowAction) => {
    const actionId = selectedActionId();
    if (!actionId) return;
    updateSelectedBlock((block) => {
      if (block.type === "actions") {
        return {
          ...block,
          actions: block.actions.map((action) => {
            if (action.id !== actionId) return action;
            const next = update(action);
            return "showLabel" in next ? action : next;
          }),
        };
      }
      if (block.type === "records" || block.type === "referenced_records") {
        return {
          ...block,
          rowActions: (block.rowActions ?? []).map((action) => {
            if (action.id !== actionId) return action;
            const next = update(action);
            return "showLabel" in next ? next : action;
          }),
        };
      }
      return block;
    });
  };

  const rowsWithAddedBlock = (block: CustomAppBlock): CustomAppPage["rows"] => {
    return appendCustomAppBlockRow(selectedPage().rows, block, {
      rowId: localId("row"),
      columnId: localId("column"),
    });
  };

  const addBlock = (block: CustomAppBlock) => {
    patchPage({ rows: rowsWithAddedBlock(block) });
    selectBlock(block.id);
  };

  const addTextBlock = () => addBlock({ id: localId("markdown"), type: "markdown", markdown: "" });
  const addRecordsBlock = () => {
    const resource = readyViews()[0];
    if (resource) {
      addBlock({
        id: localId("records"),
        type: "records",
        source: { kind: "view", viewId: resource.view.id },
        display: { kind: "table", columnIds: resource.fields.map((field) => field.id) },
        searchable: true,
        pageSize: 25,
      });
      return;
    }
    const source = starterGqlSources().records;
    if (!source) return;
    addBlock({
      id: localId("records"),
      type: "records",
      source,
      display: { kind: "table", columnIds: [] },
      searchable: true,
      pageSize: 25,
    });
  };
  const addReferencedRecordsBlock = () => {
    const candidate = referencedRecordsCandidates()[0];
    const relation = candidate?.relations[0];
    if (!candidate || !relation) return;
    addBlock({
      id: localId("referenced-records"),
      type: "referenced_records",
      sourceTableId: candidate.table.id,
      relationFieldId: relation.id,
      fieldIds: candidate.fields.map((field) => field.id),
      display: { kind: "table" },
      searchable: true,
      pageSize: 25,
    });
  };
  const addFormBlock = () => {
    const form = forms()[0];
    if (!form) return;
    addBlock({ id: localId("form"), type: "form", formId: form.id, fixedValues: {} });
  };
  const addMetricsBlock = () => {
    const source = starterGqlSources().metrics;
    if (source) {
      addBlock({
        id: localId("metrics"),
        type: "metrics",
        source,
      });
      return;
    }
    const view = readyViews()[0]?.view;
    if (view) addBlock({ id: localId("metrics"), type: "metrics", source: { kind: "view", viewId: view.id } });
  };
  const addChartBlock = () => {
    const source = starterGqlSources().chart;
    if (source) {
      addBlock({
        id: localId("chart"),
        type: "chart",
        chartType: "bar",
        limit: 100,
        source,
      });
      return;
    }
    const view = readyViews()[0]?.view;
    if (view) addBlock({ id: localId("chart"), type: "chart", chartType: "bar", limit: 100, source: { kind: "view", viewId: view.id } });
  };
  const pageRecordCandidate = createMemo(() => {
    const entries = Object.entries(selectedPage().parameters);
    const record = selectedPage().record;
    if (record) {
      const parameterId = record.id.path;
      const parameter = selectedPage().parameters[parameterId];
      return parameter ? { parameterId, tableId: parameter.tableId } : null;
    }
    if (selectedPage().id === draft.draft().startPageId) return null;
    if (entries.length === 1) return { parameterId: entries[0]![0], tableId: entries[0]![1].tableId };
    if (entries.length > 1) return null;
    const table = pageRecordTableOptions().find((option) => !option.disabled);
    return table ? { parameterId: "record_id", tableId: table.value } : null;
  });
  const pageRecordFields = createMemo(() => {
    const tableId = pageRecordCandidate()?.tableId;
    return tableId ? (props.catalog.fieldsByTable[tableId] ?? []).filter((field) => field.deletedAt === null).slice(0, 30) : [];
  });
  const pageHtmlFields = createMemo(() => {
    const tableId = pageRecordCandidate()?.tableId;
    return tableId
      ? (props.catalog.fieldsByTable[tableId] ?? []).filter((field) => field.deletedAt === null && field.type === "html_template")
      : [];
  });
  const addableHtmlFields = createMemo(() => {
    const exposed = new Set(customAppPageRecordFieldIds(selectedPage()));
    return exposed.size < 30 ? pageHtmlFields() : pageHtmlFields().filter((field) => exposed.has(field.id));
  });
  const addRecordBlock = () => {
    const candidate = pageRecordCandidate();
    const fields = pageRecordFields();
    if (!candidate || fields.length === 0) return;
    const block: CustomAppBlock = {
      id: localId("record"),
      type: "record",
      fieldIds: fields.map((field) => field.id),
      editableFieldIds: [],
    };
    patchPage({
      parameters: { [candidate.parameterId]: { type: "record", tableId: candidate.tableId, required: true } },
      record: { tableId: candidate.tableId, id: { source: "PARAMS", path: candidate.parameterId } },
      navigation: { ...selectedPage().navigation, visible: false },
      rows: rowsWithAddedBlock(block),
    });
    selectBlock(block.id);
  };
  const addHtmlBlock = () => {
    const candidate = pageRecordCandidate();
    const field = addableHtmlFields()[0];
    if (!candidate || !field) return;
    const block: CustomAppBlock = { id: localId("html"), type: "html", fieldId: field.id, height: "normal" };
    patchPage({
      parameters: { [candidate.parameterId]: { type: "record", tableId: candidate.tableId, required: true } },
      record: { tableId: candidate.tableId, id: { source: "PARAMS", path: candidate.parameterId } },
      navigation: { ...selectedPage().navigation, visible: false },
      rows: rowsWithAddedBlock(block),
    });
    selectBlock(block.id);
  };
  const addCommentsBlock = () => addBlock({ id: localId("comments"), type: "comments" });
  const addActionsBlock = () =>
    addBlock({
      id: localId("actions"),
      type: "actions",
      actions: [
        {
          id: localId("action"),
          label: "Open start page",
          kind: "navigate",
          pageId: draft.draft().startPageId,
          history: "push",
          params: {},
        },
      ],
    });
  const addScannerBlock = () => {
    const launcher = scannerLaunchers()[0];
    if (launcher) addBlock({ id: localId("scanner"), type: "scanner", launcherId: launcher.id });
  };
  const addBlockSections = createMemo<readonly AddBlockSection[]>(() => [
    {
      id: "content",
      label: "Content",
      options: [
        { icon: "ti ti-markdown", label: "Markdown", description: "Add formatted text and context placeholders.", action: addTextBlock },
        readyViews().length > 0 || starterGqlSources().records
          ? { icon: "ti ti-table", label: "Records", description: "Show records from a saved view or GQL query.", action: addRecordsBlock }
          : { icon: "ti ti-table", label: "Records", description: "Create a table with fields first.", disabled: true },
        forms().length > 0
          ? { icon: "ti ti-forms", label: "Form", description: "Embed an active Form.", action: addFormBlock }
          : { icon: "ti ti-forms", label: "Form", description: "Create and activate a Form first.", disabled: true },
      ],
    },
    {
      id: "record-page",
      label: "Record page",
      options: [
        pageRecordCandidate() && pageRecordFields().length > 0
          ? { icon: "ti ti-id", label: "Record", description: "Show fields for the record in this page URL.", action: addRecordBlock }
          : {
              icon: "ti ti-id",
              label: "Record",
              description:
                selectedPage().id === draft.draft().startPageId
                  ? draft.draft().pages.length === 1
                    ? "Create another page and make it the start page first."
                    : "Make another page the start page first."
                  : Object.keys(selectedPage().parameters).length > 1
                    ? "A Record block needs exactly one record parameter."
                    : "Add a table with visible fields first.",
              disabled: true,
            },
        pageRecordCandidate() && addableHtmlFields().length > 0
          ? {
              icon: "ti ti-code",
              label: "Rendered HTML",
              description: "Show one HTML template field for the record in this page URL.",
              action: addHtmlBlock,
            }
          : {
              icon: "ti ti-code",
              label: "Rendered HTML",
              description: "Add an HTML template field to the record table first.",
              disabled: true,
            },
        selectedPage().record && referencedRecordsCandidates().length > 0
          ? {
              icon: "ti ti-table-share",
              label: "Referenced records",
              description: "Show records whose Relation points to this page record.",
              action: addReferencedRecordsBlock,
            }
          : {
              icon: "ti ti-table-share",
              label: "Referenced records",
              description: selectedPage().record
                ? "Add a Relation from another table to this record table first."
                : "This block is available on an existing Record page.",
              disabled: true,
            },
        selectedPage().record
          ? { icon: "ti ti-messages", label: "Comments", description: "Show comments for the page record.", action: addCommentsBlock }
          : { icon: "ti ti-messages", label: "Comments", description: "Add a Record block first.", disabled: true },
      ],
    },
    {
      id: "insights-and-actions",
      label: "Insights and actions",
      options: [
        starterGqlSources().metrics || readyViews().length > 0
          ? { icon: "ti ti-chart-dots", label: "Metrics", description: "Summarize data with aggregate GQL.", action: addMetricsBlock }
          : { icon: "ti ti-chart-dots", label: "Metrics", description: "Create a table with fields first.", disabled: true },
        starterGqlSources().chart || readyViews().length > 0
          ? {
              icon: "ti ti-chart-bar",
              label: "Chart",
              description: "Visualize grouped data from GQL or a saved view.",
              action: addChartBlock,
            }
          : { icon: "ti ti-chart-bar", label: "Chart", description: "Add a groupable field or grouped saved view first.", disabled: true },
        { icon: "ti ti-bolt", label: "Actions", description: "Open another page or run a workflow.", action: addActionsBlock },
        scannerLaunchers().length > 0
          ? {
              icon: "ti ti-scan",
              label: "Scanner",
              description: "Scan QR codes or barcodes and run a workflow.",
              action: addScannerBlock,
            }
          : {
              icon: "ti ti-scan",
              label: "Scanner",
              description: "Create and enable a Scanner run option first.",
              disabled: true,
            },
      ],
    },
  ]);
  const openBlockPicker = () =>
    dialogCore.open<void>(
      (close) => (
        <PanelDialog>
          <PanelDialog.Header title="Choose block type" icon="ti ti-plus" close={() => close()} />
          <PanelDialog.Body>
            <p class="text-sm text-secondary">Choose what this page should show. You can configure it after adding it.</p>
            <div class="flex flex-col gap-5">
              <For each={addBlockSections()}>
                {(section) => (
                  <section aria-labelledby={`custom-app-block-section-${section.id}`}>
                    <h3
                      id={`custom-app-block-section-${section.id}`}
                      class="mb-2 text-xs font-semibold uppercase tracking-wide text-dimmed"
                    >
                      {section.label}
                    </h3>
                    <div class="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      <For each={section.options}>
                        {(option) => (
                          <button
                            type="button"
                            class="paper p-3 text-left transition hover:paper-highlighted disabled:cursor-not-allowed"
                            disabled={option.disabled}
                            onClick={() => {
                              if (option.disabled) return;
                              option.action();
                              close();
                            }}
                          >
                            <div class="flex items-start gap-3">
                              <span class="thumbnail flex h-8 w-8 shrink-0 items-center justify-center bg-[var(--ui-surface-subtle)]">
                                <i
                                  class={`${option.icon} text-base text-dimmed ${option.disabled ? "opacity-50" : ""}`}
                                  aria-hidden="true"
                                />
                              </span>
                              <div class="min-w-0">
                                <div class={`text-sm font-semibold ${option.disabled ? "text-dimmed" : "text-primary"}`}>
                                  {option.label}
                                </div>
                                <p
                                  class={`mt-1 text-xs leading-snug ${option.disabled ? "text-[var(--k2b-warning-text)]" : "text-dimmed"}`}
                                >
                                  {option.description}
                                </p>
                              </div>
                            </div>
                          </button>
                        )}
                      </For>
                    </div>
                  </section>
                )}
              </For>
            </div>
          </PanelDialog.Body>
        </PanelDialog>
      ),
      panelDialogOptions,
    );

  const newLayoutIds = (): CustomAppLayoutIds => ({
    rowIds: [localId("row"), localId("row")],
    columnIds: [localId("column"), localId("column"), localId("column")],
  });
  const blockDnd = dnd.create<CustomAppBlockDragMeta, CustomAppBlockDropMeta, CustomAppBlockDropIntent>({
    collisionDetector: ({ droppables, pointer, previousOverId }) => selectCustomAppBlockDropTarget(droppables, pointer, previousOverId),
    buildIntent: ({ over }) => over?.meta.intent ?? null,
    isSameIntent: sameCustomAppBlockDropIntent,
    onDragStart: ({ active }) => selectBlock(active.meta.blockId),
    announcements: {
      dragStart: (active) => `Picked up ${active.meta.label} block.`,
      dragOver: (active, over) => (over ? `Move ${active.meta.label} ${over.meta.label}.` : `${active.meta.label} has no drop target.`),
      drop: (active, over) => (over ? `Moved ${active.meta.label} ${over.meta.label}.` : `${active.meta.label} was not moved.`),
      cancel: (active) => `Cancelled moving ${active.meta.label}.`,
    },
    onDrop: ({ active, over, intent }) => {
      if (!over || !intent) return;
      const next = applyCustomAppBlockDrop(selectedPage(), active.meta.blockId, intent, newLayoutIds());
      if (next === selectedPage()) return;
      patchPage({ rows: next.rows });
      selectBlock(active.meta.blockId);
    },
  });

  const moveSelectedBlock = (direction: -1 | 1) => {
    const selected = selectedBlock();
    if (!selected) return;
    const nextIndex = selected.blockIndex + direction;
    if (nextIndex < 0 || nextIndex >= selected.column.blocks.length) return;
    const target = selected.column.blocks[nextIndex]!;
    const next = applyCustomAppBlockDrop(
      selectedPage(),
      selected.block.id,
      { kind: "stack", targetBlockId: target.id, edge: direction < 0 ? "before" : "after" },
      newLayoutIds(),
    );
    if (next !== selectedPage()) patchPage({ rows: next.rows });
  };

  const removeSelectedBlock = async () => {
    const selected = selectedBlock();
    if (!selected || blockCount() === 1) return;
    const removingLastRecord =
      (selected.block.type === "record" || selected.block.type === "html") &&
      !selectedPage().rows.some((row) =>
        row.columns.some((column) =>
          column.blocks.some((block) => (block.type === "record" || block.type === "html") && block.id !== selected.block.id),
        ),
      );
    const confirmed = await prompts.confirm(
      removingLastRecord
        ? "Remove the last record content block? Comments blocks on this page will also be removed."
        : `Remove "${selected.block.title || blockMeta[selected.block.type].label}" from this page?`,
      {
        title: "Remove block",
        icon: "ti ti-trash",
        confirmText: "Remove",
        variant: "danger",
      },
    );
    if (!confirmed) return;
    const page = normalizeCustomAppPageLayout({
      ...selectedPage(),
      rows: selectedPage().rows.map((row) => ({
        ...row,
        columns: row.columns.map((column) => ({
          ...column,
          blocks: column.blocks.filter((block) => block.id !== selected.block.id && (!removingLastRecord || block.type !== "comments")),
        })),
      })),
    });
    patchPage({ rows: page.rows, ...(removingLastRecord ? { record: undefined } : {}) });
    setSelectedBlockId(null);
  };

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveQueued = false;
  let activeSave: Promise<boolean> | null = null;
  const drainQueuedDrafts = async (): Promise<boolean> => {
    let successful = true;
    while (saveQueued) {
      saveQueued = false;
      const version = draft.version();
      const definition = draft.snapshot();
      setSaveState("saving");
      setSaveError(null);
      try {
        const response: Response = await apiClient.apps[":appId"].draft.$put({ param: { appId: app().id }, json: { definition } });
        if (!response.ok) throw new Error(await errorMessage(response, "Could not save the App draft."));
        const saved: PublicCustomAppDraftSave = await response.json();
        if (!saved.app.draftDefinition) {
          throw new Error(saved.app.draftDiagnostics[0]?.message ?? "The saved draft is not a valid schema v5 definition.");
        }
        setApp(saved.app);
        setDiagnostics(saved.diagnostics);
        draft.markSaved(saved.app.draftDefinition);
        setSaveState(saved.valid ? "saved" : "invalid");
        setSaveError(saved.valid ? null : "The draft was saved, but it must be fixed before it can be published.");
        if (draft.version() !== version) saveQueued = true;
      } catch (error) {
        setSaveState("error");
        setSaveError(error instanceof Error ? error.message : "Could not save the App draft.");
        successful = false;
        break;
      }
    }
    return successful;
  };
  const persistQueuedDrafts = (): Promise<boolean> => {
    if (activeSave) return activeSave;
    activeSave = drainQueuedDrafts().finally(() => {
      activeSave = null;
    });
    return activeSave;
  };

  const queueAutosave = () => {
    saveQueued = true;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => void persistQueuedDrafts(), 650);
  };

  createEffect(() => {
    draft.version();
    if (draft.dirty()) queueAutosave();
  });
  onCleanup(() => saveTimer && clearTimeout(saveTimer));

  const flushAutosave = async () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    if (draft.dirty()) saveQueued = true;
    return persistQueuedDrafts();
  };

  const openWorkflowConfiguration = async (workflowId?: string) => {
    if (!(await flushAutosave())) {
      await prompts.error("Save the current App draft before leaving the builder.");
      return;
    }
    const workflow = (workflowId ? workflowsById().get(workflowId) : null) ?? props.catalog.workflows[0];
    if (workflow) {
      window.location.assign(`/app/grids/${encodeURIComponent(props.baseId)}/workflows/${encodeURIComponent(workflow.id)}?edit=true`);
      return;
    }
    await dialogCore.open<void>(
      (close) => (
        <WorkflowEditor
          baseId={draft.draft().baseId}
          tables={props.catalog.tables}
          onChanged={(created) => {
            if (!created) return;
            window.location.assign(`/app/grids/${encodeURIComponent(props.baseId)}/workflows/${encodeURIComponent(created.id)}?edit=true`);
          }}
          onClose={close}
        />
      ),
      { ...panelDialogWorkspaceOptions, cancelBehavior: "ignore" },
    );
  };

  const stopAutosave = async () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = undefined;
    saveQueued = false;
    if (activeSave) await activeSave;
    saveQueued = false;
  };

  const publishMutation = mutations.create<PublicCustomApp, void>({
    mutation: async (_, { abortSignal }) => {
      if (!(await flushAutosave())) throw new Error("The latest changes could not be saved.");
      const response = await apiClient.apps[":appId"].publish.$post({ param: { appId: app().id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not publish the App."));
      return (await response.json()) as PublicCustomApp;
    },
    onSuccess: (published) => {
      if (!published.draftDefinition) {
        prompts.error(published.draftDiagnostics[0]?.message ?? "The published draft is not a valid schema v5 definition.");
        return;
      }
      setApp(published);
      draft.markSaved(published.draftDefinition);
      prompts.success("App published.");
    },
    onError: (error) => prompts.error(error.message),
  });

  const addPage = () => {
    const page = newPage(draft.draft());
    setDefinition((definition) => ({ ...definition, pages: [...definition.pages, page] }));
    selectPage(page.id);
  };

  const moveStartPageAwayFromSelected = () => {
    const existing = alternateStartPage();
    if (existing) {
      setDefinition((definition) => ({ ...definition, startPageId: existing.id }));
      return;
    }
    const page = { ...newPage(draft.draft()), title: "Home" };
    setDefinition((definition) => ({ ...definition, startPageId: page.id, pages: [...definition.pages, page] }));
  };

  const addRecordPageForSelectedSource = () => {
    const tableId = selectedSourceTableId();
    const sourceBlock = selectedRecordsBlock();
    const table = tableId ? tablesById().get(tableId) : null;
    const fields = selectedSourceRecordFields();
    if (!tableId || !sourceBlock || !table || fields.length === 0) return;

    const page = newPage(draft.draft());
    const recordBlock: Extract<CustomAppBlock, { type: "record" }> = {
      id: localId("record"),
      type: "record",
      fieldIds: fields.map((field) => field.id),
      editableFieldIds: [],
    };
    const recordPage: CustomAppPage = {
      ...page,
      title: `${table.name} details`,
      navigation: { ...page.navigation, visible: false },
      parameters: { record_id: { type: "record", tableId, required: true } },
      record: { tableId, id: { source: "PARAMS", path: "record_id" } },
      rows: page.rows.map((row, rowIndex) => ({
        ...row,
        columns: row.columns.map((column, columnIndex) => ({
          ...column,
          blocks: rowIndex === 0 && columnIndex === 0 ? [recordBlock] : column.blocks,
        })),
      })),
    };
    const sourcePageId = selectedPage().id;
    setDefinition((definition) => ({
      ...definition,
      pages: [
        ...definition.pages.map((candidate) =>
          candidate.id !== sourcePageId
            ? candidate
            : {
                ...candidate,
                rows: candidate.rows.map((row) => ({
                  ...row,
                  columns: row.columns.map((column) => ({
                    ...column,
                    blocks: column.blocks.map((block) =>
                      block.id === sourceBlock.id && block.type === "records"
                        ? {
                            ...block,
                            rowNavigate: {
                              kind: "navigate" as const,
                              pageId: recordPage.id,
                              history: "push" as const,
                              params: { record_id: { source: "ROW" as const, path: "id" as const } },
                            },
                          }
                        : block,
                    ),
                  })),
                })),
              },
        ),
        recordPage,
      ],
    }));
    selectPage(recordPage.id);
    selectBlock(recordBlock.id);
  };

  const moveSelectedPage = (direction: -1 | 1) =>
    setDefinition((definition) => moveCustomAppPage(definition, selectedPage().id, direction));

  const renameSelectedPage = (nextId: string) => {
    const currentId = selectedPage().id;
    if (nextId === currentId || !/^[a-z][a-z0-9-]{0,79}$/.test(nextId) || draft.draft().pages.some((page) => page.id === nextId)) return;
    setDefinition((definition) => renameCustomAppPage(definition, currentId, nextId));
    setSelectedPageId(nextId);
  };

  const nextParameterId = () => {
    const parameters = selectedPage().parameters;
    if (!parameters.record_id) return "record_id";
    let index = 2;
    while (parameters[`record_${index}`]) index += 1;
    return `record_${index}`;
  };

  const addPageParameter = () => {
    if (selectedPage().id === draft.draft().startPageId) return;
    const table = props.catalog.tables[0];
    if (!table) return;
    const id = nextParameterId();
    patchPage({
      parameters: { ...selectedPage().parameters, [id]: { type: "record", tableId: table.id, required: true } },
      navigation: { ...selectedPage().navigation, visible: false },
    });
  };

  const renamePageParameter = (from: string, to: string) => {
    if (from === to || !/^[a-z][a-z0-9_]{0,79}$/.test(to) || selectedPage().parameters[to]) return;
    setDefinition((definition) => renameCustomAppPageParameter(definition, selectedPage().id, from, to));
  };

  const updatePageParameterTable = (parameterId: string, tableId: string) => {
    const isPageRecord = selectedPage().record?.id.path === parameterId;
    const availableFields = (props.catalog.fieldsByTable[tableId] ?? []).filter((field) => field.deletedAt === null);
    const fields = availableFields.slice(0, 30);
    const htmlField = availableFields.find((field) => field.type === "html_template");
    patchPage({
      parameters: { ...selectedPage().parameters, [parameterId]: { type: "record", tableId, required: true } },
      ...(isPageRecord
        ? {
            record: { tableId, id: { source: "PARAMS" as const, path: parameterId } },
            rows: selectedPage().rows.map((row) => ({
              ...row,
              columns: row.columns.map((column) => ({
                ...column,
                blocks: column.blocks.map((block) =>
                  block.type === "record"
                    ? { ...block, fieldIds: fields.map((field) => field.id), editableFieldIds: [], documents: undefined }
                    : block.type === "html" && htmlField
                      ? { ...block, fieldId: htmlField.id }
                      : block,
                ),
              })),
            })),
          }
        : {}),
    });
  };

  const removePageParameter = async (parameterId: string) => {
    if (selectedPage().record?.id.path !== parameterId) {
      setDefinition((definition) => removeCustomAppPageParameter(definition, selectedPage().id, parameterId));
      return;
    }
    const confirmed = await prompts.confirm(
      "Remove this record parameter? Its Record, Rendered HTML, and Comments blocks will also be removed.",
      {
        title: "Remove record parameter",
        icon: "ti ti-unlink",
        confirmText: "Remove parameter",
        variant: "danger",
      },
    );
    if (!confirmed) return;
    patchPage({
      parameters: Object.fromEntries(Object.entries(selectedPage().parameters).filter(([id]) => id !== parameterId)),
      record: undefined,
      rows: selectedPage().rows.map((row) => ({
        ...row,
        columns: row.columns.map((column) => {
          const blocks = column.blocks.filter((block) => block.type !== "record" && block.type !== "html" && block.type !== "comments");
          return {
            ...column,
            blocks: blocks.length > 0 ? blocks : [{ id: localId("markdown"), type: "markdown" as const, markdown: "" }],
          };
        }),
      })),
    });
  };

  const addNavigateAction = () => {
    const page = draft.draft().pages.find((candidate) => Object.keys(candidate.parameters).length === 0) ?? draft.draft().pages[0]!;
    const action: CustomAppAction = {
      id: localId("action"),
      label: `Open ${page.title}`,
      kind: "navigate",
      pageId: page.id,
      history: "push",
      params: {},
    };
    updateSelectedBlock((block) => (block.type === "actions" ? { ...block, actions: [...block.actions, action] } : block));
    selectAction(action.id);
  };

  const defaultNavigationParams = (pageId: string): Extract<CustomAppAction, { kind: "navigate" }>["params"] => {
    const target = draft.draft().pages.find((page) => page.id === pageId);
    if (!target) return {};
    const params: Extract<CustomAppAction, { kind: "navigate" }>["params"] = {};
    for (const [parameterId, parameter] of Object.entries(target.parameters)) {
      if (selectedPage().record?.tableId === parameter.tableId) {
        params[parameterId] = { source: "RECORD", path: "id" };
        continue;
      }
      const sourceParameter = Object.entries(selectedPage().parameters).find(([, value]) => value.tableId === parameter.tableId)?.[0];
      if (sourceParameter) params[parameterId] = { source: "PARAMS", path: sourceParameter };
    }
    return params;
  };

  const defaultFormSuccessParams = (
    formId: string,
    pageId: string,
  ): NonNullable<Extract<CustomAppBlock, { type: "form" }>["onSuccessNavigate"]>["params"] => {
    const target = draft.draft().pages.find((page) => page.id === pageId);
    const form = formsById().get(formId);
    const params: NonNullable<Extract<CustomAppBlock, { type: "form" }>["onSuccessNavigate"]>["params"] = {};
    if (!target) return params;
    for (const [parameterId, parameter] of Object.entries(target.parameters)) {
      if (form?.tableId === parameter.tableId) {
        params[parameterId] = { source: "RESULT", path: "recordId" };
        continue;
      }
      const sourceParameter = Object.entries(selectedPage().parameters).find(
        ([, candidate]) => candidate.tableId === parameter.tableId,
      )?.[0];
      if (sourceParameter) params[parameterId] = { source: "PARAMS", path: sourceParameter };
    }
    return params;
  };

  const addWorkflowAction = () => {
    const launcher = workflowLaunchers()[0];
    if (!launcher) return;
    const action: CustomAppAction = {
      id: localId("action"),
      label: launcher.config.kind === "customApp" && launcher.config.label ? launcher.config.label : launcher.name,
      kind: "workflow",
      launcherId: launcher.id,
      inputs: {},
    };
    updateSelectedBlock((block) => (block.type === "actions" ? { ...block, actions: [...block.actions, action] } : block));
    selectAction(action.id);
  };

  const addRowWorkflowAction = () => {
    const launcher = preferredRowWorkflowLauncher();
    if (!launcher) return;
    const action: CustomAppRowAction = {
      id: localId("row-action"),
      label: launcher.config.label || launcher.name,
      showLabel: true,
      kind: "workflow",
      launcherId: launcher.id,
      inputs: defaultRowWorkflowInputs(launcher),
    };
    updateSelectedBlock((block) =>
      block.type === "records" || block.type === "referenced_records"
        ? { ...block, rowActions: [...(block.rowActions ?? []), action] }
        : block,
    );
    selectAction(action.id);
  };

  const moveSelectedAction = (direction: -1 | 1) => {
    const selected = selectedAction();
    if (!selected) return;
    updateSelectedBlock((block) => {
      if (selected.owner === "actions" && block.type === "actions") {
        const target = selected.index + direction;
        if (target < 0 || target >= block.actions.length) return block;
        const actions = [...block.actions];
        [actions[selected.index], actions[target]] = [actions[target]!, actions[selected.index]!];
        return { ...block, actions };
      }
      if (selected.owner !== "rows" || (block.type !== "records" && block.type !== "referenced_records")) return block;
      const source = block.rowActions ?? [];
      const target = selected.index + direction;
      if (target < 0 || target >= source.length) return block;
      const actions = [...source];
      [actions[selected.index], actions[target]] = [actions[target]!, actions[selected.index]!];
      return { ...block, rowActions: actions };
    });
  };

  const removeSelectedAction = async () => {
    const selected = selectedAction();
    if (!selected) return;
    const count =
      selected.owner === "actions" ? (selectedActionsBlock()?.actions.length ?? 0) : (selectedRecordsLikeBlock()?.rowActions?.length ?? 0);
    if (selected.owner === "actions" && count <= 1) return;
    const confirmed = await prompts.confirm(`Remove "${selected.action.label}"?`, {
      title: "Remove action",
      icon: "ti ti-trash",
      confirmText: "Remove",
      variant: "danger",
    });
    if (!confirmed) return;
    updateSelectedBlock((candidate) =>
      selected.owner === "actions" && candidate.type === "actions"
        ? { ...candidate, actions: candidate.actions.filter((action) => action.id !== selected.action.id) }
        : selected.owner === "rows" && (candidate.type === "records" || candidate.type === "referenced_records")
          ? { ...candidate, rowActions: (candidate.rowActions ?? []).filter((action) => action.id !== selected.action.id) }
          : candidate,
    );
    setSelectedActionId(null);
    setInspectorMode("block");
  };

  const removePage = async () => {
    const definition = draft.draft();
    if (definition.pages.length === 1) return;
    const page = selectedPage();
    const confirmed = await prompts.confirm(`Remove "${page.title}" from this app?`, {
      title: "Remove page",
      icon: "ti ti-trash",
      confirmText: "Remove",
      variant: "danger",
    });
    if (!confirmed) return;
    const pages = definition.pages.filter((candidate) => candidate.id !== page.id);
    const nextPage = pages[0]!;
    setDefinition((current) => ({
      ...current,
      pages,
      startPageId: current.startPageId === page.id ? nextPage.id : current.startPageId,
    }));
    selectPage(nextPage.id);
  };

  const restoreMutation = mutations.create<PublicCustomApp, void>({
    mutation: async (_, { abortSignal }) => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = undefined;
      if (activeSave) await activeSave;
      saveQueued = false;
      const response = await apiClient.apps[":appId"].restore.$post({ param: { appId: app().id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorMessage(response, "Could not restore the live version."));
      return (await response.json()) as PublicCustomApp;
    },
    onSuccess: (restored) => {
      if (!restored.draftDefinition) {
        prompts.error(restored.draftDiagnostics[0]?.message ?? "The live version is not a valid schema v5 definition.");
        return;
      }
      saveQueued = false;
      setApp(restored);
      draft.replace(restored.draftDefinition);
      setDiagnostics([]);
      setSaveError(null);
      setSaveState("saved");
      selectPage(restored.draftDefinition.startPageId);
      prompts.success("Draft restored to the live version.");
    },
    onError: (error) => prompts.error(error.message),
  });

  const confirmRestoreLiveVersion = async () => {
    const confirmed = await prompts.confirm(
      "Discard every autosaved draft change and replace it with the current live version? This cannot be undone.",
      {
        title: "Restore live version",
        icon: "ti ti-restore",
        confirmText: "Discard draft changes",
        variant: "danger",
      },
    );
    if (confirmed) restoreMutation.mutate(undefined);
  };

  return (
    <>
      <AppWorkspace.Main class="p-0" mobilePane="main" scroll={false}>
        <AppWorkspace.MainPane
          id="custom-app-pages"
          label="App pages"
          surface="navigation"
          defaultSize={280}
          minSize={220}
          maxSize={420}
          class="flex min-h-0 flex-col"
          scroll={false}
        >
          <Toolbar label="App pages" class="p-2" wrap>
            <Toolbar.Group>
              <strong class="px-1 text-sm">Pages</strong>
            </Toolbar.Group>
            <Toolbar.Spacer />
            <Show when={app().publishedAt}>
              <Toolbar.Group>
                <ButtonLink href={`/apps/${app().id}`} target="_blank" rel="noreferrer" size="xs" aria-label="Open live app">
                  <i class="ti ti-external-link" aria-hidden="true" />
                </ButtonLink>
              </Toolbar.Group>
            </Show>
          </Toolbar>
          <AppWorkspace.SidebarBody class="p-2" scrollPreserveKey={`grids-custom-app-pages-${props.app.id}`}>
            <AppWorkspace.SidebarSection>
              <For each={draft.draft().pages}>
                {(page) => (
                  <AppWorkspace.SidebarItem active={selectedPage().id === page.id} onClick={() => selectPage(page.id)}>
                    <AppWorkspace.SidebarItemIcon icon={page.navigation.visible ? "ti ti-file" : "ti ti-file-off"} />
                    <AppWorkspace.SidebarItemLabel>{page.title}</AppWorkspace.SidebarItemLabel>
                    {draft.draft().startPageId === page.id && (
                      <AppWorkspace.SidebarItemMeta>
                        <span class="text-[9px] uppercase tracking-wider text-dimmed">start</span>
                      </AppWorkspace.SidebarItemMeta>
                    )}
                    <Show when={props.editMode}>
                      <AppWorkspace.SidebarItemAction
                        icon="ti ti-settings"
                        label={`Settings for ${page.title}`}
                        onSelect={() => selectPage(page.id)}
                      />
                    </Show>
                  </AppWorkspace.SidebarItem>
                )}
              </For>
              <Show when={props.editMode}>
                <AppWorkspace.SidebarItem
                  tone="success"
                  onClick={addPage}
                  disabled={draft.draft().pages.length >= 12}
                  title={draft.draft().pages.length >= 12 ? "Apps support up to 12 pages." : "Add a page"}
                >
                  <AppWorkspace.SidebarItemIcon icon="ti ti-plus" />
                  <AppWorkspace.SidebarItemLabel>New page</AppWorkspace.SidebarItemLabel>
                  <Show when={draft.draft().pages.length >= 12}>
                    <AppWorkspace.SidebarItemMeta>12 / 12</AppWorkspace.SidebarItemMeta>
                  </Show>
                </AppWorkspace.SidebarItem>
              </Show>
            </AppWorkspace.SidebarSection>
            <Show when={sidebarActions().length > 0 || props.editMode}>
              <AppWorkspace.SidebarSection title="Actions">
                <For each={sidebarActions()}>
                  {(action) => (
                    <AppWorkspace.SidebarItem
                      icon={`ti ti-${action.icon ?? "forms"}`}
                      tone={action.tone}
                      onClick={
                        props.editMode
                          ? () => {
                              setInspectorMode("app");
                              setInspectorOpen(true);
                            }
                          : undefined
                      }
                    >
                      <AppWorkspace.SidebarItemLabel>{action.label}</AppWorkspace.SidebarItemLabel>
                      <AppWorkspace.SidebarItemMeta>Form</AppWorkspace.SidebarItemMeta>
                      <Show when={props.editMode}>
                        <AppWorkspace.SidebarItemAction
                          icon="ti ti-settings"
                          label={`Settings for ${action.label}`}
                          onSelect={() => {
                            setInspectorMode("app");
                            setInspectorOpen(true);
                          }}
                        />
                      </Show>
                    </AppWorkspace.SidebarItem>
                  )}
                </For>
                <Show when={props.editMode}>
                  <AppWorkspace.SidebarItem
                    tone="success"
                    onClick={addSidebarForm}
                    disabled={forms().length === 0 || sidebarActions().length >= 12}
                    title={
                      forms().length === 0
                        ? "Create an active Form first."
                        : sidebarActions().length >= 12
                          ? "Apps support up to 12 global actions."
                          : "Add a global Form action"
                    }
                  >
                    <AppWorkspace.SidebarItemIcon icon="ti ti-plus" />
                    <AppWorkspace.SidebarItemLabel>New action</AppWorkspace.SidebarItemLabel>
                    <Show when={sidebarActions().length >= 12}>
                      <AppWorkspace.SidebarItemMeta>12 / 12</AppWorkspace.SidebarItemMeta>
                    </Show>
                  </AppWorkspace.SidebarItem>
                </Show>
              </AppWorkspace.SidebarSection>
            </Show>
          </AppWorkspace.SidebarBody>
          <Show
            when={
              props.editMode &&
              (!app().publishedAt || app().hasUnpublishedChanges || draft.dirty() || saveState() === "error" || saveState() === "invalid")
            }
          >
            <AppWorkspace.SidebarFooter class="p-2">
              <NoticeCard
                tone={saveState() === "error" || saveState() === "invalid" ? "danger" : "warning"}
                title={app().publishedAt ? "Changes are in a draft" : "This app is a draft"}
                detail={
                  saveState() === "saving"
                    ? "Saving changes automatically…"
                    : (saveError() ?? "Changes are saved automatically. Publish the draft when it is ready for everyone.")
                }
              >
                <div class="flex flex-wrap gap-2">
                  <Show when={app().publishedAt}>
                    <Button
                      size="xs"
                      variant="secondary"
                      loading={restoreMutation.loading()}
                      disabled={publishMutation.loading()}
                      onClick={() => void confirmRestoreLiveVersion()}
                    >
                      Restore live version
                    </Button>
                  </Show>
                  <Button
                    size="xs"
                    loading={publishMutation.loading()}
                    disabled={restoreMutation.loading() || saveState() === "invalid" || saveState() === "error"}
                    onClick={() => publishMutation.mutate(undefined)}
                  >
                    Publish changes
                  </Button>
                </div>
              </NoticeCard>
            </AppWorkspace.SidebarFooter>
          </Show>
        </AppWorkspace.MainPane>

        <section class="flex min-h-0 min-w-0 flex-1 flex-col bg-base" aria-label="App canvas">
          <div class="min-h-0 flex-1 overflow-auto bg-[var(--ui-surface)]">
            <CustomAppPageLayout
              definition={draft.draft()}
              page={selectedPage()}
              appId={app().id}
              showSidebar={false}
              editor={
                props.editMode
                  ? {
                      selectedBlockId,
                      onSelectBlock: selectBlock,
                      onSelectPage: selectPage,
                      dnd: blockDnd,
                      addBlockControl: (
                        <div class="flex justify-center">
                          <Button size="md" variant="success" onClick={() => void openBlockPicker()}>
                            <i class="ti ti-plus" aria-hidden="true" /> Add block
                          </Button>
                        </div>
                      ),
                    }
                  : undefined
              }
              renderBlock={(block) => (
                <CustomAppBlockPreview
                  block={block}
                  baseId={draft.draft().baseId}
                  appId={app().id}
                  catalog={props.catalog}
                  markdownInlineTokens={props.editMode ? markdownInlineTokens() : undefined}
                  dateConfig={props.dateConfig}
                  onPreviewResult={(blockId, result) => setPreviewResults((current) => ({ ...current, [blockId]: result }))}
                />
              )}
            />
          </div>
        </section>
      </AppWorkspace.Main>

      <AppWorkspace.Detail
        id="custom-app-inspector"
        open={props.editMode && inspectorOpen()}
        width="md"
        resizable={props.editMode}
        minWidth={280}
        maxWidth={520}
      >
        <DetailPanel>
          <DetailPanel.Header
            icon={
              inspectorMode() === "action"
                ? selectedAction()?.action.kind === "workflow"
                  ? "ti ti-player-play"
                  : "ti ti-link"
                : inspectorMode() === "block"
                  ? blockMeta[selectedBlock()?.block.type ?? "markdown"].icon
                  : inspectorMode() === "app"
                    ? "ti ti-app-window"
                    : "ti ti-file-settings"
            }
            title={
              inspectorMode() === "action"
                ? (selectedAction()?.action.label ?? "Action")
                : inspectorMode() === "block"
                  ? selectedBlock()?.block.title || blockMeta[selectedBlock()?.block.type ?? "markdown"].label
                  : inspectorMode() === "app"
                    ? "App settings"
                    : selectedPage().title
            }
            subtitle={
              inspectorMode() === "action"
                ? "Action settings"
                : inspectorMode() === "block"
                  ? "Content block"
                  : inspectorMode() === "app"
                    ? draft.draft().name
                    : "Page settings"
            }
            actions={
              <IconButton size="sm" label="Close inspector" onClick={() => setInspectorOpen(false)}>
                <i class="ti ti-x" aria-hidden="true" />
              </IconButton>
            }
          />
          <DetailPanel.Body
            scrollPreserveKey={`grids-custom-app-inspector-${app().id}-${inspectorMode()}-${selectedActionId() ?? selectedBlockId() ?? selectedPage().id}`}
          >
            <Show when={panelDiagnostics().length > 0}>
              <NoticeCard tone="danger" icon={false} role="alert">
                <p class="font-medium">This draft needs attention</p>
                <ul class="mt-2 list-disc space-y-1 pl-4 text-sm">
                  <For each={panelDiagnostics()}>{(diagnostic) => <li>{diagnostic.message}</li>}</For>
                </ul>
              </NoticeCard>
            </Show>
            <Show when={inspectorMode() === "app"}>
              <DetailPanel.Group label="App settings">
                <DetailPanel.Section title="Identity" icon="ti ti-app-window" tone="accent">
                  <div class="flex flex-col gap-3">
                    <TextInput
                      label="Name"
                      value={() => draft.draft().name}
                      onValueChange={(name) => setDefinition((definition) => ({ ...definition, name }))}
                      required
                    />
                    <IconInput
                      label="Icon"
                      value={() => iconInputValue(draft.draft().icon)}
                      onValueChange={(value) => setDefinition((definition) => ({ ...definition, icon: iconSlug(value) }))}
                      clearable
                    />
                  </div>
                </DetailPanel.Section>
                <DetailPanel.Section
                  title="App sidebar"
                  icon="ti ti-layout-sidebar-left"
                  description="Add app-wide Forms. They do not receive page, route, record, or row values."
                  collapsible
                  defaultOpen={sidebarActions().length > 0}
                >
                  <div class="flex flex-col gap-4">
                    <InlineGuidance>
                      Pages appear automatically. These launchers stay available while readers move through the app; availability can use
                      auth, app, Base, and time context.
                    </InlineGuidance>
                    <For each={sidebarActions()}>
                      {(sidebarAction) => {
                        const selectedForm = () => formsById().get(sidebarAction.formId);
                        return (
                          <div class="rounded-xl border border-subtle bg-surface p-3">
                            <div class="flex flex-col gap-3">
                              <div class="flex items-center gap-2">
                                <strong class="min-w-0 flex-1 truncate text-sm">{sidebarAction.label}</strong>
                                <StatusBadge tone="neutral" label="Form" variant="text" />
                                <IconButton
                                  size="sm"
                                  label={`Remove ${sidebarAction.label}`}
                                  onClick={() => removeSidebarAction(sidebarAction.id)}
                                >
                                  <i class="ti ti-trash" aria-hidden="true" />
                                </IconButton>
                              </div>
                              <TextInput
                                label="Label"
                                value={() => sidebarAction.label}
                                onValueChange={(label) => updateSidebarAction(sidebarAction.id, (action) => ({ ...action, label }))}
                                required
                              />
                              <div class="grid gap-3 sm:grid-cols-2">
                                <IconInput
                                  label="Icon"
                                  value={() => iconInputValue(sidebarAction.icon)}
                                  onValueChange={(value) =>
                                    updateSidebarAction(sidebarAction.id, (action) => ({ ...action, icon: iconSlug(value) }))
                                  }
                                  clearable
                                />
                                <Select
                                  label="Tone"
                                  value={() => sidebarAction.tone}
                                  options={[
                                    { id: "default", label: "Default" },
                                    { id: "success", label: "Positive" },
                                    { id: "danger", label: "Danger" },
                                  ]}
                                  onValueChange={(tone) =>
                                    (tone === "default" || tone === "success" || tone === "danger") &&
                                    updateSidebarAction(sidebarAction.id, (action) => ({ ...action, tone }))
                                  }
                                />
                              </div>
                              <Show when={sidebarAction.kind === "form"}>
                                <Select
                                  label="Form"
                                  searchable
                                  value={() => (sidebarAction.kind === "form" ? sidebarAction.formId : null)}
                                  options={formOptions()}
                                  onValueChange={(formId) =>
                                    formId &&
                                    updateSidebarAction(sidebarAction.id, (action) =>
                                      action.kind === "form"
                                        ? { ...action, formId, fixedValues: {}, onSuccessNavigate: undefined }
                                        : action,
                                    )
                                  }
                                />
                                <For each={sidebarAction.kind === "form" ? formBindingOptions(sidebarAction.formId) : []}>
                                  {(binding) => {
                                    const current = () =>
                                      sidebarAction.kind === "form" ? sidebarAction.fixedValues[binding.field.id] : undefined;
                                    const literal = () => {
                                      const value = current();
                                      return value?.source === "LITERAL" ? value : null;
                                    };
                                    return (
                                      <div class="flex flex-col gap-2">
                                        <Select
                                          label={binding.label}
                                          description="Hide this input and inject one trusted value on the server."
                                          placeholder="Ask in Form"
                                          clearable
                                          value={() => current()?.source ?? null}
                                          options={[
                                            { id: "LITERAL", label: "Fixed value" },
                                            ...(binding.field.type === "principal"
                                              ? [{ id: "AUTH", label: "Current signed-in user" }]
                                              : []),
                                          ]}
                                          onValueChange={(source) =>
                                            updateSidebarAction(sidebarAction.id, (action) => {
                                              if (action.kind !== "form") return action;
                                              const fixedValues = { ...action.fixedValues };
                                              if (!source) delete fixedValues[binding.field.id];
                                              else if (source === "AUTH") {
                                                fixedValues[binding.field.id] = { source: "AUTH", path: "currentUser" };
                                              } else fixedValues[binding.field.id] = { source: "LITERAL", value: null };
                                              return { ...action, fixedValues };
                                            })
                                          }
                                        />
                                        <Show when={literal()}>
                                          {(value) => (
                                            <JsonValueInput
                                              label={`${binding.label} value`}
                                              value={value().value}
                                              onValueChange={(next) =>
                                                updateSidebarAction(sidebarAction.id, (action) =>
                                                  action.kind === "form"
                                                    ? {
                                                        ...action,
                                                        fixedValues: {
                                                          ...action.fixedValues,
                                                          [binding.field.id]: { source: "LITERAL", value: next },
                                                        },
                                                      }
                                                    : action,
                                                )
                                              }
                                            />
                                          )}
                                        </Show>
                                      </div>
                                    );
                                  }}
                                </For>
                                <Select
                                  label="After submission"
                                  description="Optionally open a record page for the newly created record."
                                  placeholder="Stay on the current page"
                                  clearable
                                  value={() => (sidebarAction.kind === "form" ? (sidebarAction.onSuccessNavigate?.pageId ?? null) : null)}
                                  options={draft
                                    .draft()
                                    .pages.filter((page) => {
                                      const form = selectedForm();
                                      return (
                                        form && Object.values(page.parameters).every((parameter) => parameter.tableId === form.tableId)
                                      );
                                    })
                                    .map((page) => ({ id: page.id, label: page.title }))}
                                  onValueChange={(pageId) =>
                                    updateSidebarAction(sidebarAction.id, (action) => {
                                      if (action.kind !== "form") return action;
                                      const page = pageId ? draft.draft().pages.find((candidate) => candidate.id === pageId) : undefined;
                                      return {
                                        ...action,
                                        onSuccessNavigate: page
                                          ? {
                                              kind: "navigate",
                                              pageId: page.id,
                                              params: Object.fromEntries(
                                                Object.keys(page.parameters).map((parameterId) => [
                                                  parameterId,
                                                  { source: "RESULT" as const, path: "recordId" as const },
                                                ]),
                                              ),
                                            }
                                          : undefined,
                                      };
                                    })
                                  }
                                />
                              </Show>
                              <CustomAppAvailabilitySection
                                baseId={draft.draft().baseId}
                                contextKeys={customAppGlobalContextKeys()}
                                targetLabel={sidebarAction.label}
                                value={() => sidebarAction.availableWhen?.query ?? ""}
                                onValueChange={(query) =>
                                  updateSidebarAction(sidebarAction.id, (action) => ({
                                    ...action,
                                    availableWhen: query.trim() ? { query } : undefined,
                                  }))
                                }
                                error={() => diagnosticFor(sidebarAction.id, "availableWhen")}
                              />
                            </div>
                          </div>
                        );
                      }}
                    </For>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={forms().length === 0 || sidebarActions().length >= 12}
                        onClick={addSidebarForm}
                      >
                        <i class="ti ti-plus" aria-hidden="true" /> Add Form
                      </Button>
                    </div>
                  </div>
                </DetailPanel.Section>
                <DetailPanel.Section
                  title="Access"
                  icon="ti ti-shield"
                  description="Who can open the published app. This is separate from availability rules."
                  collapsible
                  defaultOpen={false}
                >
                  <div class="flex flex-col gap-3">
                    <InlineGuidance>
                      App grants are independent from Base access. Public allows anonymous visitors to open the published app.
                    </InlineGuidance>
                    <ScopedPermissionEditor scope={{ type: "customApp", id: app().id }} canEdit />
                  </div>
                </DetailPanel.Section>
                <DetailPanel.Section
                  title="Danger zone"
                  icon="ti ti-trash"
                  tone="danger"
                  description="Take the live app offline or permanently remove it. Base data is not deleted."
                  collapsible
                  defaultOpen={false}
                >
                  <CustomAppLifecycleActions app={app()} baseId={props.baseId} beforeDelete={stopAutosave} onUnpublished={setApp} />
                </DetailPanel.Section>
              </DetailPanel.Group>
            </Show>

            <Show when={inspectorMode() === "page"}>
              <DetailPanel.Summary title="Page">
                <div class="flex flex-col gap-3">
                  <TextInput label="Title" value={() => selectedPage().title} onValueChange={(title) => patchPage({ title })} required />
                  <IconInput
                    label="Navigation icon"
                    value={() => iconInputValue(selectedPage().navigation.icon)}
                    onValueChange={(value) => patchPage({ navigation: { ...selectedPage().navigation, icon: iconSlug(value) } })}
                    clearable
                  />
                  <Switch
                    label="Show in app navigation"
                    description={
                      Object.keys(selectedPage().parameters).length > 0
                        ? "Pages with required parameters are route-only and cannot appear in navigation."
                        : undefined
                    }
                    value={() => selectedPage().navigation.visible}
                    onValueChange={(visible) => patchPage({ navigation: { ...selectedPage().navigation, visible } })}
                    disabled={Object.keys(selectedPage().parameters).length > 0}
                  />
                  <Show
                    when={draft.draft().startPageId === selectedPage().id}
                    fallback={
                      <Show
                        when={Object.keys(selectedPage().parameters).length === 0}
                        fallback={
                          <InlineGuidance tone="warning">
                            This page requires a record, so it cannot be the start page. Remove its route parameters first.
                          </InlineGuidance>
                        }
                      >
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => setDefinition((definition) => ({ ...definition, startPageId: selectedPage().id }))}
                        >
                          Set as start page
                        </Button>
                      </Show>
                    }
                  >
                    <StatusBadge tone="ok" label="Start page" variant="text" />
                  </Show>
                  <PageIdInput
                    id={selectedPage().id}
                    existingIds={draft.draft().pages.map((page) => page.id)}
                    onRename={renameSelectedPage}
                  />
                </div>
              </DetailPanel.Summary>
              <DetailPanel.Group label="Page behavior">
                <DetailPanel.Section
                  title="Route parameters"
                  icon="ti ti-route"
                  description={
                    selectedPage().id === draft.draft().startPageId
                      ? "Start pages open without a record. Make another page the start page before adding a required record."
                      : "Required record IDs supplied by links, rows, Forms, or actions."
                  }
                  meta={`${Object.keys(selectedPage().parameters).length}`}
                  collapsible
                  defaultOpen={Object.keys(selectedPage().parameters).length > 0}
                >
                  <div class="flex flex-col gap-4">
                    <For each={Object.entries(selectedPage().parameters)}>
                      {([parameterId, parameter]) => {
                        const usage = () => customAppPageParameterUsage(draft.draft(), selectedPage().id, parameterId);
                        const isPageRecord = () => selectedPage().record?.id.path === parameterId;
                        const blockingUsage = () => usage().filter((entry) => entry !== "page record");
                        return (
                          <div class="flex flex-col gap-3">
                            <Show when={isPageRecord()}>
                              <StatusBadge tone="ok" icon={null} label="Used by record-page blocks" />
                            </Show>
                            <PageParameterIdInput
                              id={parameterId}
                              existingIds={Object.keys(selectedPage().parameters)}
                              onRename={(next) => renamePageParameter(parameterId, next)}
                            />
                            <Select
                              label="Record table"
                              description="The route value must be a record ID from this table."
                              searchable
                              value={() => parameter.tableId}
                              options={tableOptions()}
                              onValueChange={(tableId) => tableId && updatePageParameterTable(parameterId, tableId)}
                            />
                            <Button
                              size="xs"
                              variant="ghost"
                              class="self-start"
                              disabled={blockingUsage().length > 0}
                              title={blockingUsage().length > 0 ? `Used by ${blockingUsage().join(", ")}` : undefined}
                              onClick={() => void removePageParameter(parameterId)}
                            >
                              <i class="ti ti-x" aria-hidden="true" /> Remove record parameter
                            </Button>
                            <Show when={blockingUsage().length > 0}>
                              <InlineGuidance tone="warning">
                                This parameter is still used by {blockingUsage().join(", ")}. Remove those references before deleting it.
                              </InlineGuidance>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={addPageParameter}
                      disabled={props.catalog.tables.length === 0 || selectedPage().id === draft.draft().startPageId}
                      title={
                        props.catalog.tables.length === 0
                          ? "Create a table first."
                          : selectedPage().id === draft.draft().startPageId
                            ? "Make another page the start page first."
                            : undefined
                      }
                    >
                      <i class="ti ti-plus" aria-hidden="true" /> Add record parameter
                    </Button>
                    <Show when={props.catalog.tables.length === 0}>
                      <InlineGuidance tone="danger">
                        A record parameter needs a table. Create one from the left sidebar first.
                      </InlineGuidance>
                    </Show>
                    <Show when={props.catalog.tables.length > 0 && selectedPage().id === draft.draft().startPageId}>
                      <InlineGuidance tone="warning">
                        Start pages open without a required record.{" "}
                        <Button variant="text" size="xs" onClick={moveStartPageAwayFromSelected}>
                          {alternateStartPage() ? `Make “${alternateStartPage()!.title}” the start page` : "Create a new start page"}
                        </Button>
                      </InlineGuidance>
                    </Show>
                  </div>
                </DetailPanel.Section>
                <CustomAppAvailabilitySection
                  baseId={draft.draft().baseId}
                  contextKeys={contextKeys()}
                  targetLabel={selectedPage().title}
                  value={() => selectedPage().availableWhen?.query ?? ""}
                  onValueChange={(query) => patchPage({ availableWhen: query.trim() ? { query } : undefined }, true)}
                  error={() => diagnosticFor(selectedPage().id, "availableWhen")}
                />
              </DetailPanel.Group>
              <DetailPanel.Group label="Page management">
                <DetailPanel.Section title="Page order" icon="ti ti-arrows-sort" collapsible defaultOpen={false}>
                  <div class="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={draft.draft().pages[0]?.id === selectedPage().id}
                      onClick={() => moveSelectedPage(-1)}
                    >
                      <i class="ti ti-arrow-up" aria-hidden="true" /> Move up
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={draft.draft().pages.at(-1)?.id === selectedPage().id}
                      onClick={() => moveSelectedPage(1)}
                    >
                      <i class="ti ti-arrow-down" aria-hidden="true" /> Move down
                    </Button>
                  </div>
                </DetailPanel.Section>
                <DetailPanel.Section
                  title="Danger zone"
                  icon="ti ti-trash"
                  tone="danger"
                  description={
                    draft.draft().pages.length === 1 ? "Every app needs at least one page." : "Permanently remove this page from the draft."
                  }
                  collapsible
                  defaultOpen={false}
                >
                  <Button size="sm" variant="danger" disabled={draft.draft().pages.length === 1} onClick={() => void removePage()}>
                    <i class="ti ti-trash" aria-hidden="true" /> Remove page
                  </Button>
                </DetailPanel.Section>
              </DetailPanel.Group>
            </Show>

            <Show when={inspectorMode() === "block" && selectedBlock()}>
              {(selected) => (
                <>
                  <DetailPanel.Summary title="Block">
                    <div class="flex flex-col gap-4">
                      <TextInput
                        label="Title"
                        value={() => selected().block.title ?? ""}
                        onValueChange={(title) =>
                          updateSelectedBlock((block) => ({ ...block, title: title || undefined }) as CustomAppBlock)
                        }
                        clearable
                      />
                      <Show when={selected().block.type === "markdown"}>
                        <CustomAppMarkdownField
                          contextKeys={contextKeys().filter((key) => key !== "auth.subjects")}
                          value={() => {
                            const block = selected().block;
                            return block.type === "markdown" ? block.markdown : "";
                          }}
                          onValueChange={(markdown) =>
                            updateSelectedBlock((block) => (block.type === "markdown" ? { ...block, markdown } : block))
                          }
                        />
                      </Show>
                      <Show when={selected().block.type === "html"}>
                        <Select
                          label="HTML template field"
                          searchable
                          value={() => {
                            const block = selected().block;
                            return block.type === "html" ? block.fieldId : null;
                          }}
                          options={pageHtmlFields().map((field) => ({
                            id: field.id,
                            label: field.name,
                            description: "HTML template",
                            icon: field.icon ?? "ti ti-code",
                          }))}
                          error={() => diagnosticFor(selected().block.id, "fieldId")}
                          onValueChange={(fieldId) =>
                            fieldId && updateSelectedBlock((block) => (block.type === "html" ? { ...block, fieldId } : block))
                          }
                        />
                        <Select
                          label="Height"
                          value={() => {
                            const block = selected().block;
                            return block.type === "html" ? block.height : null;
                          }}
                          options={[
                            { id: "compact", label: "Compact" },
                            { id: "normal", label: "Normal" },
                            { id: "large", label: "Large" },
                          ]}
                          onValueChange={(height) =>
                            (height === "compact" || height === "normal" || height === "large") &&
                            updateSelectedBlock((block) => (block.type === "html" ? { ...block, height } : block))
                          }
                        />
                      </Show>
                    </div>
                  </DetailPanel.Summary>
                  <DetailPanel.Group label="Block behavior">
                    <CustomAppAvailabilitySection
                      baseId={draft.draft().baseId}
                      contextKeys={contextKeys()}
                      targetLabel={selected().block.title || blockMeta[selected().block.type].label}
                      value={() => selected().block.availableWhen?.query ?? ""}
                      onValueChange={(query) =>
                        updateSelectedBlock(
                          (block) => ({ ...block, availableWhen: query.trim() ? { query } : undefined }) as CustomAppBlock,
                        )
                      }
                      error={() => diagnosticFor(selected().block.id, "availableWhen")}
                    />
                    <Show
                      when={
                        selected().block.type === "records" ||
                        selected().block.type === "referenced_records" ||
                        selected().block.type === "record"
                      }
                    >
                      <DetailPanel.Section
                        title="Empty state"
                        icon="ti ti-placeholder"
                        description="Message shown when this block has no content."
                        collapsible
                        defaultOpen={false}
                      >
                        <TextInput
                          label="Message"
                          value={() => {
                            const block = selected().block;
                            return block.type === "records" || block.type === "referenced_records" || block.type === "record"
                              ? (block.emptyText ?? "")
                              : "";
                          }}
                          onValueChange={(emptyText) =>
                            updateSelectedBlock((block) =>
                              block.type === "records" || block.type === "referenced_records" || block.type === "record"
                                ? { ...block, emptyText: emptyText || undefined }
                                : block,
                            )
                          }
                          clearable
                        />
                      </DetailPanel.Section>
                    </Show>
                    <Show when={selected().block.type === "actions"}>
                      <DetailPanel.Section
                        title="Actions"
                        icon="ti ti-bolt"
                        description="Open another page or run an available App workflow."
                        collapsible
                        defaultOpen
                      >
                        <div class="flex flex-col gap-2">
                          <For each={selectedActionsBlock()?.actions ?? []}>
                            {(action) => (
                              <DetailPanel.Action
                                title={action.label}
                                description={
                                  action.kind === "workflow"
                                    ? "Run workflow"
                                    : `Open ${draft.draft().pages.find((page) => page.id === action.pageId)?.title ?? "page"}`
                                }
                                leading={
                                  <i
                                    class={
                                      action.icon ? `ti ti-${action.icon}` : action.kind === "workflow" ? "ti ti-player-play" : "ti ti-link"
                                    }
                                    aria-hidden="true"
                                  />
                                }
                                trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                                onClick={() => selectAction(action.id)}
                              />
                            )}
                          </For>
                          <div class="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={addNavigateAction}
                              disabled={(selectedActionsBlock()?.actions.length ?? 0) >= 12}
                              title={
                                (selectedActionsBlock()?.actions.length ?? 0) >= 12 ? "Actions blocks support up to 12 actions." : undefined
                              }
                            >
                              <i class="ti ti-link-plus" aria-hidden="true" /> Add navigation
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={addWorkflowAction}
                              disabled={workflowLaunchers().length === 0 || (selectedActionsBlock()?.actions.length ?? 0) >= 12}
                              title={
                                workflowLaunchers().length === 0
                                  ? "Add an enabled App run option first."
                                  : (selectedActionsBlock()?.actions.length ?? 0) >= 12
                                    ? "Actions blocks support up to 12 actions."
                                    : undefined
                              }
                            >
                              <i class="ti ti-player-play" aria-hidden="true" /> Add workflow
                            </Button>
                          </div>
                          <Show
                            when={(selectedActionsBlock()?.actions.length ?? 0) >= 12}
                            fallback={
                              <Show when={workflowLaunchers().length === 0}>
                                <WorkflowPrerequisiteGuidance
                                  hasWorkflows={props.catalog.workflows.length > 0}
                                  kind="action"
                                  onOpen={() => void openWorkflowConfiguration()}
                                />
                              </Show>
                            }
                          >
                            <InlineGuidance>This Actions block already has the maximum of 12 actions.</InlineGuidance>
                          </Show>
                        </div>
                      </DetailPanel.Section>
                    </Show>
                  </DetailPanel.Group>
                  <Show when={selected().block.type === "referenced_records"}>
                    <DetailPanel.Group label="Referenced records settings">
                      <DetailPanel.Section
                        title="Relation source"
                        icon="ti ti-table-share"
                        description="Pin the source table, its Relation to this page record, and the displayed fields."
                        collapsible
                        defaultOpen
                      >
                        <div class="flex flex-col gap-4">
                          <Select
                            label="Source table"
                            description="Only tables with a Relation to this Record page are available."
                            searchable
                            value={() => selectedReferencedRecordsBlock()?.sourceTableId ?? null}
                            options={referencedSourceOptions()}
                            onValueChange={(sourceTableId) => {
                              if (!sourceTableId) return;
                              const candidate = referencedRecordsCandidates().find((item) => item.table.id === sourceTableId);
                              const relation = candidate?.relations[0];
                              if (!candidate || !relation) return;
                              updateSelectedBlock((block) =>
                                block.type === "referenced_records"
                                  ? {
                                      ...block,
                                      sourceTableId,
                                      relationFieldId: relation.id,
                                      fieldIds: candidate.fields.map((field) => field.id),
                                    }
                                  : block,
                              );
                            }}
                          />
                          <Select
                            label="Relation field"
                            description="Rows are included when this Relation contains the current record."
                            value={() => selectedReferencedRecordsBlock()?.relationFieldId ?? null}
                            options={referencedRelationOptions()}
                            error={() => diagnosticFor(selected().block.id, "relationFieldId")}
                            onValueChange={(relationFieldId) =>
                              relationFieldId &&
                              updateSelectedBlock((block) => (block.type === "referenced_records" ? { ...block, relationFieldId } : block))
                            }
                          />
                          <MultiSelectInput
                            label="Fields"
                            description="Choose the exact fields exposed by this block."
                            placeholder="Choose fields"
                            searchable
                            value={() => selectedReferencedRecordsBlock()?.fieldIds ?? []}
                            selectedOptions={() => {
                              const options = new Map(referencedFieldOptions().map((option) => [option.id, option]));
                              return (selectedReferencedRecordsBlock()?.fieldIds ?? []).map(
                                (fieldId) => options.get(fieldId) ?? { id: fieldId, label: "Unavailable field" },
                              );
                            }}
                            options={referencedFieldOptions()}
                            error={() => {
                              const block = selectedReferencedRecordsBlock();
                              if (!block) return undefined;
                              if (block.fieldIds.length === 0) return "Choose at least one field.";
                              return diagnosticFor(block.id, "fieldIds");
                            }}
                            onValueChange={(fieldIds) =>
                              updateSelectedBlock((block) =>
                                block.type === "referenced_records" ? { ...block, fieldIds: fieldIds.slice(0, 30) } : block,
                              )
                            }
                          />
                          <Select
                            label="Display"
                            value={() => selectedReferencedRecordsBlock()?.display.kind ?? "table"}
                            options={[
                              { id: "table", label: "Table", icon: "ti ti-table" },
                              { id: "cards", label: "Cards", icon: "ti ti-layout-grid" },
                            ]}
                            onValueChange={(kind) =>
                              (kind === "table" || kind === "cards") &&
                              updateSelectedBlock((block) =>
                                block.type === "referenced_records" ? { ...block, display: { kind } } : block,
                              )
                            }
                          />
                          <Switch
                            label="Search"
                            description="Let readers search the displayed fields."
                            value={() => selectedReferencedRecordsBlock()?.searchable ?? true}
                            onValueChange={(searchable) =>
                              updateSelectedBlock((block) => (block.type === "referenced_records" ? { ...block, searchable } : block))
                            }
                          />
                          <NumberInput
                            label="Rows per page"
                            min={5}
                            max={100}
                            step={5}
                            value={() => selectedReferencedRecordsBlock()?.pageSize ?? 25}
                            onValueChange={(pageSize) =>
                              pageSize !== null &&
                              updateSelectedBlock((block) => (block.type === "referenced_records" ? { ...block, pageSize } : block))
                            }
                          />
                        </div>
                      </DetailPanel.Section>
                      <DetailPanel.Section
                        title="Row actions"
                        icon="ti ti-click"
                        description="Signed-in app readers can run workflows for selected rows."
                        collapsible
                        defaultOpen={(selectedReferencedRecordsBlock()?.rowActions?.length ?? 0) > 0}
                      >
                        <div class="flex flex-col gap-2">
                          <For each={selectedReferencedRecordsBlock()?.rowActions ?? []}>
                            {(action) => (
                              <DetailPanel.Action
                                title={action.label}
                                description="Run workflow for this row"
                                leading={<i class={action.icon ? `ti ti-${action.icon}` : "ti ti-player-play"} aria-hidden="true" />}
                                trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                                onClick={() => selectAction(action.id)}
                              />
                            )}
                          </For>
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={addRowWorkflowAction}
                            disabled={workflowLaunchers().length === 0 || (selectedReferencedRecordsBlock()?.rowActions?.length ?? 0) >= 6}
                          >
                            <i class="ti ti-player-play" aria-hidden="true" /> Add row action
                          </Button>
                        </div>
                      </DetailPanel.Section>
                    </DetailPanel.Group>
                  </Show>
                  <Show
                    when={selected().block.type === "records" || selected().block.type === "metrics" || selected().block.type === "chart"}
                  >
                    <DetailPanel.Group label="Data settings">
                      <DetailPanel.Section
                        title="Data source"
                        icon="ti ti-database-search"
                        description="Choose the published data this block can read."
                        collapsible
                        defaultOpen
                      >
                        <div class="flex flex-col gap-4">
                          <Select
                            label="Data source"
                            value={() => {
                              const block = selected().block;
                              return block.type === "records" || block.type === "metrics" || block.type === "chart"
                                ? block.source.kind
                                : null;
                            }}
                            options={[
                              {
                                id: "view",
                                label: "Saved view",
                                icon: "ti ti-table",
                                description:
                                  readyViews().length > 0
                                    ? "Choose visually configured data."
                                    : "No saved view with visible fields is available.",
                                disabled: readyViews().length === 0,
                              },
                              { id: "gql", label: "GQL query", icon: "ti ti-code", description: "Write an advanced bounded query." },
                            ]}
                            onValueChange={(kind) => {
                              if (kind !== "view" && kind !== "gql") return;
                              const resource = readyViews()[0];
                              updateSelectedBlock((block) => {
                                if (block.type !== "records" && block.type !== "metrics" && block.type !== "chart") return block;
                                if (kind === "gql") {
                                  const source =
                                    block.type === "records"
                                      ? starterGqlSources().records
                                      : block.type === "metrics"
                                        ? starterGqlSources().metrics
                                        : starterGqlSources().chart;
                                  if (!source) return block;
                                  return block.type === "records"
                                    ? {
                                        ...block,
                                        source,
                                        display: { kind: "table", columnIds: [] },
                                      }
                                    : { ...block, source };
                                }
                                if (!resource) return block;
                                return block.type === "records"
                                  ? {
                                      ...block,
                                      source: { kind: "view", viewId: resource.view.id },
                                      display: { kind: "table", columnIds: resource.fields.map((field) => field.id) },
                                    }
                                  : { ...block, source: { kind: "view", viewId: resource.view.id } };
                              });
                            }}
                          />
                          <Show when={selectedSourceBlock()?.source.kind === "gql"}>
                            <CustomAppGqlField
                              baseId={draft.draft().baseId}
                              contextKeys={contextKeys()}
                              label="GQL"
                              dialogTitle={`${selected().block.title || blockMeta[selected().block.type].label} data source`}
                              description="Use implicit @auth, @params, @page, @app, @base, and @time context."
                              error={() => {
                                const block = selected().block;
                                return block.type === "records" || block.type === "metrics" || block.type === "chart"
                                  ? diagnosticFor(block.id, "source")
                                  : undefined;
                              }}
                              lines={10}
                              value={() => {
                                const block = selected().block;
                                return (block.type === "records" || block.type === "metrics" || block.type === "chart") &&
                                  block.source.kind === "gql"
                                  ? block.source.query
                                  : "";
                              }}
                              onValueChange={(query) =>
                                updateSelectedBlock((block) =>
                                  (block.type === "records" || block.type === "metrics" || block.type === "chart") &&
                                  block.source.kind === "gql"
                                    ? { ...block, source: { ...block.source, query } }
                                    : block,
                                )
                              }
                            />
                          </Show>
                          <Show
                            when={
                              (selectedSourceBlock()?.type === "metrics" || selectedSourceBlock()?.type === "chart") &&
                              selectedSourceBlock()?.source.kind === "view"
                            }
                          >
                            <Select
                              label="Saved view"
                              searchable
                              value={() => {
                                const block = selected().block;
                                return (block.type === "metrics" || block.type === "chart") && block.source.kind === "view"
                                  ? block.source.viewId
                                  : null;
                              }}
                              options={viewOptions()}
                              onValueChange={(viewId) =>
                                viewId &&
                                updateSelectedBlock((block) =>
                                  block.type === "metrics" || block.type === "chart"
                                    ? { ...block, source: { kind: "view", viewId } }
                                    : block,
                                )
                              }
                            />
                          </Show>
                        </div>
                      </DetailPanel.Section>
                      <Show when={selected().block.type === "records"}>
                        <DetailPanel.Section
                          title="Records table"
                          icon="ti ti-table"
                          description={
                            selectedRecordsBlock()?.source.kind === "view"
                              ? "Choose visible columns and optional row navigation."
                              : "GQL selects the visible columns. Optionally make each row open a record page."
                          }
                          collapsible
                          defaultOpen
                        >
                          <div class="flex flex-col gap-4">
                            <Switch
                              label="Search"
                              description="Let readers search the displayed result fields. Filtering runs securely in PostgreSQL."
                              value={() => selectedRecordsBlock()?.searchable ?? true}
                              onValueChange={(searchable) =>
                                updateSelectedBlock((block) => (block.type === "records" ? { ...block, searchable } : block))
                              }
                            />
                            <NumberInput
                              label="Rows per page"
                              description="Readers can move through additional pages. A GQL limit still caps the whole result."
                              min={5}
                              max={100}
                              step={5}
                              value={() => selectedRecordsBlock()?.pageSize ?? 25}
                              onValueChange={(pageSize) =>
                                pageSize !== null &&
                                updateSelectedBlock((block) => (block.type === "records" ? { ...block, pageSize } : block))
                              }
                            />
                            <Show when={selectedSourceBlock()?.type === "records" && selectedSourceBlock()?.source.kind === "view"}>
                              <Select
                                label="Saved view"
                                description="Only views you can use in this Base are listed."
                                placeholder="Choose a saved view"
                                searchable
                                value={() => {
                                  const block = selected().block;
                                  return block.type === "records" && block.source.kind === "view" ? block.source.viewId : null;
                                }}
                                selectedLabel={() => {
                                  const block = selected().block;
                                  if (block.type !== "records" || block.source.kind !== "view") return undefined;
                                  return viewsById().has(block.source.viewId) ? undefined : "Unavailable view";
                                }}
                                error={() => {
                                  const block = selected().block;
                                  if (block.type !== "records") return undefined;
                                  if (block.source.kind !== "view") return "Choose a saved view to configure this block visually.";
                                  if (!viewsById().has(block.source.viewId)) return "This saved view is no longer available.";
                                  return diagnosticFor(block.id, "source");
                                }}
                                options={viewOptions()}
                                onValueChange={(viewId) => {
                                  if (!viewId) return;
                                  const view = viewsById().get(viewId);
                                  if (!view) return;
                                  const fields = viewResources().find((resource) => resource.view.id === viewId)?.fields ?? [];
                                  updateSelectedBlock((block) =>
                                    block.type === "records"
                                      ? {
                                          ...block,
                                          source: { kind: "view", viewId },
                                          display: {
                                            kind: "table",
                                            columnIds: fields.map((field) => field.id),
                                          },
                                        }
                                      : block,
                                  );
                                }}
                              />
                              <Show when={selectedRecordsView()}>
                                <Select
                                  label="Display"
                                  description="Table uses App-selected columns. Cards reuse the saved View's existing Cards configuration."
                                  value={() => {
                                    const block = selected().block;
                                    return block.type === "records" ? block.display.kind : "table";
                                  }}
                                  options={[
                                    { id: "table", label: "Table", icon: "ti ti-table" },
                                    {
                                      id: "cards",
                                      label: "Cards from saved View",
                                      icon: "ti ti-layout-grid",
                                      disabled: selectedRecordsView()?.ui.displayConfig?.mode !== "cards",
                                    },
                                  ]}
                                  onValueChange={(kind) =>
                                    updateSelectedBlock((block) => {
                                      if (block.type !== "records" || !kind) return block;
                                      if (kind === "cards") return { ...block, display: { kind: "cards" } };
                                      const fields = selectedRecordsFields();
                                      return {
                                        ...block,
                                        display: {
                                          kind: "table",
                                          columnIds:
                                            block.display.kind === "table" ? block.display.columnIds : fields.map((field) => field.id),
                                        },
                                      };
                                    })
                                  }
                                />
                                <Show when={selectedRecordsUsesTable()}>
                                  <MultiSelectInput
                                    label="Columns"
                                    description="Choose up to 30 fields shown by the Records table."
                                    placeholder="Choose columns"
                                    searchable
                                    clearable
                                    value={() => {
                                      const block = selected().block;
                                      return block.type === "records" && block.display.kind === "table" ? block.display.columnIds : [];
                                    }}
                                    selectedOptions={() => {
                                      const block = selected().block;
                                      if (block.type !== "records" || block.display.kind !== "table") return [];
                                      const options = new Map(selectedRecordsFieldOptions().map((option) => [option.id, option]));
                                      return block.display.columnIds.map(
                                        (fieldId) => options.get(fieldId) ?? { id: fieldId, label: "Unavailable field" },
                                      );
                                    }}
                                    options={selectedRecordsFieldOptions()}
                                    error={() => {
                                      const block = selected().block;
                                      if (block.type !== "records" || block.display.kind !== "table") return undefined;
                                      if (block.display.columnIds.length === 0) return "Choose at least one column.";
                                      const available = new Set(selectedRecordsFields().map((field) => field.id));
                                      if (block.display.columnIds.some((fieldId) => !available.has(fieldId))) {
                                        return "Replace or remove unavailable fields.";
                                      }
                                      return diagnosticFor(block.id, "columnIds");
                                    }}
                                    onValueChange={(columnIds) =>
                                      updateSelectedBlock((block) =>
                                        block.type === "records"
                                          ? { ...block, display: { kind: "table", columnIds: columnIds.slice(0, 30) } }
                                          : block,
                                      )
                                    }
                                  />
                                </Show>
                              </Show>
                            </Show>
                            <Show
                              when={recordsNavigationPageOptions().length > 0}
                              fallback={
                                <InlineGuidance tone={selectedSourceTableId() ? "info" : "warning"}>
                                  <Show
                                    when={selectedSourceTableId()}
                                    fallback="Use a valid row query or saved view before configuring row navigation."
                                  >
                                    Rows need a record page for {tablesById().get(selectedSourceTableId()!)?.name ?? "this table"}.{" "}
                                    <Show
                                      when={selectedSourceRecordFields().length > 0}
                                      fallback="Add at least one field to the table before creating its record page."
                                    >
                                      <Button variant="text" size="xs" onClick={addRecordPageForSelectedSource}>
                                        Create and connect record page
                                      </Button>
                                    </Show>
                                  </Show>
                                </InlineGuidance>
                              }
                            >
                              <Select
                                label="Open row on page"
                                description="Optional. Compatible record pages receive the selected row ID."
                                placeholder="Do nothing"
                                clearable
                                value={() => selectedRecordsBlock()?.rowNavigate?.pageId ?? null}
                                options={recordsNavigationPageOptions()}
                                onValueChange={(pageId) =>
                                  updateSelectedBlock((block) => {
                                    if (block.type !== "records") return block;
                                    if (!pageId) return { ...block, rowNavigate: undefined };
                                    const target = draft.draft().pages.find((page) => page.id === pageId);
                                    if (!target) return block;
                                    return {
                                      ...block,
                                      rowNavigate: {
                                        kind: "navigate",
                                        pageId,
                                        history: "push",
                                        params: Object.fromEntries(
                                          Object.keys(target.parameters).map((parameterId) => [
                                            parameterId,
                                            { source: "ROW" as const, path: "id" as const },
                                          ]),
                                        ),
                                      },
                                    };
                                  })
                                }
                              />
                              <Show when={selectedRecordsBlock()?.rowNavigate}>
                                <Select
                                  label="Navigation history"
                                  value={() => selectedRecordsBlock()?.rowNavigate?.history ?? "push"}
                                  options={[
                                    { id: "push", label: "Add to history" },
                                    { id: "replace", label: "Replace current page" },
                                  ]}
                                  onValueChange={(history) =>
                                    (history === "push" || history === "replace") &&
                                    updateSelectedBlock((block) =>
                                      block.type === "records" && block.rowNavigate
                                        ? { ...block, rowNavigate: { ...block.rowNavigate, history } }
                                        : block,
                                    )
                                  }
                                />
                              </Show>
                            </Show>
                          </div>
                        </DetailPanel.Section>
                        <DetailPanel.Section
                          title="Row actions"
                          icon="ti ti-click"
                          description="Signed-in app readers can run workflows for selected table rows or cards."
                          collapsible
                          defaultOpen={(selectedRecordsBlock()?.rowActions?.length ?? 0) > 0}
                        >
                          <div class="flex flex-col gap-2">
                            <For each={selectedRecordsBlock()?.rowActions ?? []}>
                              {(action) => (
                                <DetailPanel.Action
                                  title={action.label}
                                  description="Run workflow for this row"
                                  leading={<i class={action.icon ? `ti ti-${action.icon}` : "ti ti-player-play"} aria-hidden="true" />}
                                  trailing={<i class="ti ti-chevron-right" aria-hidden="true" />}
                                  onClick={() => selectAction(action.id)}
                                />
                              )}
                            </For>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={addRowWorkflowAction}
                              disabled={workflowLaunchers().length === 0 || (selectedRecordsBlock()?.rowActions?.length ?? 0) >= 6}
                              title={
                                workflowLaunchers().length === 0
                                  ? "Add an enabled App run option first."
                                  : (selectedRecordsBlock()?.rowActions?.length ?? 0) >= 6
                                    ? "Records blocks support up to 6 row actions."
                                    : undefined
                              }
                            >
                              <i class="ti ti-player-play" aria-hidden="true" /> Add row action
                            </Button>
                            <Show
                              when={(selectedRecordsBlock()?.rowActions?.length ?? 0) >= 6}
                              fallback={
                                <Show when={workflowLaunchers().length === 0}>
                                  <WorkflowPrerequisiteGuidance
                                    hasWorkflows={props.catalog.workflows.length > 0}
                                    kind="row"
                                    rowTableName={
                                      selectedSourceTableId() ? (tablesById().get(selectedSourceTableId()!)?.name ?? "matching") : null
                                    }
                                    onOpen={() => void openWorkflowConfiguration()}
                                  />
                                </Show>
                              }
                            >
                              <InlineGuidance>This Records block already has the maximum of 6 row actions.</InlineGuidance>
                            </Show>
                          </div>
                        </DetailPanel.Section>
                      </Show>
                    </DetailPanel.Group>
                  </Show>
                  <Show when={selected().block.type === "form"}>
                    <DetailPanel.Group label="Form settings">
                      <DetailPanel.Section title="Form" icon="ti ti-forms" description="Choose the active Form rendered by this block.">
                        <Select
                          label="Form"
                          description="Only active forms you can use in this Base are listed."
                          placeholder="Choose an active form"
                          searchable
                          value={() => {
                            const block = selected().block;
                            return block.type === "form" ? block.formId : null;
                          }}
                          selectedLabel={() => {
                            const block = selected().block;
                            return block.type === "form" && !formsById().has(block.formId) ? "Unavailable form" : undefined;
                          }}
                          error={() => {
                            const block = selected().block;
                            if (block.type !== "form") return undefined;
                            if (!formsById().has(block.formId)) return "This form is missing or inactive.";
                            return diagnosticFor(block.id, "formId");
                          }}
                          options={formOptions()}
                          onValueChange={(formId) => {
                            if (!formId) return;
                            updateSelectedBlock((block) =>
                              block.type === "form" ? { ...block, formId, fixedValues: {}, onSuccessNavigate: undefined } : block,
                            );
                          }}
                        />
                      </DetailPanel.Section>
                      <Show when={selectedForm()}>
                        <Show when={selectedFormBindingOptions().length > 0}>
                          <DetailPanel.Section
                            title="Values supplied by this page"
                            icon="ti ti-input-check"
                            description="Hide Form inputs and provide trusted values from this page."
                            collapsible
                            defaultOpen={Object.keys(selectedFormBlock()?.fixedValues ?? {}).length > 0}
                          >
                            <div class="flex flex-col gap-3">
                              <InlineGuidance>
                                Supplied values are hidden from the Form and injected again by the server when it is submitted.
                              </InlineGuidance>
                              <For each={selectedFormBindingOptions()}>
                                {(binding) => {
                                  const current = () => selectedFormBlock()?.fixedValues[binding.field.id];
                                  const literal = () => {
                                    const value = current();
                                    return value?.source === "LITERAL" ? value : null;
                                  };
                                  const sourceOptions = () => [
                                    { id: "LITERAL", label: "Fixed value" },
                                    ...(binding.field.type === "principal" ? [{ id: "AUTH", label: "Current signed-in user" }] : []),
                                    ...(binding.targetTableId && selectedPage().record?.tableId === binding.targetTableId
                                      ? [{ id: "RECORD", label: "Current page record" }]
                                      : []),
                                    ...(binding.targetTableId
                                      ? Object.entries(selectedPage().parameters)
                                          .filter(([, parameter]) => parameter.tableId === binding.targetTableId)
                                          .map(([parameterId]) => ({ id: `PARAMS:${parameterId}`, label: `@params.${parameterId}` }))
                                      : []),
                                  ];
                                  return (
                                    <div class="flex flex-col gap-2">
                                      <Select
                                        label={binding.label}
                                        placeholder="Ask in Form"
                                        clearable
                                        value={() => {
                                          const value = current();
                                          return value?.source === "PARAMS" ? `PARAMS:${value.path}` : (value?.source ?? null);
                                        }}
                                        options={sourceOptions()}
                                        onValueChange={(source) =>
                                          updateSelectedBlock((block) => {
                                            if (block.type !== "form") return block;
                                            const fixedValues = { ...block.fixedValues };
                                            if (!source) delete fixedValues[binding.field.id];
                                            else if (source === "AUTH") {
                                              fixedValues[binding.field.id] = { source: "AUTH", path: "currentUser" };
                                            } else if (source === "RECORD")
                                              fixedValues[binding.field.id] = { source: "RECORD", path: "id" };
                                            else if (source.startsWith("PARAMS:")) {
                                              fixedValues[binding.field.id] = {
                                                source: "PARAMS",
                                                path: source.slice("PARAMS:".length),
                                              };
                                            } else fixedValues[binding.field.id] = { source: "LITERAL", value: null };
                                            return { ...block, fixedValues };
                                          })
                                        }
                                      />
                                      <Show when={literal()}>
                                        {(value) => (
                                          <JsonValueInput
                                            label={`${binding.label} value`}
                                            value={value().value}
                                            onValueChange={(next) =>
                                              updateSelectedBlock((block) =>
                                                block.type === "form"
                                                  ? {
                                                      ...block,
                                                      fixedValues: {
                                                        ...block.fixedValues,
                                                        [binding.field.id]: { source: "LITERAL", value: next },
                                                      },
                                                    }
                                                  : block,
                                              )
                                            }
                                          />
                                        )}
                                      </Show>
                                    </div>
                                  );
                                }}
                              </For>
                            </div>
                          </DetailPanel.Section>
                        </Show>
                        <DetailPanel.Section
                          title="After submission"
                          icon="ti ti-arrow-forward-up"
                          description="Optionally navigate after the Form creates its record."
                          collapsible
                          defaultOpen={Boolean(selectedFormBlock()?.onSuccessNavigate)}
                        >
                          <div class="flex flex-col gap-3">
                            <Select
                              label="Target page"
                              placeholder="Stay on this page"
                              clearable
                              value={() => selectedFormBlock()?.onSuccessNavigate?.pageId ?? null}
                              options={draft.draft().pages.map((page) => ({ id: page.id, label: page.title }))}
                              onValueChange={(pageId) =>
                                updateSelectedBlock((block) => {
                                  if (block.type !== "form") return block;
                                  if (!pageId) return { ...block, onSuccessNavigate: undefined };
                                  const target = draft.draft().pages.find((page) => page.id === pageId);
                                  if (!target) return block;
                                  return {
                                    ...block,
                                    onSuccessNavigate: {
                                      kind: "navigate",
                                      pageId,
                                      params: defaultFormSuccessParams(block.formId, pageId),
                                    },
                                  };
                                })
                              }
                            />
                            <Show when={selectedFormBlock()?.onSuccessNavigate}>
                              {(navigation) => {
                                const target = () => draft.draft().pages.find((page) => page.id === navigation().pageId);
                                return (
                                  <For each={Object.entries(target()?.parameters ?? {})}>
                                    {([parameterId, parameter]) => {
                                      const current = () => navigation().params[parameterId];
                                      const options = () => [
                                        ...(selectedForm()?.tableId === parameter.tableId
                                          ? [{ id: "RESULT", label: "Created Form record" }]
                                          : []),
                                        ...Object.entries(selectedPage().parameters)
                                          .filter(([, candidate]) => candidate.tableId === parameter.tableId)
                                          .map(([sourceId]) => ({ id: `PARAMS:${sourceId}`, label: `@params.${sourceId}` })),
                                      ];
                                      return (
                                        <Select
                                          label={`Value for ${parameterId}`}
                                          value={() => {
                                            const value = current();
                                            return value?.source === "RESULT" ? "RESULT" : value ? `PARAMS:${value.path}` : null;
                                          }}
                                          options={options()}
                                          error={() => (current() ? undefined : "Choose a compatible value.")}
                                          onValueChange={(value) =>
                                            value &&
                                            updateSelectedBlock((block) => {
                                              if (block.type !== "form" || !block.onSuccessNavigate) return block;
                                              return {
                                                ...block,
                                                onSuccessNavigate: {
                                                  ...block.onSuccessNavigate,
                                                  params: {
                                                    ...block.onSuccessNavigate.params,
                                                    [parameterId]:
                                                      value === "RESULT"
                                                        ? { source: "RESULT", path: "recordId" }
                                                        : { source: "PARAMS", path: value.slice("PARAMS:".length) },
                                                  },
                                                },
                                              };
                                            })
                                          }
                                        />
                                      );
                                    }}
                                  </For>
                                );
                              }}
                            </Show>
                          </div>
                        </DetailPanel.Section>
                      </Show>
                    </DetailPanel.Group>
                  </Show>
                  <Show when={selected().block.type === "scanner"}>
                    <DetailPanel.Group label="Scanner settings">
                      <DetailPanel.Section
                        title="Scanner workflow"
                        icon="ti ti-scan"
                        description="Each scan resolves a code and starts this workflow. Readers must be signed in."
                      >
                        <div class="flex flex-col gap-3">
                          <Select
                            label="Scanner run option"
                            description="Only enabled Scanner run options with a ready workflow revision are listed."
                            value={() => {
                              const block = selected().block;
                              return block.type === "scanner" ? block.launcherId : null;
                            }}
                            options={scannerLauncherOptions()}
                            error={() => {
                              const block = selected().block;
                              return block.type === "scanner" && !scannerLaunchers().some((launcher) => launcher.id === block.launcherId)
                                ? "This Scanner run option is unavailable."
                                : diagnosticFor(block.id, "launcherId");
                            }}
                            onValueChange={(launcherId) =>
                              launcherId && updateSelectedBlock((block) => (block.type === "scanner" ? { ...block, launcherId } : block))
                            }
                          />
                          <Show when={scannerLaunchers().length === 0}>
                            <InlineGuidance>
                              Add and enable a Scanner run option on a workflow before publishing this block.{" "}
                              <Button variant="text" size="xs" onClick={() => void openWorkflowConfiguration()}>
                                Configure workflows
                              </Button>
                            </InlineGuidance>
                          </Show>
                        </div>
                      </DetailPanel.Section>
                    </DetailPanel.Group>
                  </Show>
                  <Show when={selected().block.type === "record"}>
                    <DetailPanel.Group label="Record settings">
                      <DetailPanel.Section
                        title="Fields"
                        icon="ti ti-columns-3"
                        description="Choose visible fields and which of them readers may edit."
                        collapsible
                        defaultOpen
                      >
                        <div class="flex flex-col gap-4">
                          <MultiSelectInput
                            label="Fields"
                            description="Choose at least one field shown by this Record block."
                            searchable
                            value={() => selectedRecordBlock()?.fieldIds ?? []}
                            options={pageRecordFields().map((field) => ({
                              id: field.id,
                              label: field.name,
                              description: field.type,
                              icon: field.icon ?? "ti ti-column-insert-right",
                            }))}
                            error={() => {
                              const block = selectedRecordBlock();
                              if (!block) return undefined;
                              if (block.fieldIds.length === 0) return "Choose at least one field.";
                              return diagnosticFor(block.id, "fieldIds");
                            }}
                            onValueChange={(fieldIds) =>
                              updateSelectedBlock((block) =>
                                block.type === "record"
                                  ? {
                                      ...block,
                                      fieldIds: fieldIds.slice(0, 30),
                                      editableFieldIds: block.editableFieldIds.filter((id) => fieldIds.includes(id)),
                                    }
                                  : block,
                              )
                            }
                          />
                          <MultiSelectInput
                            label="Editable fields"
                            searchable
                            clearable
                            value={() => selectedRecordBlock()?.editableFieldIds ?? []}
                            options={pageRecordFields()
                              .filter((field) => selectedRecordBlock()?.fieldIds.includes(field.id) && isRecordInputField(field.type))
                              .map((field) => ({
                                id: field.id,
                                label: field.name,
                                description: field.type,
                                icon: field.icon ?? "ti ti-edit",
                              }))}
                            onValueChange={(editableFieldIds) =>
                              updateSelectedBlock((block) =>
                                block.type === "record" ? { ...block, editableFieldIds: editableFieldIds.slice(0, 30) } : block,
                              )
                            }
                          />
                        </div>
                      </DetailPanel.Section>
                      <DetailPanel.Section
                        title="Documents"
                        icon="ti ti-files"
                        description="Let readers view and download existing documents for the page record."
                        collapsible
                        defaultOpen={Boolean(selectedRecordBlock()?.documents)}
                      >
                        <Show
                          when={documentTemplateOptions().length > 0}
                          fallback={
                            <InlineGuidance tone="info">
                              This block shows documents already generated for the page record. Create and enable a document template for
                              this table, then generate documents from a workflow.{" "}
                              <ButtonLink variant="text" size="xs" href="/app/grids/help/grids-documents-pdfs">
                                Read the document guide
                              </ButtonLink>
                            </InlineGuidance>
                          }
                        >
                          <MultiSelectInput
                            label="Document templates"
                            description="Show existing generated documents from these enabled templates."
                            searchable
                            clearable
                            value={() => selectedRecordBlock()?.documents?.templateIds ?? []}
                            options={documentTemplateOptions()}
                            onValueChange={(templateIds) =>
                              updateSelectedBlock((block) =>
                                block.type === "record"
                                  ? { ...block, documents: templateIds.length > 0 ? { templateIds: templateIds.slice(0, 12) } : undefined }
                                  : block,
                              )
                            }
                          />
                        </Show>
                      </DetailPanel.Section>
                    </DetailPanel.Group>
                  </Show>
                  <Show when={selected().block.type === "chart"}>
                    <DetailPanel.Group label="Chart settings">
                      <DetailPanel.Section
                        title="Chart"
                        icon="ti ti-chart-bar"
                        description="Choose the chart presentation and result limit."
                        collapsible
                        defaultOpen
                      >
                        <div class="flex flex-col gap-4">
                          <TextInput
                            label="Subtitle"
                            value={() => {
                              const block = selected().block;
                              return block.type === "chart" ? (block.subtitle ?? "") : "";
                            }}
                            onValueChange={(subtitle) =>
                              updateSelectedBlock((block) =>
                                block.type === "chart" ? { ...block, subtitle: subtitle || undefined } : block,
                              )
                            }
                            clearable
                          />
                          <Select
                            label="Chart type"
                            value={() => {
                              const block = selected().block;
                              return block.type === "chart" ? block.chartType : null;
                            }}
                            onValueChange={(chartType) => {
                              const next = chartType ? chartTypeFrom(chartType) : null;
                              if (!next) return;
                              updateSelectedBlock((block) => (block.type === "chart" ? { ...block, chartType: next } : block));
                            }}
                            options={[
                              { id: "bar", label: "Bar" },
                              { id: "line", label: "Line" },
                              { id: "donut", label: "Donut" },
                            ]}
                          />
                          <NumberInput
                            label="Result limit"
                            value={() => {
                              const block = selected().block;
                              return block.type === "chart" ? block.limit : null;
                            }}
                            onValueChange={(limit) => {
                              if (limit === null) return;
                              updateSelectedBlock((block) => (block.type === "chart" ? { ...block, limit } : block));
                            }}
                            min={1}
                            max={100}
                            step={1}
                          />
                        </div>
                      </DetailPanel.Section>
                      <DetailPanel.Section
                        title="Appearance"
                        icon="ti ti-palette"
                        description="Optional axis labels and value formatting."
                        collapsible
                        defaultOpen={Boolean(
                          selectedChartBlock()?.valueFormat || selectedChartBlock()?.xAxisLabel || selectedChartBlock()?.yAxisLabel,
                        )}
                      >
                        <div class="flex flex-col gap-3">
                          <TextInput
                            label="X-axis label"
                            clearable
                            value={() => selectedChartBlock()?.xAxisLabel ?? ""}
                            onValueChange={(xAxisLabel) =>
                              updateSelectedBlock((block) =>
                                block.type === "chart" ? { ...block, xAxisLabel: xAxisLabel || undefined } : block,
                              )
                            }
                          />
                          <TextInput
                            label="Y-axis label"
                            clearable
                            value={() => selectedChartBlock()?.yAxisLabel ?? ""}
                            onValueChange={(yAxisLabel) =>
                              updateSelectedBlock((block) =>
                                block.type === "chart" ? { ...block, yAxisLabel: yAxisLabel || undefined } : block,
                              )
                            }
                          />
                          <Select
                            label="Value format"
                            placeholder="Automatic"
                            clearable
                            value={() => selectedChartBlock()?.valueFormat?.style ?? null}
                            options={[
                              { id: "number", label: "Number" },
                              { id: "integer", label: "Integer" },
                              { id: "percent", label: "Percent" },
                            ]}
                            onValueChange={(style) =>
                              updateSelectedBlock((block) =>
                                block.type === "chart"
                                  ? {
                                      ...block,
                                      valueFormat: style === "number" || style === "integer" || style === "percent" ? { style } : undefined,
                                    }
                                  : block,
                              )
                            }
                          />
                          <Show when={selectedChartBlock()?.valueFormat?.style !== "integer" && selectedChartBlock()?.valueFormat}>
                            <NumberInput
                              label="Decimal places"
                              min={0}
                              max={20}
                              step={1}
                              clearable
                              value={() => selectedChartBlock()?.valueFormat?.decimalPlaces ?? null}
                              onValueChange={(decimalPlaces) =>
                                updateSelectedBlock((block) =>
                                  block.type === "chart" && block.valueFormat
                                    ? {
                                        ...block,
                                        valueFormat: {
                                          ...block.valueFormat,
                                          decimalPlaces: decimalPlaces === null ? undefined : decimalPlaces,
                                        },
                                      }
                                    : block,
                                )
                              }
                            />
                          </Show>
                          <Show when={selectedChartBlock()?.valueFormat?.style === "number"}>
                            <TextInput
                              label="Unit"
                              clearable
                              value={() =>
                                selectedChartBlock()?.valueFormat?.style === "number" ? (selectedChartBlock()?.valueFormat?.unit ?? "") : ""
                              }
                              onValueChange={(unit) =>
                                updateSelectedBlock((block) =>
                                  block.type === "chart" && block.valueFormat?.style === "number"
                                    ? {
                                        ...block,
                                        valueFormat: {
                                          ...block.valueFormat,
                                          unit: unit || undefined,
                                          unitPosition: unit ? (block.valueFormat.unitPosition ?? "suffix") : undefined,
                                        },
                                      }
                                    : block,
                                )
                              }
                            />
                            <Select
                              label="Unit position"
                              value={() =>
                                selectedChartBlock()?.valueFormat?.style === "number"
                                  ? (selectedChartBlock()?.valueFormat?.unitPosition ?? "suffix")
                                  : "suffix"
                              }
                              options={[
                                { id: "prefix", label: "Before value" },
                                { id: "suffix", label: "After value" },
                              ]}
                              onValueChange={(unitPosition) =>
                                (unitPosition === "prefix" || unitPosition === "suffix") &&
                                updateSelectedBlock((block) =>
                                  block.type === "chart" && block.valueFormat?.style === "number" && block.valueFormat.unit
                                    ? { ...block, valueFormat: { ...block.valueFormat, unitPosition } }
                                    : block,
                                )
                              }
                            />
                          </Show>
                        </div>
                      </DetailPanel.Section>
                    </DetailPanel.Group>
                  </Show>
                  <DetailPanel.Group label="Block management">
                    <DetailPanel.Section title="Block order" icon="ti ti-arrows-sort" collapsible defaultOpen={false}>
                      <div class="flex flex-wrap gap-2">
                        <Button size="sm" variant="secondary" disabled={selected().blockIndex === 0} onClick={() => moveSelectedBlock(-1)}>
                          <i class="ti ti-arrow-up" aria-hidden="true" /> Move up
                        </Button>
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={selected().blockIndex === selected().column.blocks.length - 1}
                          onClick={() => moveSelectedBlock(1)}
                        >
                          <i class="ti ti-arrow-down" aria-hidden="true" /> Move down
                        </Button>
                      </div>
                    </DetailPanel.Section>
                    <DetailPanel.Section
                      title="Danger zone"
                      icon="ti ti-trash"
                      tone="danger"
                      description={
                        blockCount() === 1 ? "Every page needs at least one block." : "Permanently remove this block from the draft."
                      }
                      collapsible
                      defaultOpen={false}
                    >
                      <Button size="sm" variant="danger" disabled={blockCount() === 1} onClick={() => void removeSelectedBlock()}>
                        <i class="ti ti-trash" aria-hidden="true" /> Remove block
                      </Button>
                    </DetailPanel.Section>
                  </DetailPanel.Group>
                </>
              )}
            </Show>
            <Show when={inspectorMode() === "action" && selectedAction()}>
              {(selected) => {
                const selectedLauncher = () =>
                  workflowLaunchers().find((launcher) => launcher.id === selectedWorkflowAction()?.launcherId) ?? null;
                const selectedWorkflow = () => {
                  const launcher = selectedLauncher();
                  return launcher ? (workflowsById().get(launcher.workflowId) ?? null) : null;
                };
                return (
                  <>
                    <DetailPanel.Action
                      title="Back to actions"
                      description={
                        selected().owner === "rows"
                          ? selectedRecordsBlock()?.title || "Records table"
                          : selectedActionsBlock()?.title || "Actions block"
                      }
                      leading={<i class="ti ti-arrow-left" aria-hidden="true" />}
                      onClick={() => {
                        setSelectedActionId(null);
                        setInspectorMode("block");
                      }}
                    />
                    <DetailPanel.Group label="Action settings">
                      <DetailPanel.Section title="Action" icon="ti ti-bolt" tone="accent">
                        <div class="flex flex-col gap-3">
                          <TextInput
                            label="Label"
                            value={() => selected().action.label}
                            onValueChange={(label) => updateSelectedAction((action) => ({ ...action, label }))}
                            required
                          />
                          <IconInput
                            label="Icon"
                            value={() => iconInputValue(selected().action.icon)}
                            onValueChange={(value) => {
                              const icon = iconSlug(value);
                              updateSelectedAction((action) =>
                                "showLabel" in action && !icon ? { ...action, icon, showLabel: true } : { ...action, icon },
                              );
                            }}
                            clearable
                          />
                          <Show when={selected().owner === "rows"}>
                            <Switch
                              label="Show label in table"
                              description={
                                selected().action.icon
                                  ? "Turn this off for a compact icon-only button. The label remains its accessible name."
                                  : "Choose an icon before hiding the visible label."
                              }
                              value={() => {
                                const action = selected().action;
                                return "showLabel" in action ? action.showLabel : true;
                              }}
                              onValueChange={(showLabel) =>
                                updateSelectedAction((action) => ("showLabel" in action ? { ...action, showLabel } : action))
                              }
                              disabled={!selected().action.icon}
                            />
                          </Show>
                          <Show when={selected().owner === "actions"}>
                            <Select
                              label="Action type"
                              value={() => selected().action.kind}
                              options={[
                                { id: "navigate", label: "Open page", icon: "ti ti-link" },
                                {
                                  id: "workflow",
                                  label: "Run workflow",
                                  icon: "ti ti-player-play",
                                  description: workflowLaunchers().length === 0 ? "No enabled App run option is available." : undefined,
                                  disabled: workflowLaunchers().length === 0,
                                },
                              ]}
                              onValueChange={(kind) => {
                                if (kind === selected().action.kind) return;
                                if (kind === "navigate") {
                                  const page =
                                    draft.draft().pages.find((candidate) => Object.keys(candidate.parameters).length === 0) ??
                                    draft.draft().pages[0]!;
                                  updateSelectedAction((action) => ({
                                    id: action.id,
                                    label: action.label,
                                    icon: action.icon,
                                    availableWhen: action.availableWhen,
                                    kind: "navigate",
                                    pageId: page.id,
                                    history: "push",
                                    params: defaultNavigationParams(page.id),
                                  }));
                                }
                                if (kind === "workflow") {
                                  const launcher = workflowLaunchers()[0];
                                  if (!launcher) return;
                                  updateSelectedAction((action) => ({
                                    id: action.id,
                                    label: action.label,
                                    icon: action.icon,
                                    availableWhen: action.availableWhen,
                                    kind: "workflow",
                                    launcherId: launcher.id,
                                    inputs: {},
                                  }));
                                }
                              }}
                            />
                            <Show when={workflowLaunchers().length === 0}>
                              <WorkflowPrerequisiteGuidance
                                hasWorkflows={props.catalog.workflows.length > 0}
                                kind="action"
                                onOpen={() => void openWorkflowConfiguration()}
                              />
                            </Show>
                          </Show>
                        </div>
                      </DetailPanel.Section>
                      <Show when={selectedNavigateAction()}>
                        {(action) => (
                          <DetailPanel.Section title="Navigation" icon="ti ti-route">
                            <div class="flex flex-col gap-3">
                              <Select
                                label="Target page"
                                value={() => action().pageId}
                                options={draft.draft().pages.map((page) => ({ id: page.id, label: page.title }))}
                                onValueChange={(pageId) =>
                                  pageId &&
                                  updateSelectedAction((action) =>
                                    action.kind === "navigate" ? { ...action, pageId, params: defaultNavigationParams(pageId) } : action,
                                  )
                                }
                              />
                              <Select
                                label="Browser history"
                                value={() => action().history}
                                options={[
                                  { id: "push", label: "Add to history" },
                                  { id: "replace", label: "Replace current page" },
                                ]}
                                onValueChange={(history) =>
                                  (history === "push" || history === "replace") &&
                                  updateSelectedAction((action) => (action.kind === "navigate" ? { ...action, history } : action))
                                }
                              />
                              {(() => {
                                const target = () => draft.draft().pages.find((page) => page.id === action().pageId);
                                return (
                                  <For each={Object.entries(target()?.parameters ?? {})}>
                                    {([parameterId, parameter]) => {
                                      const options = () => [
                                        ...(selectedPage().record?.tableId === parameter.tableId
                                          ? [{ id: "RECORD", label: "Current page record" }]
                                          : []),
                                        ...Object.entries(selectedPage().parameters)
                                          .filter(([, candidate]) => candidate.tableId === parameter.tableId)
                                          .map(([sourceId]) => ({ id: `PARAMS:${sourceId}`, label: `@params.${sourceId}` })),
                                      ];
                                      const current = () => action().params[parameterId];
                                      return (
                                        <Select
                                          label={`Value for ${parameterId}`}
                                          value={() => {
                                            const value = current();
                                            return value?.source === "RECORD" ? "RECORD" : value ? `PARAMS:${value.path}` : null;
                                          }}
                                          options={options()}
                                          error={() => (current() ? undefined : "Choose a compatible record source.")}
                                          onValueChange={(value) =>
                                            value &&
                                            updateSelectedAction((candidate) =>
                                              candidate.kind === "navigate"
                                                ? {
                                                    ...candidate,
                                                    params: {
                                                      ...candidate.params,
                                                      [parameterId]:
                                                        value === "RECORD"
                                                          ? { source: "RECORD", path: "id" }
                                                          : { source: "PARAMS", path: value.slice("PARAMS:".length) },
                                                    },
                                                  }
                                                : candidate,
                                            )
                                          }
                                        />
                                      );
                                    }}
                                  </For>
                                );
                              })()}
                            </div>
                          </DetailPanel.Section>
                        )}
                      </Show>
                      <Show when={selectedWorkflowAction()}>
                        {(workflowAction) => (
                          <DetailPanel.Section
                            title="Workflow"
                            icon="ti ti-player-play"
                            description="Workflow actions are available only to signed-in app readers."
                          >
                            <div class="flex flex-col gap-3">
                              <Select
                                label="App run option"
                                searchable
                                value={() => workflowAction().launcherId}
                                options={workflowLauncherOptions()}
                                onValueChange={(launcherId) =>
                                  launcherId &&
                                  updateSelectedAction((action) => {
                                    if (action.kind !== "workflow") return action;
                                    const launcher = workflowLaunchers().find((candidate) => candidate.id === launcherId);
                                    if ("showLabel" in action) {
                                      return {
                                        ...action,
                                        launcherId,
                                        inputs: launcher ? defaultRowWorkflowInputs(launcher) : {},
                                      };
                                    }
                                    return { ...action, launcherId, inputs: {} };
                                  })
                                }
                              />
                              <Show when={selectedLauncher()?.config.inputMode === "fixed"}>
                                <InlineGuidance>This App run option supplies its own fixed workflow inputs.</InlineGuidance>
                              </Show>
                              <Show when={selected().owner === "rows" && selectedLauncher() && !rowInputForLauncher(selectedLauncher()!)}>
                                <InlineGuidance tone="warning">
                                  This run option does not accept the selected{" "}
                                  {selectedSourceTableId() ? (tablesById().get(selectedSourceTableId()!)?.name ?? "table") : "table"} row.
                                  Use a prompt run option with a matching record input if the workflow should act on that row.{" "}
                                  <Button
                                    variant="text"
                                    size="xs"
                                    onClick={() => void openWorkflowConfiguration(selectedLauncher()?.workflowId)}
                                  >
                                    Open workflow
                                  </Button>
                                </InlineGuidance>
                              </Show>
                              <Show when={selectedLauncher()?.config.inputMode === "prompt"}>
                                <For each={selectedWorkflow()?.plan.inputs ?? []}>
                                  {(input) => {
                                    const boundTableId = () => {
                                      const workflow = selectedWorkflow();
                                      const value = workflow?.plan.bindings[`inputs.${input.name}.table`];
                                      return typeof value === "string" ? value : null;
                                    };
                                    const inputValue = () => workflowAction().inputs[input.name];
                                    const literalInputValue = () => {
                                      const value = inputValue();
                                      return value?.source === "LITERAL" ? value : null;
                                    };
                                    const sourceOptions = () => [
                                      { id: "LITERAL", label: "Fixed value" },
                                      ...(input.type === "record" && selectedPage().record?.tableId === boundTableId()
                                        ? [{ id: "RECORD", label: "Current page record" }]
                                        : []),
                                      ...(selected().owner === "rows" &&
                                      input.type === "record" &&
                                      selectedSourceTableId() === boundTableId()
                                        ? [{ id: "ROW", label: "Selected table row" }]
                                        : []),
                                      ...(input.type === "record"
                                        ? Object.entries(selectedPage().parameters)
                                            .filter(([, parameter]) => parameter.tableId === boundTableId())
                                            .map(([parameterId]) => ({ id: `PARAMS:${parameterId}`, label: `@params.${parameterId}` }))
                                        : []),
                                    ];
                                    return (
                                      <div class="flex flex-col gap-2">
                                        <Select
                                          label={typeof input.config.label === "string" ? input.config.label : input.name}
                                          description={typeof input.config.description === "string" ? input.config.description : undefined}
                                          placeholder="Not supplied"
                                          clearable
                                          value={() => {
                                            const value = inputValue();
                                            if (!value) return null;
                                            return value.source === "PARAMS" ? `PARAMS:${value.path}` : value.source;
                                          }}
                                          options={sourceOptions()}
                                          error={() =>
                                            !inputValue() && input.config.required
                                              ? "Choose where this required workflow input comes from."
                                              : diagnosticFor(selected().action.id, input.name)
                                          }
                                          onValueChange={(source) =>
                                            updateSelectedAction((action) => {
                                              if (action.kind !== "workflow") return action;
                                              if ("showLabel" in action) {
                                                const inputs: CustomAppRowAction["inputs"] = { ...action.inputs };
                                                if (!source) delete inputs[input.name];
                                                else if (source === "RECORD") inputs[input.name] = { source: "RECORD", path: "id" };
                                                else if (source === "ROW") inputs[input.name] = { source: "ROW", path: "id" };
                                                else if (source.startsWith("PARAMS:")) {
                                                  inputs[input.name] = { source: "PARAMS", path: source.slice("PARAMS:".length) };
                                                } else inputs[input.name] = { source: "LITERAL", value: null };
                                                return { ...action, inputs };
                                              }
                                              const inputs: CustomAppWorkflowAction["inputs"] = { ...action.inputs };
                                              if (!source) delete inputs[input.name];
                                              else if (source === "RECORD") inputs[input.name] = { source: "RECORD", path: "id" };
                                              else if (source.startsWith("PARAMS:")) {
                                                inputs[input.name] = { source: "PARAMS", path: source.slice("PARAMS:".length) };
                                              } else inputs[input.name] = { source: "LITERAL", value: null };
                                              return { ...action, inputs };
                                            })
                                          }
                                        />
                                        <Show when={literalInputValue()}>
                                          {(value) => (
                                            <JsonValueInput
                                              label={`${input.name} value`}
                                              value={value().value}
                                              onValueChange={(next) =>
                                                updateSelectedAction((action) => {
                                                  if (action.kind !== "workflow") return action;
                                                  if ("showLabel" in action) {
                                                    return {
                                                      ...action,
                                                      inputs: {
                                                        ...action.inputs,
                                                        [input.name]: { source: "LITERAL", value: next },
                                                      } as CustomAppRowAction["inputs"],
                                                    };
                                                  }
                                                  return {
                                                    ...action,
                                                    inputs: {
                                                      ...action.inputs,
                                                      [input.name]: { source: "LITERAL", value: next },
                                                    } as CustomAppWorkflowAction["inputs"],
                                                  };
                                                })
                                              }
                                            />
                                          )}
                                        </Show>
                                      </div>
                                    );
                                  }}
                                </For>
                              </Show>
                              <TextInput
                                label="Confirmation message"
                                description="Optional. Ask the user before invoking the workflow."
                                clearable
                                value={() => selectedWorkflowAction()?.confirm ?? ""}
                                onValueChange={(confirm) =>
                                  updateSelectedAction((action) =>
                                    action.kind === "workflow" ? { ...action, confirm: confirm || undefined } : action,
                                  )
                                }
                              />
                            </div>
                          </DetailPanel.Section>
                        )}
                      </Show>
                      <CustomAppAvailabilitySection
                        baseId={draft.draft().baseId}
                        contextKeys={contextKeys()}
                        targetLabel={selected().action.label}
                        value={() => selected().action.availableWhen?.query ?? ""}
                        onValueChange={(query) =>
                          updateSelectedAction((action) => ({
                            ...action,
                            availableWhen: query.trim() ? { query } : undefined,
                          }))
                        }
                        error={() => diagnosticFor(selected().action.id, "availableWhen")}
                      />
                      <DetailPanel.Section title="Order" icon="ti ti-arrows-sort" collapsible defaultOpen={false}>
                        <div class="flex flex-wrap gap-2">
                          <Button size="sm" variant="secondary" disabled={selected().index === 0} onClick={() => moveSelectedAction(-1)}>
                            <i class="ti ti-arrow-up" aria-hidden="true" /> Move up
                          </Button>
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={selected().index === selectedActionCount() - 1}
                            onClick={() => moveSelectedAction(1)}
                          >
                            <i class="ti ti-arrow-down" aria-hidden="true" /> Move down
                          </Button>
                        </div>
                      </DetailPanel.Section>
                      <DetailPanel.Section
                        title="Danger zone"
                        icon="ti ti-trash"
                        tone="danger"
                        description={
                          selected().owner === "actions" && selectedActionCount() <= 1
                            ? "Every Actions block needs at least one action."
                            : "Permanently remove this action from the draft."
                        }
                        collapsible
                        defaultOpen={false}
                      >
                        <Button
                          size="sm"
                          variant="danger"
                          disabled={selected().owner === "actions" && selectedActionCount() <= 1}
                          onClick={() => void removeSelectedAction()}
                        >
                          <i class="ti ti-trash" aria-hidden="true" /> Remove action
                        </Button>
                      </DetailPanel.Section>
                    </DetailPanel.Group>
                  </>
                );
              }}
            </Show>
          </DetailPanel.Body>
        </DetailPanel>
      </AppWorkspace.Detail>
    </>
  );
}
