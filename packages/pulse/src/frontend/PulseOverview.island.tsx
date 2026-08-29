import { navigate, navigateTo } from "@k2b/ssr/nav";
import { mutation } from "@k2b/stdlib/solid";
import { AppOverview, Button, NoticeCard, prompts, TextInput, toast } from "@k2b/ui";
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
      jsonFetch<PulseBase>(
        "/api/pulse/bases",
        { method: "POST", body: JSON.stringify(intent), signal: abortSignal },
        t().createBaseFailed,
      ),
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
    <AppOverview title={t().appName} subtitle={t().appDescription} icon="ti ti-activity-heartbeat">
      <AppOverview.Main
        title={t().yourBases}
        description={
          props.bases.length === 0
            ? t().firstBaseDescription
            : t().baseCount({ count: props.bases.length })
        }
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
            >
              <Button variant="secondary" size="sm" disabled={createMutation.loading()} onClick={() => void createBase()}>
                <i class="ti ti-plus" /> {t().createBase}
              </Button>
            </AppOverview.EmptyState>
          }
        >
          <Show
            when={filteredBases().length > 0}
            fallback={<AppOverview.EmptyState title={t().noMatchingBases} description={t().differentSearch} icon="ti ti-search" />}
          >
            <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <For each={filteredBases()}>
                {(base) => (
                  <a
                    href={`/app/pulse/${base.id}`}
                    class="paper group flex items-center gap-4 p-4 no-underline transition-all hover:paper-highlighted"
                  >
                    <div class="thumbnail flex h-10 w-10 shrink-0 items-center justify-center bg-white shadow-[var(--ui-shadow-surface)] dark:bg-zinc-950">
                      <i class="ti ti-activity-heartbeat app-accent-text text-lg" />
                    </div>
                    <div class="min-w-0 flex-1">
                      <span class="block truncate text-sm font-semibold text-primary">{base.name}</span>
                      <p class="truncate text-xs text-dimmed">{base.description || t().rawRetention({ days: base.rawRetentionDays })}</p>
                    </div>
                    <i class="ti ti-chevron-right text-dimmed transition-colors group-hover:app-accent-text" />
                  </a>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </AppOverview.Main>

      <AppOverview.Aside title={t().createSection} description={t().createSectionDescription}>
        <div class="grid grid-cols-1 gap-2">
          <Button
            type="button"
            variant="ghost"
            class="group h-auto w-full items-start justify-start gap-3 rounded-xl border border-[var(--ui-border)] p-4 text-left hover:bg-[var(--ui-surface-subtle)]"
            disabled={createMutation.loading()}
            onClick={() => void createBase()}
          >
            <span class="thumbnail flex h-9 w-9 shrink-0 items-center justify-center bg-zinc-100 dark:bg-zinc-900">
              <i class="ti ti-plus app-accent-text text-lg" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-semibold text-primary">{t().newBase}</span>
              <span class="block text-xs leading-snug text-dimmed">{t().createBaseDescription}</span>
            </span>
            <i class="ti ti-chevron-right mt-1 shrink-0 text-dimmed transition-colors group-hover:app-accent-text" />
          </Button>

          <Show when={props.capabilities && !props.capabilities.timescaleEnabled}>
            <NoticeCard tone="warning" icon={false} class="mt-2">
              {t().timescaleWarning}
            </NoticeCard>
          </Show>
        </div>
      </AppOverview.Aside>
    </AppOverview>
  );
}
