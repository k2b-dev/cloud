import { navigate, navigateTo } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { AppOverview, Button, LinkCard, NoticeCard, prompts, TextInput, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { PulseBase } from "../contracts";
import { jsonFetch } from "./http";
import { usePulseMessages } from "./use-messages";
import { baseStoreMessages } from "./workspace/base-store-messages";
import { installPeriodicRefresh } from "./workspace/periodic-refresh";

type Props = {
  bases: PulseBase[];
  /** Bases the person administers whose deletion is still running or failed; they stay here until the deletion finishes. */
  deletingBases?: PulseBase[];
  initialQuery: string;
};

/** A base admin follows a running deletion and resumes a failed one from the overview, since the base itself is gone from the list. */
const DeletingBaseNotice = (props: { base: PulseBase }) => {
  const locale = useLocale();
  const t = createMemo(() => baseStoreMessages.resolve([locale()]).t);
  const [base, setBase] = createSignal(props.base);
  // The base is gone (or no longer visible) once its deletion finished; the card stays in place until a reload.
  const [deleted, setDeleted] = createSignal(false);
  const failed = () => !deleted() && base().store.state === "failed";
  const retry = mutation.create<PulseBase, void>({
    mutation: (_intent, { abortSignal }) =>
      jsonFetch<PulseBase>(`/api/pulse/bases/${base().id}/retry`, { method: "POST", signal: abortSignal }, t().retryFailed),
    onSuccess: (next) => {
      setBase(next);
      toast.success(t().retryStarted);
    },
    onError: () => toast.error(t().retryFailed),
  });
  onCleanup(() => retry.abort());
  // Follow the running deletion so a finish or a new failure shows here without a reload. A failed lookup says so
  // in the card and enables Retry, which asks again at once.
  const followed = installPeriodicRefresh({
    active: () => !deleted() && !failed() && !retry.loading(),
    refresh: async () => {
      const gone = new Error("PULSE_BASE_GONE");
      const next = await jsonFetch<PulseBase>(`/api/pulse/bases/${base().id}`, undefined, t().retryFailed, (status) =>
        status === 404 || status === 403 ? gone : new Error(t().retryFailed),
      ).catch((error: unknown) => {
        if (error !== gone) throw error;
        setDeleted(true);
        return null;
      });
      if (next) setBase(next);
    },
  });
  return (
    <NoticeCard
      tone={failed() ? "danger" : "neutral"}
      title={base().name}
      meta={deleted() ? t().stateDeleted : failed() ? t().stateFailed : t().stateDeleting}
      detail={deleted() ? t().deletedText : failed() ? t().failedDelete : followed.failed() ? t().staleText : t().deletingText}
      aria-live="polite"
    >
      {/* The button keeps its place after a retry so the card does not change height. */}
      <Button
        size="xs"
        variant="secondary"
        disabled={!failed() && !followed.failed()}
        loading={retry.loading()}
        onClick={() => (failed() ? void retry.mutate() : followed.retry())}
      >
        {t().retry}
      </Button>
    </NoticeCard>
  );
};

const setQueryParam = (value: string) => {
  const url = new URL(window.location.href);
  const trimmed = value.trim();
  if (trimmed) url.searchParams.set("q", trimmed);
  else url.searchParams.delete("q");
  navigate(`${url.pathname}${url.search}`, { replace: true, scroll: "preserve", viewTransition: false });
};

const matchesBase = (base: PulseBase, query: string): boolean => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return `${base.name} ${base.description ?? ""} ${base.id}`.toLowerCase().includes(q);
};

export default function PulseOverview(props: Props) {
  const t = usePulseMessages();
  const [query, setQuery] = createSignal(props.initialQuery);
  let disposed = false;
  const filteredBases = createMemo(() => props.bases.filter((base) => matchesBase(base, query())));
  const createMutation = mutation.create<PulseBase, { name: string; description: string | null }>({
    mutation: (intent, { abortSignal }) =>
      jsonFetch<PulseBase>("/api/pulse/bases", { method: "POST", body: JSON.stringify(intent), signal: abortSignal }, t().createBaseFailed),
    onSuccess: (base) => {
      toast.success(t().baseCreated);
      navigateTo(`/app/pulse/${base.id}`);
    },
    onError: (error) => prompts.error(error.message),
  });
  onCleanup(() => {
    disposed = true;
    createMutation.abort();
  });

  const onSearchInput = (value: string) => {
    setQuery(value);
    setQueryParam(value);
  };

  const createBase = async () => {
    const result = await prompts.form({
      title: t().createBasePrompt,
      icon: "ti ti-database-plus",
      fields: {
        name: { type: "text", label: t().name, required: true, placeholder: "Operations" },
        description: { type: "text", label: t().description, multiline: true, placeholder: t().optional },
      },
      confirmText: t().create,
    });
    if (disposed || !result) return;

    const name = String(result.name ?? "").trim();
    if (!name) return;
    await createMutation.mutate({ name, description: String(result.description ?? "").trim() || null });
  };

  return (
    <AppOverview
      title={t().appName}
      icon="ti ti-activity-heartbeat"
      subtitle={props.bases.length === 0 ? t().firstBaseDescription : t().baseCount({ count: props.bases.length })}
      actions={
        <Button disabled={createMutation.loading()} onClick={() => void createBase()}>
          <i class="ti ti-plus" aria-hidden="true" /> {t().newBase}
        </Button>
      }
    >
      <AppOverview.Main
        title={t().yourBases}
        toolbar={
          <TextInput
            name="pulse-search"
            type="search"
            aria-label={t().searchBases}
            placeholder={t().searchBasesPlaceholder}
            icon="ti ti-search"
            activeIcon="ti ti-search"
            value={query}
            onValueChange={onSearchInput}
            clearable
            onClear={() => onSearchInput("")}
          />
        }
      >
        <Show
          when={props.bases.length > 0}
          fallback={
            <AppOverview.EmptyState
              title={t().noBases}
              description={t().noBasesDescription}
              icon="ti ti-activity-heartbeat"
              class="min-h-72"
            />
          }
        >
          <Show
            when={filteredBases().length > 0}
            fallback={<AppOverview.EmptyState title={t().noMatchingBases} description={t().differentSearch} icon="ti ti-search" />}
          >
            <AppOverview.Cards>
              <For each={filteredBases()}>
                {(base) => (
                  <LinkCard
                    href={`/app/pulse/${base.id}`}
                    title={base.name}
                    description={base.description || t().rawRetention({ days: base.rawRetentionDays })}
                    icon="ti ti-activity-heartbeat"
                  />
                )}
              </For>
            </AppOverview.Cards>
          </Show>
        </Show>
        <NoticeCard.Grid items={props.deletingBases ?? []} class="mt-4">
          {(base) => <DeletingBaseNotice base={base} />}
        </NoticeCard.Grid>
      </AppOverview.Main>
    </AppOverview>
  );
}
