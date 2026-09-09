import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  dialogCore,
  IconInput,
  NoticeCard,
  PanelDialog,
  panelDialogOptions,
  prompts,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicField, PublicView } from "../../../api/public-dto";
import type { DslQueryPreviewDiagnostic } from "../../../contracts";
import { createDraft } from "../editor-draft";
import { GqlSourceEditor } from "../query/GqlSourceEditor";
import { errorMessage } from "../utils/api-helpers";
import { gridsDialogMessages } from "./messages";
import { RecordDisplayConfigEditor } from "./RecordDisplayConfigEditor";

type Props = {
  baseId: string;
  tableId: string;
  viewId: string;
  /** Display name of the table this view scopes to. Surfaces in the
   *  Shared-toggle's explanation so the user reads concretely *which*
   *  table grants read access ("anyone who can read Books") instead
   *  of an abstract "this table". */
  tableName: string;
  initialView: PublicView;
  fields: PublicField[];
  onSaved?: (view: PublicView) => void;
};

export const openViewSettingsDialog = (props: Props) =>
  dialogCore.open<void>(
    (close, context) => <ViewSettingsDialog props={props} close={close} setDismissHandler={context.setDismissHandler} />,
    panelDialogOptions,
  );

function ViewSettingsDialog(props: { props: Props; close: () => void; setDismissHandler: (handler: () => void | Promise<void>) => void }) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const [dirty, setDirty] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const closeIfClean = async () => {
    if (saving()) return;
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };
  props.setDismissHandler(closeIfClean);
  return (
    <PanelDialog>
      <PanelDialog.Header title={t().viewSettings({ name: props.props.initialView.name })} icon="ti ti-table-spark" close={closeIfClean} />
      <ViewSettingsBody {...props.props} onDirtyChange={setDirty} onSavingChange={setSaving} />
    </PanelDialog>
  );
}

function ViewSettingsBody(props: Props & { onDirtyChange?: (dirty: boolean) => void; onSavingChange: (saving: boolean) => void }) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const [generalDirty, setGeneralDirty] = createSignal(false);
  const [queryDirty, setQueryDirty] = createSignal(false);
  const [generalSaving, setGeneralSaving] = createSignal(false);
  const [querySaving, setQuerySaving] = createSignal(false);
  createEffect(() => props.onDirtyChange?.(generalDirty() || queryDirty()));
  createEffect(() => props.onSavingChange(generalSaving() || querySaving()));
  return (
    <PanelDialog.Body>
      <GeneralSection
        viewId={props.initialView.id}
        initial={props.initialView}
        tableName={props.tableName}
        fields={props.fields}
        onSaved={props.onSaved}
        onDirtyChange={setGeneralDirty}
        onSavingChange={setGeneralSaving}
      />

      <QuerySourceSection
        baseId={props.baseId}
        viewId={props.initialView.id}
        initial={props.initialView}
        onSaved={props.onSaved}
        onDirtyChange={setQueryDirty}
        onSavingChange={setQuerySaving}
      />

      <PanelDialog.Section title={t().dangerZone} subtitle={t().deleteViewDescription} icon="ti ti-trash">
        <DeleteButton viewId={props.initialView.id} baseId={props.baseId} tableId={props.tableId} name={props.initialView.name} />
      </PanelDialog.Section>
    </PanelDialog.Body>
  );
}

// =============================================================================
// General — name + shared
// =============================================================================

function GeneralSection(props: {
  viewId: string;
  initial: PublicView;
  tableName: string;
  fields: PublicField[];
  onSaved?: (view: PublicView) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const draft = createDraft({
    name: props.initial.name,
    icon: props.initial.icon ?? "",
    displayConfig: props.initial.ui.displayConfig ?? { mode: "table" },
    shared: props.initial.ownerUserId === null,
  });
  const patch = (partial: Partial<ReturnType<typeof draft.draft>>) => {
    if (mut.loading()) return;
    draft.patch(partial);
    props.onDirtyChange?.(true);
  };
  const name = () => draft.draft().name;
  const [submitted, setSubmitted] = createSignal(false);
  const icon = () => draft.draft().icon;
  const displayConfig = () => draft.draft().displayConfig;
  const shared = () => draft.draft().shared;

  const mut = mutations.create<PublicView, void>({
    mutation: async () => {
      const res = await apiClient.views[":viewId"].$patch({
        param: { viewId: props.viewId },
        json: { name: name().trim(), icon: icon() || null, ui: { ...props.initial.ui, displayConfig: displayConfig() }, shared: shared() },
      });
      if (!res.ok) throw new Error(await errorMessage(res, t().failedToSave));
      return res.json();
    },
    onSuccess: (saved) => {
      draft.markSaved({
        name: saved.name,
        icon: saved.icon ?? "",
        displayConfig: saved.ui.displayConfig ?? { mode: "table" },
        shared: saved.ownerUserId === null,
      });
      props.onDirtyChange?.(false);
      props.onSaved?.(saved);
    },
  });
  createEffect(() => props.onSavingChange(mut.loading()));

  return (
    <PanelDialog.Section title={t().general} subtitle={t().viewGeneralDescription} icon="ti ti-id">
      <fieldset disabled={mut.loading()} class="flex min-w-0 flex-col gap-3">
        <Show when={mut.error()}>
          {(error) => (
            <NoticeCard tone="danger" role="alert">
              {error().message}
            </NoticeCard>
          )}
        </Show>
        <TextInput
          label={t().name}
          value={name}
          onValueChange={(v) => patch({ name: v })}
          error={submitted() && !name().trim() ? t().nameRequired : undefined}
          icon="ti ti-typography"
          required
        />
        <IconInput
          label={t().icon}
          value={() => icon() ?? null}
          onValueChange={(v) => patch({ icon: v ?? undefined })}
          placeholder={t().searchIcons}
        />
        <RecordDisplayConfigEditor
          value={displayConfig}
          onChange={(value) => patch({ displayConfig: value })}
          fields={() => props.fields}
        />
        <CheckboxCard
          label={t().sharedView}
          description={t().sharedViewDescription({ table: props.tableName })}
          icon="ti ti-users"
          variant="input"
          value={shared}
          onValueChange={(v) => patch({ shared: v })}
        />
        <Show when={draft.dirty()}>
          <Button
            variant="primary"
            size="sm"
            type="button"
            class="self-start"
            onClick={() => {
              setSubmitted(true);
              if (!name().trim()) return;
              mut.mutate(undefined);
            }}
            loading={mut.loading()}
            loadingLabel={t().savingView}
          >
            {t().save}
          </Button>
        </Show>
      </fieldset>
    </PanelDialog.Section>
  );
}

function QuerySourceSection(props: {
  baseId: string;
  viewId: string;
  initial: PublicView;
  onSaved?: (view: PublicView) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  type ValidationState = "idle" | "checking" | "valid" | "invalid" | "error";
  const draft = createDraft({
    source: props.initial.source,
  });
  const [validationState, setValidationState] = createSignal<ValidationState>("idle");
  const [diagnostics, setDiagnostics] = createSignal<DslQueryPreviewDiagnostic[]>([]);
  const [validationError, setValidationError] = createSignal<string | null>(null);
  const source = () => draft.draft().source;
  const patch = (value: string) => {
    if (mut.loading()) return;
    draft.patch({ source: value });
    props.onDirtyChange?.(draft.dirty());
  };
  let validationToken = 0;
  let validationAbort: AbortController | undefined;
  createEffect(() => {
    const value = source().trim();
    if (typeof window === "undefined") return;
    validationToken += 1;
    validationAbort?.abort();
    validationAbort = undefined;
    if (!value) {
      setValidationState("invalid");
      setDiagnostics([{ message: t().gqlRequired }]);
      setValidationError(null);
      return;
    }

    const token = validationToken;
    setValidationState("checking");
    const timeout = window.setTimeout(async () => {
      const abort = new AbortController();
      validationAbort = abort;
      try {
        const response = await apiClient.gql["by-base"][":baseId"]["compile-view"].$post(
          {
            param: { baseId: props.baseId },
            json: { query: value, currentTableId: props.initial.tableId, currentSource: { kind: "table", tableId: props.initial.tableId } },
          },
          { init: { signal: abort.signal } },
        );
        if (token !== validationToken || abort.signal.aborted) return;
        if (!response.ok) throw new Error(await errorMessage(response, t().validateGqlFailed));
        const result = await response.json();
        if (result.ok) {
          setDiagnostics([]);
          setValidationError(null);
          setValidationState("valid");
        } else {
          setDiagnostics(result.diagnostics);
          setValidationError(null);
          setValidationState("invalid");
        }
      } catch (error) {
        if (token !== validationToken || abort.signal.aborted) return;
        setDiagnostics([]);
        setValidationError(error instanceof Error ? error.message : t().validateGqlFailed);
        setValidationState("error");
      }
    }, 300);
    onCleanup(() => window.clearTimeout(timeout));
  });
  onCleanup(() => validationAbort?.abort());

  const mut = mutations.create<PublicView, void>({
    mutation: async () => {
      const trimmed = source().trim();
      if (!trimmed) throw new Error(t().gqlRequired);
      const compiledResponse = await apiClient.gql["by-base"][":baseId"]["compile-view"].$post({
        param: { baseId: props.baseId },
        json: { query: trimmed, currentTableId: props.initial.tableId, currentSource: { kind: "table", tableId: props.initial.tableId } },
      });
      if (!compiledResponse.ok) throw new Error(await errorMessage(compiledResponse, t().validateGqlFailed));
      const compiled = await compiledResponse.json();
      if (!compiled.ok)
        throw new Error(compiled.diagnostics.map((diagnostic) => formatDiagnostic(diagnostic, locale())).join("; ") || t().invalidGql);
      const res = await apiClient.views[":viewId"].$patch({
        param: { viewId: props.viewId },
        json: { source: compiled.source },
      });
      if (!res.ok) throw new Error(await errorMessage(res, t().saveGqlFailed));
      return res.json();
    },
    onSuccess: (saved) => {
      draft.markSaved({ source: saved.source });
      props.onDirtyChange?.(false);
      props.onSaved?.(saved);
    },
  });
  createEffect(() => props.onSavingChange(mut.loading()));

  return (
    <PanelDialog.Section title={t().query} subtitle={t().queryDescription} icon="ti ti-code">
      <fieldset disabled={mut.loading()} class="flex min-w-0 flex-col gap-3">
        <Show when={mut.error()}>
          {(error) => (
            <NoticeCard tone="danger" role="alert">
              {error().message}
            </NoticeCard>
          )}
        </Show>
        <NoticeCard tone="info" title={t().controlView} detail={t().controlViewDetail} />
        <label class="text-sm font-medium text-primary" for={`view-source-${props.viewId}`}>
          {t().gqlSource}
        </label>
        <GqlSourceEditor
          baseId={props.baseId}
          currentSource={{ kind: "table", tableId: props.initial.tableId }}
          id={`view-source-${props.viewId}`}
          name={`view-source-${props.viewId}`}
          value={source}
          onValueChange={patch}
          lines={8}
          spellcheck={false}
          aria-label={t().gqlSource}
          aria-invalid={validationState() === "invalid" || validationState() === "error"}
          error={validationState() === "invalid" || validationState() === "error"}
          variant="paper"
        />
        <div class="min-h-5 text-xs" aria-live="polite">
          <Show when={validationState() === "checking"}>
            <span class="text-dimmed">
              <i class="ti ti-loader-2 animate-spin" aria-hidden="true" /> {t().checkingGql}
            </span>
          </Show>
          <Show when={validationState() === "valid"}>
            <span class="text-success">
              <i class="ti ti-check" aria-hidden="true" /> {t().validGql}
            </span>
          </Show>
          <Show when={validationError()}>{(message) => <span class="text-danger">{message()}</span>}</Show>
          <Show when={diagnostics().length > 0}>
            <ul class="grid gap-1 text-danger">
              <For each={diagnostics().slice(0, 4)}>{(diagnostic) => <li>{formatDiagnostic(diagnostic, locale())}</li>}</For>
            </ul>
          </Show>
        </div>
        <Show when={draft.dirty()}>
          <Button
            variant="primary"
            size="sm"
            type="button"
            class="self-start"
            onClick={() => mut.mutate(undefined)}
            disabled={validationState() !== "valid"}
            loading={mut.loading()}
            loadingLabel={t().savingQuery}
          >
            {t().saveQuery}
          </Button>
        </Show>
      </fieldset>
    </PanelDialog.Section>
  );
}

const formatDiagnostic = (diagnostic: DslQueryPreviewDiagnostic, locale: string): string =>
  diagnostic.line && diagnostic.column
    ? gridsDialogMessages.resolve([locale]).t.lineColumn({ line: diagnostic.line, column: diagnostic.column, message: diagnostic.message })
    : diagnostic.message;

// =============================================================================
// Delete
// =============================================================================

function DeleteButton(props: { viewId: string; baseId: string; tableId: string; name: string }) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const mut = mutations.create<void, void>({
    mutation: async () => {
      const res = await apiClient.views[":viewId"].$delete({
        param: { viewId: props.viewId },
      });
      if (res.status >= 400) throw new Error(await errorMessage(res, t().deleteViewFailed));
    },
    onSuccess: () => navigateTo(`/app/grids/${props.baseId}/table/${props.tableId}`),
    onError: (e) => prompts.error(e.message),
  });

  const handleDelete = async () => {
    const ok = await prompts.confirm(t().deleteViewConfirm({ name: props.name }), {
      title: t().deleteViewQuestion,
      variant: "danger",
      confirmText: t().delete,
    });
    if (!ok) return;
    mut.mutate(undefined);
  };

  return (
    <Button variant="danger" size="sm" type="button" class="self-start" onClick={handleDelete} disabled={mut.loading()}>
      <i class="ti ti-trash" /> {t().deleteView}
    </Button>
  );
}
