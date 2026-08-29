import { mutation as mutations, timed } from "@k2b/stdlib/solid";
import {
  Button,
  CheckboxCard,
  dialogCore,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  Select,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicFederatedRevisionView, PublicFederatedSourceCandidate, PublicField } from "../../../api/public-dto";
import { gridsFieldMessages } from "../fields/messages";
import { errorMessage } from "../utils/api-helpers";
import { gridsDialogMessages } from "./messages";

type MappingDraft = PublicFederatedRevisionView["mappings"][number];
type FederatedDiagnostic = PublicFederatedRevisionView["diagnostics"][number];
type PublicFederatedTableConfig = { current: PublicFederatedRevisionView | null; draft: PublicFederatedRevisionView };
type SelectOption = { id: string; label: string };
const MAX_SOURCES = 50;

const selectOptions = (field: PublicField | undefined): SelectOption[] => {
  if (!field || field.type !== "select") return [];
  const options = (field.config as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (!option || typeof option !== "object") return [];
    const { id, label } = option as { id?: unknown; label?: unknown };
    return typeof id === "string" && typeof label === "string" ? [{ id, label }] : [];
  });
};

export const openFederatedTableDialog = (args: { tableId: string; tableName: string; targetFields: PublicField[] }) =>
  dialogCore.open<void>((close) => <FederatedTableDialog {...args} close={close} />, panelDialogOptions);

function FederatedTableDialog(props: { tableId: string; tableName: string; targetFields: PublicField[]; close: () => void }) {
  const locale = useLocale();
  const t = () => gridsDialogMessages.resolve([locale()]).t;
  const fieldT = () => gridsFieldMessages.resolve([locale()]).t;
  const [config, setConfig] = createSignal<PublicFederatedTableConfig | null>(null);
  const [candidates, setCandidates] = createSignal<PublicFederatedSourceCandidate[]>([]);
  const [candidateCache, setCandidateCache] = createSignal<Record<string, PublicFederatedSourceCandidate>>({});
  const [candidateQuery, setCandidateQuery] = createSignal("");
  const [candidateTotal, setCandidateTotal] = createSignal(0);
  const [candidateLoading, setCandidateLoading] = createSignal(false);
  const [sourceFields, setSourceFields] = createSignal<Record<string, PublicField[]>>({});
  const [selectedSources, setSelectedSources] = createSignal<string[]>([]);
  const [mappingSourceId, setMappingSourceId] = createSignal("");
  const [mappings, setMappings] = createSignal<MappingDraft[]>([]);
  const [validationDiagnostics, setValidationDiagnostics] = createSignal<FederatedDiagnostic[]>([]);
  const [loading, setLoading] = createSignal(true);

  let candidateRequest: AbortController | null = null;
  const sourceTables = createMemo(() => Object.values(candidateCache()).map((candidate) => ({ ...candidate.table, base: candidate.base })));
  const selectedTables = createMemo(() =>
    selectedSources().flatMap((sourceId) => {
      const table = sourceTables().find((candidate) => candidate.id === sourceId);
      return table ? [table] : [];
    }),
  );
  const mappingTable = createMemo(() => selectedTables().find((table) => table.id === mappingSourceId()) ?? selectedTables()[0]);
  const candidateGroups = createMemo(() => {
    const groups = new Map<string, { base: PublicFederatedSourceCandidate["base"]; items: PublicFederatedSourceCandidate[] }>();
    for (const candidate of candidates()) {
      const group = groups.get(candidate.base.id) ?? { base: candidate.base, items: [] };
      group.items.push(candidate);
      groups.set(candidate.base.id, group);
    }
    return [...groups.values()];
  });
  const canonicalFields = createMemo(() =>
    props.targetFields.filter((field) => !field.deletedAt && !["formula", "lookup", "rollup", "html_template"].includes(field.type)),
  );
  const hiddenSourceCount = createMemo(() => config()?.draft.sources.filter((source) => source.sourceTableId === null).length ?? 0);

  const loadFields = async (tableId: string) => {
    if (sourceFields()[tableId]) return;
    const response = await apiClient.fields["by-table"][":tableId"].$get({ param: { tableId } });
    if (!response.ok) throw new Error(await errorMessage(response, t().sourceFieldsLoadFailed));
    const fields = await response.json();
    setSourceFields((current) => ({ ...current, [tableId]: fields }));
  };

  const loadCandidates = async (params: { reset: boolean; query?: string } = { reset: false }) => {
    candidateRequest?.abort();
    candidateRequest = new AbortController();
    const query = params.query ?? candidateQuery();
    const offset = params.reset ? 0 : candidates().length;
    setCandidateLoading(true);
    try {
      const response = await apiClient.tables[":tableId"].federation["source-candidates"].$get(
        {
          param: { tableId: props.tableId },
          query: { q: query.trim(), limit: "50", offset: String(offset) },
        },
        { init: { signal: candidateRequest.signal } },
      );
      if (!response.ok) throw new Error(await errorMessage(response, t().sourceTablesLoadFailed));
      const page = await response.json();
      setCandidateTotal(page.total);
      setCandidates((current) => {
        const next = params.reset ? page.items : [...current, ...page.items];
        return [...new Map(next.map((candidate) => [candidate.table.id, candidate])).values()];
      });
      setCandidateCache((current) => ({
        ...current,
        ...Object.fromEntries(page.items.map((candidate) => [candidate.table.id, candidate])),
      }));
    } finally {
      setCandidateLoading(false);
    }
  };

  const searchCandidates = timed.debounce((value: string) => {
    void loadCandidates({ reset: true, query: value }).catch((error) => {
      if ((error as Error).name !== "AbortError") prompts.error((error as Error).message);
    });
  }, 250);
  onCleanup(() => {
    searchCandidates.cancel();
    candidateRequest?.abort();
  });

  const load = async () => {
    setLoading(true);
    try {
      searchCandidates.cancel();
      setCandidates([]);
      setCandidateCache({});
      const configResponse = await apiClient.tables[":tableId"].federation.$get({ param: { tableId: props.tableId } });
      if (!configResponse.ok) throw new Error(await errorMessage(configResponse, t().combinedConfigLoadFailed));
      const nextConfig = await configResponse.json();
      const sourceIds = nextConfig.draft.sources.flatMap((source) => (source.sourceTableId ? [source.sourceTableId] : []));
      setConfig(nextConfig);
      setSelectedSources(sourceIds);
      setMappingSourceId(sourceIds[0] ?? "");
      setMappings(nextConfig.draft.mappings);
      setValidationDiagnostics(nextConfig.draft.diagnostics);
      await loadCandidates({ reset: true, query: candidateQuery() });
      const accessibleSourceIds = sourceIds.filter((sourceId) => candidateCache()[sourceId] !== undefined);
      await Promise.all(accessibleSourceIds.map(loadFields));
    } catch (error) {
      prompts.error(error instanceof Error ? error.message : t().combinedConfigLoadFailed);
    } finally {
      setLoading(false);
    }
  };

  onMount(() => void load());

  const toggleSource = async (tableId: string, enabled: boolean) => {
    if (enabled) {
      if (selectedSources().length + hiddenSourceCount() >= MAX_SOURCES) {
        prompts.error(t().sourceLimit({ count: MAX_SOURCES }));
        return;
      }
      setSelectedSources((current) => [...current, tableId]);
      setMappingSourceId(tableId);
      setValidationDiagnostics([]);
      try {
        await loadFields(tableId);
      } catch (error) {
        setSelectedSources((current) => current.filter((id) => id !== tableId));
        prompts.error(error instanceof Error ? error.message : t().sourceFieldsLoadFailed);
      }
      return;
    }
    setSelectedSources((current) => current.filter((id) => id !== tableId));
    if (mappingSourceId() === tableId) {
      setMappingSourceId(selectedSources().find((id) => id !== tableId) ?? "");
    }
    setMappings((current) => current.filter((mapping) => mapping.sourceTableId !== tableId));
    setValidationDiagnostics([]);
  };

  const mappingFor = (sourceTableId: string, targetFieldId: string) =>
    mappings().find((mapping) => mapping.sourceTableId === sourceTableId && mapping.targetFieldId === targetFieldId);

  const setMapping = (sourceTableId: string, targetFieldId: string, sourceFieldId: string) => {
    setValidationDiagnostics([]);
    setMappings((current) => {
      const rest = current.filter((mapping) => !(mapping.sourceTableId === sourceTableId && mapping.targetFieldId === targetFieldId));
      return sourceFieldId ? [...rest, { sourceTableId, targetFieldId, sourceFieldId, config: {} }] : rest;
    });
  };

  const selectedSourceField = (sourceTableId: string, targetFieldId: string) => {
    const sourceFieldId = mappingFor(sourceTableId, targetFieldId)?.sourceFieldId;
    return sourceFields()[sourceTableId]?.find((field) => field.id === sourceFieldId);
  };

  const setOptionMapping = (sourceTableId: string, targetFieldId: string, sourceOptionId: string, targetOptionId: string) => {
    setValidationDiagnostics([]);
    setMappings((current) =>
      current.map((mapping) => {
        if (mapping.sourceTableId !== sourceTableId || mapping.targetFieldId !== targetFieldId) return mapping;
        const previous = (mapping.config?.optionMap ?? {}) as Record<string, string>;
        const optionMap = { ...previous };
        if (targetOptionId) optionMap[sourceOptionId] = targetOptionId;
        else delete optionMap[sourceOptionId];
        return { ...mapping, config: { ...mapping.config, optionMap } };
      }),
    );
  };

  const compatibleOptions = (sourceTableId: string, target: PublicField) =>
    (sourceFields()[sourceTableId] ?? [])
      .filter((field) => !field.deletedAt && (field.type === target.type || ["formula", "lookup", "rollup"].includes(field.type)))
      .map((field) => ({ id: field.id, label: `${field.name} · ${fieldT().typeLabel({ type: field.type })}`, icon: "ti ti-columns" }));

  const draftInput = () => ({
    sourceTableIds: selectedSources(),
    mappings: mappings(),
  });

  const saveDraft = async (): Promise<PublicFederatedRevisionView> => {
    const draftToken = config()?.draft.revisionToken;
    if (!draftToken) throw new Error(t().combinedNotLoaded);
    const response = await apiClient.tables[":tableId"].federation.draft.$put({
      param: { tableId: props.tableId },
      json: { ...draftInput(), draftToken },
    });
    if (!response.ok) throw new Error(await errorMessage(response, t().saveCombinedDraftFailed));
    const draft = await response.json();
    setConfig((current) => (current ? { ...current, draft } : current));
    setValidationDiagnostics(draft.diagnostics);
    return draft;
  };

  const validateMutation = mutations.create<{ valid: boolean; diagnostics: FederatedDiagnostic[] }, void>({
    mutation: async () => {
      const response = await apiClient.tables[":tableId"].federation.validate.$post({
        param: { tableId: props.tableId },
        json: draftInput(),
      });
      if (!response.ok) throw new Error(await errorMessage(response, t().validateCombinedFailed));
      return response.json();
    },
    onSuccess: (result) => {
      setValidationDiagnostics(result.diagnostics);
      if (result.valid) prompts.success(t().combinedValid);
    },
    onError: (error) => prompts.error(error.message),
  });

  const saveMutation = mutations.create<PublicFederatedRevisionView, void>({
    mutation: saveDraft,
    onSuccess: () => prompts.success(t().combinedDraftSaved),
    onError: (error) => prompts.error(error.message),
  });
  const publishMutation = mutations.create<PublicFederatedRevisionView, void>({
    mutation: async () => {
      await saveDraft();
      const response = await apiClient.tables[":tableId"].federation.publish.$post({ param: { tableId: props.tableId } });
      if (!response.ok) throw new Error(await errorMessage(response, t().publishCombinedFailed));
      return response.json();
    },
    onSuccess: () => {
      prompts.success(t().combinedPublished);
      void load();
    },
    onError: (error) => prompts.error(error.message),
  });

  const revoke = async (sourceTableId: string) => {
    const confirmed = await prompts.confirm(t().revokeSourceConfirm, {
      title: t().revokeSourceQuestion,
      variant: "danger",
      confirmText: t().revoke,
    });
    if (!confirmed) return;
    const response = await apiClient.tables[":tableId"].federation.sources[":sourceTableId"].revoke.$post({
      param: { tableId: props.tableId, sourceTableId },
    });
    if (!response.ok) return prompts.error(await errorMessage(response, t().revokeSourceFailed));
    await load();
  };

  return (
    <PanelDialog>
      <PanelDialog.Header title={t().combinedFor({ table: props.tableName })} icon="ti ti-table-share" close={props.close} />
      <PanelDialog.Body>
        <Show when={!loading()} fallback={<Placeholder state="loading" title={t().loadingCombined} description={t().readingSources} />}>
          <PanelDialog.Section title={t().sources} subtitle={t().sourcesDetail} icon="ti ti-database-share">
            <TextInput
              aria-label={t().searchSourceAria}
              value={candidateQuery}
              onValueChange={(value) => {
                setCandidateQuery(value);
                searchCandidates.debouncedFn(value);
              }}
              icon="ti ti-search"
              placeholder={t().searchSources}
            />
            <Show
              when={candidates().length > 0}
              fallback={
                <Placeholder
                  state={candidateLoading() ? "loading" : "empty"}
                  icon={candidateLoading() ? "ti ti-loader-2 animate-spin" : "ti ti-database-off"}
                  title={candidateLoading() ? t().loadingSources : t().noSources}
                  description={candidateQuery().trim() ? t().noSourceMatch : t().noAdminSources}
                />
              }
            >
              <For each={candidateGroups()}>
                {(group) => (
                  <div class="space-y-2">
                    <div class="text-xs font-semibold text-dimmed">{group.base.name}</div>
                    <For each={group.items}>
                      {(candidate) => (
                        <CheckboxCard
                          label={candidate.table.name}
                          description={t().fieldCount({ count: candidate.fieldCount })}
                          icon={candidate.table.icon ?? "ti ti-table"}
                          variant="input"
                          value={() => selectedSources().includes(candidate.table.id)}
                          onValueChange={(enabled) => void toggleSource(candidate.table.id, enabled)}
                        />
                      )}
                    </For>
                  </div>
                )}
              </For>
              <Show when={candidates().length < candidateTotal()}>
                <Button
                  variant="secondary"
                  size="sm"
                  type="button"
                  class="self-center"
                  disabled={candidateLoading()}
                  onClick={() => void loadCandidates().catch((error) => prompts.error((error as Error).message))}
                >
                  {candidateLoading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-dots" />} {t().loadMoreSources}
                </Button>
              </Show>
            </Show>
            <Show when={hiddenSourceCount() > 0}>
              <div class="paper flex items-start gap-2 p-3 text-sm text-secondary">
                <i class="ti ti-lock mt-0.5" aria-hidden="true" />
                <span>{t().hiddenSources({ count: hiddenSourceCount() })}</span>
              </div>
            </Show>
          </PanelDialog.Section>

          <PanelDialog.Section title={t().fieldMappings} subtitle={t().fieldMappingsDetail} icon="ti ti-arrows-join-2">
            <Show
              when={selectedTables().length > 0 && canonicalFields().length > 0}
              fallback={
                <Placeholder
                  icon="ti ti-columns"
                  title={t().noEditableMappings}
                  description={hiddenSourceCount() > 0 ? t().hiddenMappingsDetail : t().addSourceFirst}
                />
              }
            >
              <Select
                label={t().sourceToMap}
                description={t().selectedSources({ count: selectedTables().length })}
                value={() => mappingTable()?.id ?? ""}
                onValueChange={setMappingSourceId}
                options={selectedTables().map((table) => ({
                  id: table.id,
                  label: `${table.name} · ${table.base.name}`,
                  icon: table.icon ?? "ti ti-table",
                }))}
              />
              <Show when={mappingTable()} keyed>
                {(table) => (
                  <div class="paper space-y-2 p-3">
                    <div>
                      <div class="text-sm font-semibold text-primary">{table.name}</div>
                      <div class="text-xs text-dimmed">{table.base.name}</div>
                    </div>
                    <For each={canonicalFields()}>
                      {(target) => {
                        const sourceSelectOptions = () => selectOptions(selectedSourceField(table.id, target.id));
                        const targetSelectOptions = () =>
                          selectOptions(target).map((option) => ({ id: option.id, label: option.label, icon: "ti ti-tag" }));
                        return (
                          <div class="space-y-2">
                            <Select
                              label={target.name}
                              description={t().mappingFieldDetail({ type: fieldT().typeLabel({ type: target.type }) })}
                              value={() => mappingFor(table.id, target.id)?.sourceFieldId ?? ""}
                              onValueChange={(sourceFieldId) => setMapping(table.id, target.id, sourceFieldId ?? "")}
                              options={compatibleOptions(table.id, target)}
                              placeholder={t().notMapped}
                              clearable
                            />
                            <Show when={target.type === "select" && sourceSelectOptions().length > 0}>
                              <div class="space-y-2 rounded-[var(--ui-radius-control)] bg-[var(--ui-surface-subtle)] p-2">
                                <div class="text-xs font-medium text-secondary">{t().optionMapping}</div>
                                <For each={sourceSelectOptions()}>
                                  {(sourceOption) => (
                                    <Select
                                      label={sourceOption.label}
                                      value={() => {
                                        const optionMap = (mappingFor(table.id, target.id)?.config?.optionMap ?? {}) as Record<
                                          string,
                                          string
                                        >;
                                        return optionMap[sourceOption.id] ?? "";
                                      }}
                                      onValueChange={(targetOptionId) =>
                                        setOptionMapping(table.id, target.id, sourceOption.id, targetOptionId ?? "")
                                      }
                                      options={targetSelectOptions()}
                                      placeholder={t().chooseCanonicalOption}
                                      clearable
                                    />
                                  )}
                                </For>
                              </div>
                            </Show>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                )}
              </Show>
            </Show>
          </PanelDialog.Section>

          <Show when={validationDiagnostics().length > 0}>
            <PanelDialog.Section title={t().validation} subtitle={t().validationDetail} icon="ti ti-alert-triangle">
              <div class="paper p-3">
                <ul class="space-y-1 text-sm text-danger">
                  <For each={validationDiagnostics()}>
                    {(diagnostic) => <li>{t().federatedDiagnostic({ code: diagnostic.code, fallback: diagnostic.message })}</li>}
                  </For>
                </ul>
              </div>
            </PanelDialog.Section>
          </Show>

          <Show when={config()?.current} keyed>
            {(current) => (
              <PanelDialog.Section
                title={t().publishedRevision}
                subtitle={t().revisionStatus({
                  revision: current.revision,
                  status: current.status === "active" ? t().active : t().actionRequired,
                })}
                icon="ti ti-cloud-check"
              >
                <For each={current.sources}>
                  {(source) => {
                    const table = () => sourceTables().find((candidate) => candidate.id === source.sourceTableId);
                    return (
                      <div class="flex items-center gap-2 py-1">
                        <span class="min-w-0 flex-1 truncate text-sm text-primary">{table()?.name ?? t().unavailableSource}</span>
                        <Show when={table() && source.sourceTableId} keyed>
                          {(sourceTableId) => (
                            <Button variant="ghost" size="sm" type="button" class="text-danger" onClick={() => void revoke(sourceTableId)}>
                              <i class="ti ti-unlink" /> {t().revoke}
                            </Button>
                          )}
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </PanelDialog.Section>
            )}
          </Show>
        </Show>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Button variant="secondary" size="sm" type="button" onClick={props.close}>
          {t().close}
        </Button>
        <div class="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={validateMutation.loading() || selectedSources().length + hiddenSourceCount() === 0}
            onClick={() => validateMutation.mutate(undefined)}
          >
            {validateMutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-checkup-list" />} {t().validate}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            type="button"
            disabled={saveMutation.loading()}
            onClick={() => saveMutation.mutate(undefined)}
          >
            {t().saveDraft}
          </Button>
          <Button
            variant="primary"
            size="sm"
            type="button"
            disabled={publishMutation.loading() || selectedSources().length + hiddenSourceCount() === 0}
            onClick={() => publishMutation.mutate(undefined)}
          >
            {publishMutation.loading() ? <i class="ti ti-loader-2 animate-spin" /> : <i class="ti ti-cloud-upload" />} {t().publish}
          </Button>
        </div>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}
