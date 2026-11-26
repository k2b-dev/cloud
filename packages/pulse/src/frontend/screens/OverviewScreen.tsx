import { navigateTo } from "@k2b/ssr/nav";
import { text } from "@k2b/stdlib";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Dialog,
  Empty,
  Field,
  Inline,
  Input,
  List,
  Pane,
  Progress,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { isServer } from "solid-js/web";
import type { PulseBase } from "../../contracts";
import { jsonFetch } from "../http";
import { usePulseMessages } from "../use-messages";
import { baseStoreMessages } from "../workspace/base-store-messages";
import { installPeriodicRefresh } from "../workspace/periodic-refresh";
import { iconName } from "./BaseFrame";
import { useScreenMessages } from "./messages";
import { baseColor, StoreChip, storeState } from "./store-state";

export type OverviewScreenProps = {
  bases: PulseBase[];
  /** Bases the person administers whose deletion still runs or failed; they stay here until the deletion finishes. */
  deletingBases: PulseBase[];
  initialQuery: string;
};

/**
 * Rows the base table shows at a time. A row draws faces and a storage bar; measured with 1,000 bases in WebKit on the
 * test VM (26.11.2026, VM under load): 100 rows 1643 ms, 50 rows 1317–1538 ms, 30 rows 1175–1441 ms against the
 * 1.5 s budget of the scale test.
 */
const PAGE = 30;
const baseHref = (base: PulseBase) => `/app/pulse/${base.id}`;

const matches = (base: PulseBase, query: string) => {
  const needle = query.trim().toLowerCase();
  return !needle || `${base.name} ${base.description ?? ""} ${base.id}`.toLowerCase().includes(needle);
};

/** The bases a person can open: one table, a search in the head, and "New base" as the one main action. */
export default function OverviewScreen(props: OverviewScreenProps) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const locale = useLocale();
  const store = () => baseStoreMessages.resolve([locale()]).t;
  const toast = useToast();
  const [query, setQuery] = createSignal(props.initialQuery);
  const [creating, setCreating] = createSignal(false);
  // Only bases whose store does not take data are worth a word in the first row; healthy ones need none.
  const troubled = (base: PulseBase) => storeState(base.store, store()).status !== "ok";
  const troubledBases = () => props.bases.filter(troubled);
  const bytes = (value: number) => text.pprintBytes(value, { locale: locale(), mode: "si" });
  const shown = createMemo(() => props.bases.filter((base) => matches(base, query())));
  // k2b-ui gap: tables do not virtualize yet (lane MW); the list shows 100 rows at a time, so the page stays bounded.
  const [visible, setVisible] = createSignal(PAGE);

  // The search filters the list as it is typed; the address keeps it for reload and back.
  const search = (value: string) => {
    setQuery(value);
    setVisible(PAGE);
    if (isServer) return;
    const url = new URL(location.href);
    if (value.trim()) url.searchParams.set("q", value.trim());
    else url.searchParams.delete("q");
    history.replaceState(history.state, "", `${url.pathname}${url.search}`);
  };

  return (
    <Workspace
      head={
        <Bar
          end={
            <>
              <Input
                type="search"
                icon="search"
                label={t().searchBases}
                placeholder={t().searchBasesPlaceholder}
                value={query()}
                onInput={search}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query()) {
                    event.preventDefault();
                    search("");
                  }
                }}
              />
              <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
                {t().newBase}
              </Button>
            </>
          }
        />
      }
      primary={{ label: t().newBase, icon: "plus", onClick: () => setCreating(true) }}
    >
      <Pane
        label={t().yourBases}
        scrollKey="pulse-bases"
        // the first row speaks only when there is something to act on or a search found less than all
        status={
          query().trim() || troubledBases().length > 0 ? (
            <StatusRow
              lead={
                query().trim()
                  ? words().matchesCount({ count: shown().length, total: props.bases.length })
                  : words().storeTrouble({ count: troubledBases().length })
              }
              // which ones, and what is wrong with each
              // k2b-ui gap (#4259 StatusRow marks): the names stand as figures, not yet as tinted chips with their mark
              facts={
                query().trim()
                  ? undefined
                  : troubledBases()
                      .slice(0, 3)
                      .map((base) => ({ value: base.name, after: storeState(base.store, store()).label }))
              }
            />
          ) : undefined
        }
      >
        <Show
          when={props.bases.length > 0}
          fallback={
            <Empty
              icon="activity-heartbeat"
              text={t().firstBaseDescription}
              action={{ label: t().newBase, icon: "plus", onClick: () => setCreating(true) }}
            />
          }
        >
          {/* k2b-ui gap: v2 lists do not virtualize yet (lane MW); 100 rows show at a time. */}
          <Show
            when={shown().length > 0}
            fallback={<Empty icon="search" text={t().noMatchingBases} action={{ label: words().clearSearch, onClick: () => search("") }} />}
          >
            <Table
              label={t().yourBases}
              rows={shown().slice(0, visible())}
              rowKey={(base) => base.id}
              open={(base) => ({ href: baseHref(base) })}
              phone={(base) => ({
                mark: { icon: iconName(base.icon), color: baseColor(base.color) },
                lines: [base.name, base.description ?? words().membersMeta({ count: base.memberCount })],
                states: troubled(base) ? <StoreChip store={base.store} t={store()} /> : undefined,
              })}
              columns={[
                {
                  title: words().baseColumn,
                  width: { min: 220, default: 360 },
                  mark: (base) => ({ icon: iconName(base.icon), color: baseColor(base.color) }),
                  cell: (base) => (base.description ? { lines: [base.name, base.description] } : base.name),
                },
                {
                  title: words().membersColumn,
                  width: { min: 150, default: 190 },
                  drop: true,
                  cell: (base) => (
                    <Inline>
                      <Avatar.Stack people={(base.members ?? []).map((name) => ({ name }))} max={3} />
                      <Text type="meta" muted>
                        {words().membersMeta({ count: base.memberCount })}
                      </Text>
                    </Inline>
                  ),
                },
                {
                  title: words().storageColumn,
                  width: { min: 200, default: 280 },
                  // a store that does not take data says why; a working one shows how full it is
                  cell: (base) =>
                    troubled(base) ? (
                      <StoreChip store={base.store} t={store()} />
                    ) : base.store.usage ? (
                      <Progress
                        value={base.store.usage.bytes}
                        of={base.store.limits.storageBytes}
                        label={`${bytes(base.store.usage.bytes)} / ${bytes(base.store.limits.storageBytes)}`}
                      />
                    ) : (
                      <Text type="meta" muted>
                        {words().notMeasured}
                      </Text>
                    ),
                },
                {
                  title: words().retentionColumn,
                  width: { min: 100, default: 120 },
                  drop: true,
                  align: "end",
                  cell: (base) => words().retentionDays({ days: base.rawRetentionDays }),
                },
              ]}
            />
          </Show>
          <Show when={shown().length > visible()}>
            <Bar
              start={
                <Text type="meta" muted>
                  {words().rowsShown({ shown: String(visible()), total: String(shown().length) })}
                </Text>
              }
              end={
                <Button icon="chevrons-down" onClick={() => setVisible(visible() + PAGE)}>
                  {words().showMore}
                </Button>
              }
            />
          </Show>
        </Show>
        <Show when={props.deletingBases.length > 0}>
          <Section icon="trash" title={words().deletingTitle} count={props.deletingBases.length}>
            <List label={words().deletingTitle}>
              <For each={props.deletingBases}>{(base) => <DeletingBase base={base} />}</For>
            </List>
          </Section>
        </Show>
      </Pane>
      <NewBaseDialog
        open={creating()}
        onOpenChange={setCreating}
        onCreated={(base) => {
          toast(t().baseCreated, { status: "ok" });
          navigateTo(baseHref(base));
        }}
      />
    </Workspace>
  );
}

/** A base admin follows a running deletion here, since the base left the list, and resumes a failed one. */
function DeletingBase(props: { base: PulseBase }) {
  const locale = useLocale();
  const t = () => baseStoreMessages.resolve([locale()]).t;
  const toast = useToast();
  const [base, setBase] = createSignal(props.base);
  // Gone once the deletion finished; the row stays in place until a reload.
  const [deleted, setDeleted] = createSignal(false);
  const [retrying, setRetrying] = createSignal(false);
  const failed = () => !deleted() && base().store.state === "failed";
  const followed = installPeriodicRefresh({
    active: () => !deleted() && !failed() && !retrying(),
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
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const retry = async () => {
    if (!failed()) return followed.retry();
    setRetrying(true);
    try {
      setBase(
        await jsonFetch<PulseBase>(`/api/pulse/bases/${base().id}/retry`, { method: "POST", signal: controller.signal }, t().retryFailed),
      );
      toast(t().retryStarted, { status: "ok" });
    } catch {
      if (!controller.signal.aborted) toast(t().retryFailed, { status: "bad" });
    } finally {
      setRetrying(false);
    }
  };
  const state = () => (deleted() ? t().stateDeleted : failed() ? t().stateFailed : t().stateDeleting);
  const text = () => (deleted() ? t().deletedText : failed() ? t().failedDelete : followed.failed() ? t().staleText : t().deletingText);
  return (
    <Row
      icon={failed() ? "alert-circle" : deleted() ? "check" : "trash"}
      lines={[base().name, text()]}
      // under "Wird gelöscht" a running deletion needs no word of its own; a failed or finished one does
      meta={failed() || deleted() ? state() : undefined}
      // The action keeps its place after a retry, so the row does not change height.
      action={{ label: t().retry, icon: "refresh", disabled: retrying() || (!failed() && !followed.failed()), onClick: () => void retry() }}
    />
  );
}

/** The few words a new base needs; the base opens once it exists. */
function NewBaseDialog(props: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (base: PulseBase) => void }) {
  const t = usePulseMessages();
  const words = useScreenMessages();
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [tried, setTried] = createSignal(false);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const close = (open: boolean) => {
    if (busy()) return;
    props.onOpenChange(open);
    if (!open) {
      setName("");
      setDescription("");
      setError(null);
      setTried(false);
    }
  };
  const create = async (event?: Event) => {
    event?.preventDefault();
    setTried(true);
    if (!name().trim() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const base = await jsonFetch<PulseBase>(
        "/api/pulse/bases",
        {
          method: "POST",
          body: JSON.stringify({ name: name().trim(), description: description().trim() || null }),
          signal: controller.signal,
        },
        t().createBaseFailed,
      );
      setBusy(false);
      close(false);
      props.onCreated(base);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t().createBaseFailed);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t().createBasePrompt}
      open={props.open}
      onOpenChange={close}
      foot={
        <>
          <Button onClick={() => close(false)} disabled={busy()}>
            {words().cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={() => void create()}>
            {t().create}
          </Button>
        </>
      }
    >
      <Field name="name" label={t().name} required error={tried() && !name().trim() ? words().required : (error() ?? undefined)}>
        <Input
          value={name()}
          placeholder="Operations"
          onInput={setName}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.isComposing) void create(event);
          }}
        />
      </Field>
      <Field name="description" label={t().description} optional={words().optional}>
        <Input multiline value={description()} onInput={setDescription} />
      </Field>
    </Dialog>
  );
}
