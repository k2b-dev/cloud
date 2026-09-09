import { navigateTo } from "@k2b/ssr/nav";
import { mutation as mutations, timed } from "@k2b/stdlib/solid";
import {
  AppOverview,
  Button,
  CheckboxCard,
  confirmDiscardIfDirty,
  dialogCore,
  InlineGuidance,
  Pagination,
  PanelDialog,
  panelDialogOptions,
  prompts,
  TextInput,
  useLocale,
} from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { apiClient } from "@/api/client";
import type { PublicBase } from "../../../api/public-dto";
import { errorMessage } from "../utils/api-helpers";
import { overviewMessages } from "./messages";

type TemplateSummary = {
  id: string;
  name: string;
  description: string;
  highlights: [string, string, string];
  icon: string;
};

type Props = {
  bases: PublicBase[];
  total: number;
  limit: number;
  offset: number;
  templates: TemplateSummary[];
  initialQuery: string;
};

const setQueryParam = (value: string, page: number) => {
  const url = new URL(window.location.href);
  const trimmed = value.trim();
  if (trimmed) url.searchParams.set("q", trimmed);
  else url.searchParams.delete("q");
  if (page > 1) url.searchParams.set("page", String(page));
  else url.searchParams.delete("page");
  window.history.replaceState({}, "", url.toString());
};

export default function BasesOverview(props: Props) {
  const { t } = overviewMessages.resolve([useLocale()()]);
  const [query, setQuery] = createSignal(props.initialQuery);
  const [bases, setBases] = createSignal<PublicBase[]>(props.bases);
  const [total, setTotal] = createSignal(props.total);
  const [offset, setOffset] = createSignal(props.offset);
  const [creatingTemplateId, setCreatingTemplateId] = createSignal<string | null>(null);
  let abortCtl: AbortController | null = null;

  const currentPage = createMemo(() => Math.floor(offset() / props.limit) + 1);
  const totalPages = createMemo(() => Math.ceil(total() / props.limit));
  const paginationBaseUrl = createMemo(() => {
    const q = query().trim();
    return q ? `/app/grids?q=${encodeURIComponent(q)}&page=` : "/app/grids?page=";
  });

  const loadBases = async (value: string, page = 1) => {
    abortCtl?.abort();
    abortCtl = new AbortController();
    const q = value.trim();
    const res = await apiClient.bases.$get(
      {
        query: {
          q,
          limit: String(props.limit),
          offset: String((page - 1) * props.limit),
        },
      },
      { init: { signal: abortCtl.signal } },
    );
    if (!res.ok) throw new Error(await errorMessage(res, t.loadBasesFailed));
    const body = await res.json();
    setBases(body.items);
    setTotal(body.total);
    setOffset(body.offset);
  };
  const searchDebounce = timed.debounce((value: string) => {
    void loadBases(value, 1).catch((e) => {
      if ((e as Error).name !== "AbortError") prompts.error((e as Error).message);
    });
  }, 250);
  onCleanup(() => abortCtl?.abort());

  const [isCreating, setIsCreating] = createSignal(false);
  const createBase = async (template?: TemplateSummary) => {
    if (isCreating()) return;
    setIsCreating(true);
    setCreatingTemplateId(template?.id ?? null);
    try {
      const base = await dialogCore.open<PublicBase>((close, context) => {
        const initialName = template?.name ?? "";
        const [name, setName] = createSignal(initialName);
        const [description, setDescription] = createSignal("");
        const [sampleData, setSampleData] = createSignal(true);
        const [submitted, setSubmitted] = createSignal(false);
        const save = mutations.create<PublicBase, void>({
          mutation: async () => {
            const response = template
              ? await apiClient.templates[":templateId"].$post({
                  param: { templateId: template.id },
                  json: { name: name().trim(), withSampleData: sampleData() },
                })
              : await apiClient.bases.$post({ json: { name: name().trim(), description: description().trim() || null } });
            if (!response.ok) throw new Error(await errorMessage(response, template ? t.createFromTemplateFailed : t.createBaseFailed));
            return response.json();
          },
          onSuccess: close,
        });
        const dismiss = async () => {
          if (!save.loading() && (await confirmDiscardIfDirty(name() !== initialName || description().length > 0 || !sampleData())))
            close();
        };
        context.setDismissHandler(dismiss);
        return (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(true);
              if (name().trim() && !save.loading()) void save.mutate();
            }}
          >
            <PanelDialog>
              <PanelDialog.Header
                title={template ? t.createTemplate({ name: template.name }) : t.newBase}
                icon={template?.icon ?? "ti ti-database-plus"}
                close={dismiss}
                closeDisabled={save.loading()}
              />
              <PanelDialog.Body>
                <div class="flex flex-col gap-4">
                  <Show when={save.error()}>{(error) => <InlineGuidance tone="danger">{error().message}</InlineGuidance>}</Show>
                  <TextInput
                    label={t.name}
                    description={template ? t.renameTemplateDescription : undefined}
                    value={name}
                    onValueChange={setName}
                    placeholder={t.baseNameExample}
                    required
                    error={submitted() && !name().trim() ? t.requiredName : undefined}
                    disabled={save.loading()}
                  />
                  <Show
                    when={template}
                    fallback={
                      <TextInput
                        label={t.description}
                        value={description}
                        onValueChange={setDescription}
                        multiline
                        placeholder={t.optional}
                        disabled={save.loading()}
                      />
                    }
                  >
                    <CheckboxCard
                      label={t.includeSampleData}
                      description={t.includeSampleDataDescription}
                      value={sampleData}
                      onValueChange={setSampleData}
                      disabled={save.loading()}
                    />
                  </Show>
                </div>
              </PanelDialog.Body>
              <PanelDialog.Footer>
                <span />
                <div class="flex gap-2">
                  <Button type="button" variant="secondary" onClick={dismiss} disabled={save.loading()}>
                    {t.cancel}
                  </Button>
                  <Button type="submit" loading={save.loading()}>
                    {t.createBase}
                  </Button>
                </div>
              </PanelDialog.Footer>
            </PanelDialog>
          </form>
        );
      }, panelDialogOptions);
      if (base) navigateTo(`/app/grids/${base.id}`);
    } finally {
      setIsCreating(false);
      setCreatingTemplateId(null);
    }
  };
  const createBlank = () => void createBase();
  const createFromTemplate = (template: TemplateSummary) => void createBase(template);

  const onSearchInput = (value: string) => {
    setQuery(value);
    setOffset(0);
    setQueryParam(value, 1);
    searchDebounce.debouncedFn(value);
  };

  const overviewDescription = createMemo(() =>
    query().trim()
      ? `${total()} match${total() === 1 ? "" : "es"}`
      : total() === 0
        ? t.createBaseFirst
        : `${bases().length} of ${total()} base${total() === 1 ? "" : "s"} shown`,
  );

  return (
    <AppOverview title="Grids" subtitle={t.subtitle} icon="ti ti-table">
      <AppOverview.Main
        title={t.yourBases}
        description={overviewDescription()}
        toolbar={
          <TextInput
            name="grids-base-search"
            type="search"
            aria-label={t.searchBases}
            placeholder={t.searchBasesPlaceholder}
            icon="ti ti-search"
            activeIcon="ti ti-search"
            value={query}
            onValueChange={onSearchInput}
            clearable
            onClear={() => onSearchInput("")}
          />
        }
      >
        {/*
          AppOverview owns the shared shell only. Search, pagination,
          mutations, and card rendering stay in Grids.
        */}
        <Show
          when={bases().length > 0}
          fallback={
            query().trim() ? (
              <AppOverview.EmptyState title={t.noMatchingBases} description={t.tryDifferentSearch} icon="ti ti-search" />
            ) : (
              <AppOverview.EmptyState title={t.noBases} description={t.noBasesDescription} icon="ti ti-database-plus" class="min-h-72" />
            )
          }
        >
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <For each={bases()}>
              {(base) => (
                <a
                  href={`/app/grids/${base.id}`}
                  class="paper p-4 flex items-center gap-4 hover:paper-highlighted transition-all no-underline"
                  style={`view-transition-name: grids-base-card-${base.id}`}
                >
                  <div class="app-accent-text w-10 h-10 thumbnail bg-[var(--ui-selected)] flex items-center justify-center shrink-0">
                    <i class="ti ti-database text-lg" />
                  </div>
                  <div class="flex-1 min-w-0">
                    <span
                      class="text-sm font-semibold text-primary block truncate"
                      style={`view-transition-name: grids-base-name-${base.id}`}
                    >
                      {base.name}
                    </span>
                    <p class="text-xs text-dimmed truncate">{base.description || t.noDescription}</p>
                  </div>
                  <i class="ti ti-chevron-right text-dimmed" />
                </a>
              )}
            </For>
          </div>
          <Pagination currentPage={currentPage()} totalPages={totalPages()} baseUrl={paginationBaseUrl()} />
        </Show>
      </AppOverview.Main>

      <AppOverview.Aside title={t.createAside} description={t.createAsideDescription}>
        <div class="grid grid-cols-1 gap-2">
          <For each={props.templates}>
            {(template) => (
              <button
                type="button"
                class="paper p-4 text-left flex items-start gap-3 hover:paper-highlighted transition-all"
                onClick={() => createFromTemplate(template)}
                disabled={isCreating()}
                aria-label={t.createTemplateBase({ name: template.name })}
                aria-busy={creatingTemplateId() === template.id}
              >
                <span class="w-9 h-9 thumbnail bg-[var(--ui-surface-raised)] flex items-center justify-center shrink-0">
                  <i
                    class={`${creatingTemplateId() === template.id ? "ti ti-loader-2 animate-spin" : template.icon} text-lg text-primary`}
                  />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block text-sm font-semibold text-primary">{template.name}</span>
                  <span class="block text-xs text-dimmed leading-snug">{template.description}</span>
                  <span class="mt-2 grid gap-1" role="list" aria-label={`${template.name} includes`}>
                    <For each={template.highlights}>
                      {(highlight) => (
                        <span class="flex items-start gap-1.5 text-xs text-secondary leading-snug" role="listitem">
                          <i class="ti ti-check mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
                          <span>{highlight}</span>
                        </span>
                      )}
                    </For>
                  </span>
                </span>
              </button>
            )}
          </For>

          <button
            type="button"
            class="paper p-4 text-left flex items-start gap-3 hover:paper-highlighted transition-all"
            onClick={createBlank}
            disabled={isCreating()}
            aria-busy={isCreating() && creatingTemplateId() === null}
          >
            <span class="app-accent-text w-9 h-9 thumbnail bg-[var(--ui-selected)] flex items-center justify-center shrink-0">
              <i class={`ti ${isCreating() && creatingTemplateId() === null ? "ti-loader-2 animate-spin" : "ti-plus"} text-lg`} />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-primary">{t.blankBase}</span>
              <span class="block text-xs text-dimmed leading-snug">{t.blankBaseDescription}</span>
            </span>
          </button>
        </div>
      </AppOverview.Aside>
    </AppOverview>
  );
}
