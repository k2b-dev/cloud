import { navigate, navigateTo } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { AppOverview, Button, LinkCard, NoticeCard, prompts, TextInput, toast } from "@k2b/ui";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { PulseBase, PulseCapabilitySnapshot } from "../contracts";
import { jsonFetch } from "./http";
import { usePulseMessages } from "./use-messages";

type Props = {
  bases: PulseBase[];
  initialQuery: string;
  capabilities: PulseCapabilitySnapshot | null;
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
        <Show when={props.capabilities && !props.capabilities.timescaleEnabled}>
          <NoticeCard tone="warning" icon={false} class="mb-3">
            {t().timescaleWarning}
          </NoticeCard>
        </Show>
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
      </AppOverview.Main>
    </AppOverview>
  );
}
