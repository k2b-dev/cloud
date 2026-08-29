import { mutation as mutations } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  dialogCore,
  NoticeCard,
  PanelDialog,
  panelDialogWorkspaceOptions,
  prompts,
  Select,
  type TemplateVariable,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createEffect, createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { DocumentPreviewResponse, DocumentTemplateRenderer } from "../../../contracts";
import type { DocumentTemplateStarter } from "../../../document-template-starters";
import { requestDocumentTemplateDraftPreview } from "../documents/document-transfer-client";
import { documentMessages, documentStarterPresentation } from "../documents/messages";
import type { PublicDocumentTemplate } from "../documents/public-document-types";
import { GqlSourceEditor } from "../query/GqlSourceEditor";
import RecordPicker from "../records/RecordPicker";
import { errorMessage } from "../utils/api-helpers";
import { DocumentTemplateEditorPanes } from "./DocumentTemplateEditorPanes";
import { templateVariablesFromData } from "./DocumentTemplatePreviewData";
import { defaultDocumentNumberTemplate, defaultDocumentStarter, starterPayload } from "./document-template-dialog-defaults";

const DOCUMENT_TEMPLATE_VARIABLES: TemplateVariable[] = [
  { name: "record", kind: "object" },
  { name: "table", kind: "object" },
  { name: "template", kind: "object" },
  { name: "document", kind: "object" },
  { name: "date", kind: "object" },
  { name: "rows", kind: "array" },
  { name: "columns", kind: "array" },
  { name: "query", kind: "object" },
  { name: "document", kind: "object" },
  { name: "snapshot", kind: "object" },
  { name: "app", kind: "object" },
  { name: "business", kind: "object" },
  { name: "images", kind: "array" },
  { name: "primaryImage", kind: "object" },
];

const hasLiquidTags = (value: string) => /{{|{%/.test(value);

const DEFAULT_PROFILE_INPUT = `{
  "invoiceDate": {{ record.data.INVOICE_DATE | json }},
  "dueDate": {{ record.data.DUE_DATE | json }},
  "currency": "EUR",
  "seller": {
    "name": {{ business.legalName | json }},
    "vatId": {{ business.taxId | json }},
    "address": { "line1": "", "city": "", "postalCode": "", "countryCode": "DE" }
  },
  "buyer": {
    "name": {{ record.data.CUSTOMER | json }},
    "vatId": "DE000000000",
    "address": { "line1": "", "city": "", "postalCode": "", "countryCode": "DE" }
  },
  "buyerReference": {{ record.id | json }},
  "payment": { "iban": {{ business.iban | json }}, "accountName": {{ business.legalName | json }} },
  "lines": [{
    "name": {{ record.data.DESCRIPTION | json }},
    "quantity": {{ record.data.QUANTITY | json }},
    "unitPrice": {{ record.data.UNIT_PRICE | json }},
    "taxRate": {{ record.data.TAX_RATE | json }}
  }]
}`;

const readDocumentPreviewError = async (response: Response, fallback: string): Promise<{ message: string; phase: string | null }> => {
  try {
    const data = (await response.json()) as unknown;
    if (data && typeof data === "object") {
      const message = Object.getOwnPropertyDescriptor(data, "message")?.value;
      const phase = Object.getOwnPropertyDescriptor(data, "phase")?.value;
      return {
        message: typeof message === "string" && message.length > 0 ? message : fallback,
        phase: typeof phase === "string" ? phase : null,
      };
    }
  } catch {
    // Fall back below.
  }
  return { message: fallback, phase: null };
};

export function openDocumentTemplateEditorDialog(args: {
  baseId: string;
  tableId: string;
  tableName: string;
  template?: PublicDocumentTemplate;
  starter?: DocumentTemplateStarter;
  onSaved?: (template: PublicDocumentTemplate) => void;
}) {
  return dialogCore.open<void>((close) => <DocumentTemplateEditorDialog args={args} close={close} />, panelDialogWorkspaceOptions);
}

const templateReferenceHref = (_baseShortId: string) => "/app/grids/help/grids-documents-pdfs";

const openTemplateReferenceWindow = (baseShortId: string) => {
  window.open(templateReferenceHref(baseShortId), "grids-template-reference", "popup,width=1120,height=820,resizable=yes,scrollbars=yes");
};

function DocumentTemplateEditorDialog(props: {
  args: {
    baseId: string;
    tableId: string;
    tableName: string;
    template?: PublicDocumentTemplate;
    starter?: DocumentTemplateStarter;
    onSaved?: (template: PublicDocumentTemplate) => void;
  };
  close: () => void;
}) {
  const locale = useLocale();
  const t = () => documentMessages.resolve([locale()]).t;
  const diagnosticText = (diagnostic: { message: string; line?: number; column?: number }) =>
    diagnostic.line && diagnostic.column
      ? t().lineDiagnostic({ line: diagnostic.line, column: diagnostic.column, message: diagnostic.message })
      : diagnostic.message;
  const template = props.args.template;
  const starter = props.args.starter ?? defaultDocumentStarter();
  const starterPresentation = documentStarterPresentation(starter, locale());
  const initialStarter = starterPayload(starter, props.args.tableId);
  const initialName = template?.name ?? (starter.id === "blank" ? "" : starterPresentation.name);
  const initialDescription = template?.description ?? (starter.id === "blank" ? "" : starterPresentation.description);
  const initialRenderer = template?.renderer ?? initialStarter.renderer;
  const blankRenderer = defaultDocumentStarter().renderer;
  if (blankRenderer.kind !== "html") throw new Error(t().blankStarterHtml);
  const starterRenderer = initialStarter.renderer.kind === "html" ? initialStarter.renderer : blankRenderer;
  const [name, setName] = createSignal(initialName);
  const [description, setDescription] = createSignal(initialDescription);
  const [numberTemplate, setNumberTemplate] = createSignal(
    initialRenderer.kind === "html" ? initialRenderer.numberTemplate : defaultDocumentNumberTemplate,
  );
  const [filenameTemplate, setFilenameTemplate] = createSignal(
    initialRenderer.kind === "html" ? initialRenderer.filenameTemplate : "{{ document.number }}.pdf",
  );
  const [source, setSource] = createSignal(template?.source ?? initialStarter.source);
  const [html, setHtml] = createSignal(initialRenderer.kind === "html" ? initialRenderer.body : starterRenderer.body);
  const [profileKey, setProfileKey] = createSignal<string | null>(
    initialRenderer.kind === "profile" ? `${initialRenderer.id}@${initialRenderer.version}` : null,
  );
  const [profileInput, setProfileInput] = createSignal<string | null>(
    initialRenderer.kind === "profile" ? initialRenderer.inputTemplate : null,
  );
  const [profiles] = createResource(async () => {
    const response = await fetch("/api/grids/documents/renderers");
    if (!response.ok) throw new Error(await errorMessage(response, t().failedLoadRenderers));
    return response.json() as Promise<Array<{ id: string; version: number; title: string; description: string }>>;
  });
  const selectProfile = (value: string | null) => {
    setProfileKey(value);
    setProfileInput(value ? (profileInput() ?? DEFAULT_PROFILE_INPUT) : null);
  };
  const selectedProfile = () =>
    profiles()?.find((profile) => `${profile.id}@${profile.version}` === profileKey()) ??
    (initialRenderer.kind === "profile" && `${initialRenderer.id}@${initialRenderer.version}` === profileKey()
      ? { ...initialRenderer, title: initialRenderer.id, description: "" }
      : undefined);
  const [headerHtml, setHeaderHtml] = createSignal(initialRenderer.kind === "html" ? (initialRenderer.header ?? "") : "");
  const [footerHtml, setFooterHtml] = createSignal(initialRenderer.kind === "html" ? (initialRenderer.footer ?? "") : "");
  const [pageCss, setPageCss] = createSignal(initialRenderer.kind === "html" ? (initialRenderer.css ?? "") : "");
  const [enabled, setEnabled] = createSignal(template?.enabled ?? false);
  const [previewRecordId, setPreviewRecordId] = createSignal("");
  const [previewData, setPreviewData] = createSignal<DocumentPreviewResponse | null>(null);
  const [previewDataLoading, setPreviewDataLoading] = createSignal(false);
  const [previewDataError, setPreviewDataError] = createSignal<string | null>(null);
  const [previewSourceError, setPreviewSourceError] = createSignal<string | null>(null);
  const [lastSuccessfulPreviewSignature, setLastSuccessfulPreviewSignature] = createSignal<string | null>(null);
  const [gqlDiagnostics, setGqlDiagnostics] = createSignal<Array<{ message: string; line?: number; column?: number }>>([]);
  const [gqlDiagnosticError, setGqlDiagnosticError] = createSignal<string | null>(null);
  const templateVariables = createMemo<TemplateVariable[]>(() => {
    const byName = new Map<string, TemplateVariable>();
    for (const variable of [...DOCUMENT_TEMPLATE_VARIABLES, ...templateVariablesFromData(previewData()?.data)])
      byName.set(variable.name, variable);
    return [...byName.values()];
  });
  const currentRenderer = (): DocumentTemplateRenderer | null => {
    const profile = selectedProfile();
    if (profileKey()) {
      if (!profile) return null;
      return { kind: "profile", id: profile.id, version: profile.version, inputTemplate: profileInput()?.trim() ?? "" };
    }
    return {
      kind: "html",
      body: html().trim(),
      header: headerHtml().trim() || undefined,
      footer: footerHtml().trim() || undefined,
      css: pageCss().trim() || undefined,
      numberTemplate: numberTemplate().trim(),
      filenameTemplate: filenameTemplate().trim(),
    };
  };
  const dirty = () =>
    name() !== initialName ||
    description() !== initialDescription ||
    source() !== (template?.source ?? initialStarter.source) ||
    JSON.stringify(currentRenderer()) !== JSON.stringify(initialRenderer) ||
    enabled() !== (template?.enabled ?? false);

  const currentPreviewSignature = () =>
    JSON.stringify({
      source: source().trim(),
      renderer: currentRenderer(),
      recordId: previewRecordId().trim(),
    });
  const hasCurrentSuccessfulPreview = () => lastSuccessfulPreviewSignature() === currentPreviewSignature();

  const closeIfClean = async () => {
    if (await confirmDiscardIfDirty(dirty)) props.close();
  };

  const saveMut = mutations.create<PublicDocumentTemplate, void>({
    mutation: async () => {
      const renderer = currentRenderer();
      if (!renderer) throw new Error(t().selectRenderer);
      const payload = {
        name: name().trim(),
        description: description().trim() || null,
        source: source().trim(),
        renderer,
        enabled: enabled(),
      };
      if (!payload.name) throw new Error(t().nameRequired);
      if (!payload.source) throw new Error(t().gqlSourceRequired);
      if (renderer.kind === "html" && !renderer.body) throw new Error(t().htmlBodyRequired);
      if (renderer.kind === "html" && !renderer.numberTemplate) throw new Error(t().numberPatternRequired);
      if (renderer.kind === "html" && !renderer.filenameTemplate) throw new Error(t().filenameTemplateRequired);
      if (renderer.kind === "profile" && !renderer.inputTemplate) throw new Error(t().rendererInputRequired);
      const res = template
        ? await apiClient.documents.templates[":templateId"].$patch({ param: { templateId: template.id }, json: payload })
        : await apiClient.documents.templates["by-table"][":tableId"].$post({ param: { tableId: props.args.tableId }, json: payload });
      if (!res.ok) throw new Error(await errorMessage(res, t().failedSaveTemplate));
      return res.json();
    },
    onSuccess: (saved) => {
      props.args.onSaved?.(saved);
      props.close();
    },
    onError: (e) => prompts.error(e.message),
  });

  const previewPdf = async () => {
    const recordId = previewRecordId().trim();
    if (!recordId) throw new Error(t().previewRecordRequired);
    const renderer = currentRenderer();
    if (!renderer) throw new Error(t().selectRenderer);
    const payload = {
      source: source().trim(),
      renderer,
      recordId,
    };
    const signature = currentPreviewSignature();
    const response = await requestDocumentTemplateDraftPreview({
      tableId: props.args.tableId,
      templateId: template?.id,
      draft: payload,
    });
    if (response.ok) setLastSuccessfulPreviewSignature(signature);
    return response;
  };

  const saveTemplate = async () => {
    const warnings: string[] = [];
    if (gqlDiagnosticError()) warnings.push(gqlDiagnosticError()!);
    if (previewSourceError()) warnings.push(previewSourceError()!);
    if (gqlDiagnostics().length > 0) warnings.push(...gqlDiagnostics().slice(0, 3).map(diagnosticText));
    if (enabled() && !hasCurrentSuccessfulPreview()) {
      warnings.push(t().enabledWithoutPreview);
    }
    if (warnings.length > 0) {
      const confirmed = await prompts.confirm(t().saveAnywayPrompt({ warnings: warnings.map((warning) => `• ${warning}`).join("\n") }), {
        title: t().templateWarnings,
        confirmText: t().saveAnyway,
      });
      if (!confirmed) return;
    }
    saveMut.mutate(undefined);
  };

  let previewDataToken = 0;
  let gqlDiagnosticsToken = 0;
  createEffect(() => {
    const sourceText = source().trim();
    if (!sourceText || hasLiquidTags(sourceText)) {
      gqlDiagnosticsToken += 1;
      setGqlDiagnostics([]);
      setGqlDiagnosticError(null);
      return;
    }

    const token = ++gqlDiagnosticsToken;
    const timeout = window.setTimeout(async () => {
      try {
        const response = await apiClient.gql["by-base"][":baseId"].autocomplete.$post({
          param: { baseId: props.args.baseId },
          json: {
            query: sourceText,
            caret: sourceText.length,
            currentTableId: props.args.tableId,
            currentSource: { kind: "table", tableId: props.args.tableId },
          },
        });
        if (token !== gqlDiagnosticsToken) return;
        if (!response.ok) throw new Error(await errorMessage(response, t().couldNotValidateGql));
        const data = await response.json();
        setGqlDiagnostics(data.diagnostics ?? []);
        setGqlDiagnosticError(null);
      } catch (e) {
        if (token === gqlDiagnosticsToken) {
          setGqlDiagnostics([]);
          setGqlDiagnosticError(e instanceof Error ? e.message : t().couldNotValidateGql);
        }
      }
    }, 300);
    onCleanup(() => window.clearTimeout(timeout));
  });

  createEffect(() => {
    const recordId = previewRecordId().trim();
    const sourceText = source().trim();
    const renderer = currentRenderer();
    if (!recordId || !sourceText || !renderer || !(renderer.kind === "html" ? renderer.body : renderer.inputTemplate)) {
      previewDataToken += 1;
      setPreviewData(null);
      setPreviewDataError(null);
      setPreviewSourceError(null);
      setPreviewDataLoading(false);
      return;
    }

    const token = ++previewDataToken;
    setPreviewDataLoading(true);
    setPreviewDataError(null);
    setPreviewSourceError(null);
    const timeout = window.setTimeout(async () => {
      try {
        const payload = {
          source: sourceText,
          renderer,
          recordId,
        };
        const response = template
          ? await apiClient.documents.templates[":templateId"]["preview-data-draft"].$post({
              param: { templateId: template.id },
              json: payload,
            })
          : await apiClient.documents.templates["by-table"][":tableId"]["preview-data-draft"].$post({
              param: { tableId: props.args.tableId },
              json: payload,
            });
        if (token !== previewDataToken) return;
        if (!response.ok) {
          const details = await readDocumentPreviewError(response, t().couldNotLoadPreviewData);
          setPreviewSourceError(details.phase === "source" ? details.message : null);
          throw new Error(details.message);
        }
        setPreviewData(await response.json());
        setPreviewSourceError(null);
      } catch (e) {
        if (token === previewDataToken) {
          setPreviewData(null);
          setPreviewDataError(e instanceof Error ? e.message : t().couldNotLoadPreviewData);
        }
      } finally {
        if (token === previewDataToken) setPreviewDataLoading(false);
      }
    }, 350);
    onCleanup(() => window.clearTimeout(timeout));
  });

  return (
    <PanelDialog>
      <PanelDialog.Header
        title={t().editOrAddTemplate({ editing: Boolean(template), table: props.args.tableName })}
        icon="ti ti-file-type-pdf"
        close={closeIfClean}
        actions={
          <Button variant="secondary" size="sm" type="button" onClick={() => openTemplateReferenceWindow(props.args.baseId)}>
            <i class="ti ti-external-link" /> {t().reference}
          </Button>
        }
      />
      <PanelDialog.Body>
        <div class="flex h-full min-h-0 flex-col gap-2">
          <div class="grid shrink-0 gap-2 lg:grid-cols-2">
            <TextInput label={t().name} value={name} onValueChange={setName} icon="ti ti-typography" required />
            <TextInput
              label={t().description}
              value={description}
              onValueChange={setDescription}
              icon="ti ti-align-left"
              placeholder={t().optional}
            />
            <Select
              label={t().renderer}
              description={t().chooseRenderer}
              value={profileKey}
              onValueChange={selectProfile}
              options={(profiles() ?? []).map((profile) => ({
                id: `${profile.id}@${profile.version}`,
                label: profile.title,
                description: profile.description,
              }))}
              placeholder={t().htmlPdf}
              clearable
            />
            <div>
              <TextInput
                label={t().documentNumber}
                description={t().numberPatternDescription}
                value={numberTemplate}
                onValueChange={setNumberTemplate}
                icon="ti ti-hash"
                placeholder={defaultDocumentNumberTemplate}
                required
                disabled={profileKey() !== null}
              />
              <NoticeCard tone={template?.numberSeries?.migrationNote ? "warning" : "info"} icon={false} class="mt-2" role="status">
                {profileKey()
                  ? t().rendererOwnsNumbering
                  : template?.numberSeries
                    ? t().numberSeries({
                        id: template.numberSeries.id,
                        value: new Intl.NumberFormat(locale()).format(template.numberSeries.lastValue),
                      })
                    : t().numberSeriesCreated}
              </NoticeCard>
            </div>
            <div>
              <TextInput
                label={t().filename}
                description={t().filenamePatternDescription}
                value={filenameTemplate}
                onValueChange={setFilenameTemplate}
                icon="ti ti-file-text"
                placeholder="{{ document.number }}.pdf"
                required
                disabled={profileKey() !== null}
              />
            </div>
            <div class="lg:col-span-2">
              <CheckboxCard
                value={enabled}
                onValueChange={setEnabled}
                label={t().enabled}
                description={t().enabledDescription}
                icon="ti ti-file-check"
                variant="input"
              />
            </div>
            <div class="lg:col-span-2">
              <RecordPicker
                tableId={props.args.tableId}
                templateId={template?.id}
                label={t().previewRecord}
                value={previewRecordId}
                onChange={setPreviewRecordId}
                placeholder={t().searchPreviewRecord}
              />
            </div>
            <div class="lg:col-span-2">
              <div class="mb-1.5 flex items-center justify-between gap-2">
                <div class="text-sm font-medium text-primary">
                  {t().gqlSource} <span class="text-red-500">*</span>
                </div>
                <span class="text-xs text-dimmed">{t().scopedTo({ table: props.args.tableName })}</span>
              </div>
              <GqlSourceEditor
                baseId={props.args.baseId}
                currentSource={{ kind: "table", tableId: props.args.tableId }}
                value={source}
                onValueChange={setSource}
                lines={4}
                placeholder={`from table ${props.args.tableName}\nwhere record.id = "{{ record.id }}"\nlimit 1`}
                spellcheck={false}
                aria-label={t().gqlSource}
              />
              <Show when={gqlDiagnosticError() || previewSourceError() || gqlDiagnostics().length > 0}>
                <NoticeCard tone="danger" icon={false} class="mt-2">
                  <Show
                    when={gqlDiagnosticError() || previewSourceError()}
                    fallback={
                      <ul class="grid gap-1">
                        <For each={gqlDiagnostics().slice(0, 4)}>{(diagnostic) => <li>{diagnosticText(diagnostic)}</li>}</For>
                      </ul>
                    }
                  >
                    {(message) => message()}
                  </Show>
                </NoticeCard>
              </Show>
            </div>
          </div>

          <DocumentTemplateEditorPanes
            rendererKind={() => (profileKey() ? "profile" : "html")}
            body={() => profileInput() ?? html()}
            setBody={(value) => (profileKey() ? setProfileInput(value) : setHtml(value))}
            header={headerHtml}
            setHeader={setHeaderHtml}
            footer={footerHtml}
            setFooter={setFooterHtml}
            css={pageCss}
            setCss={setPageCss}
            templateVariables={templateVariables}
            previewData={previewData}
            previewDataLoading={previewDataLoading}
            previewDataError={previewDataError}
            source={source}
            previewRecordId={previewRecordId}
            previewPdf={previewPdf}
          />
        </div>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <span />
        <div class="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" type="button" onClick={closeIfClean}>
            {t().cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            onClick={() => void saveTemplate()}
            loading={saveMut.loading()}
            loadingLabel={t().savingTemplate}
          >
            {t().saveTemplate}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
