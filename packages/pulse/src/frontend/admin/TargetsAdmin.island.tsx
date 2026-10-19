import { Button, DataTable, type DataTableColumn, IconButton, Placeholder, prompts, Select, TextInput, toast, useLocale } from "@k2b/ui";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import type { InternalTarget, InternalTargetsPage } from "../../store/admin-contracts";
import { AdminClientError, adminClient } from "./admin-client";
import { adminErrorText, type PulseAdminMessages, pulseAdminMessages } from "./pulse-admin-messages";

const PAGE_SIZE = 50;
const codeOf = (cause: unknown) => (cause instanceof AdminClientError ? cause.code : "ADMIN_REQUEST_FAILED");

const scopeText = (t: PulseAdminMessages, target: InternalTarget) =>
  target.scope === "host_port" && target.port !== null
    ? t.scopePort({ port: target.port })
    : target.scope === "network"
      ? t.scopeNetwork
      : t.scopeHost;

const openAddTarget = (t: PulseAdminMessages, signal: AbortSignal) =>
  prompts.dialog<InternalTarget>(
    (close, context) => {
      const [baseId, setBaseId] = createSignal<string | null>(null);
      const [entry, setEntry] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [baseError, setBaseError] = createSignal("");
      const [entryError, setEntryError] = createSignal("");
      const [error, setError] = createSignal("");
      context.setDismissHandler(() => {
        if (!busy()) close();
      });
      const submit = async () => {
        if (busy()) return;
        setBaseError(baseId() ? "" : t.errorBaseRequired);
        setEntryError(entry().trim() ? "" : t.errorInvalidTarget);
        setError("");
        const chosen = baseId();
        if (!chosen || !entry().trim()) return;
        setBusy(true);
        try {
          close(await adminClient.addTarget({ baseId: chosen, entry: entry().trim() }, signal));
        } catch (cause) {
          if (signal.aborted) return;
          const code = codeOf(cause);
          // Input refusals belong to their field; everything else to the dialog's fixed error line.
          if (["INVALID_TARGET", "TARGET_TOO_BROAD", "TARGET_EXISTS"].includes(code)) setEntryError(adminErrorText(t, code));
          else if (code === "NOT_FOUND") setBaseError(adminErrorText(t, code));
          else setError(adminErrorText(t, code));
        } finally {
          setBusy(false);
        }
      };
      return (
        <form
          class="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Select
            label={t.targetBase}
            placeholder={t.targetBasePlaceholder}
            value={baseId}
            onValueChange={(value) => {
              setBaseId(value);
              setBaseError("");
            }}
            fetchData={async (query, abort) =>
              (await adminClient.bases({ limit: 50, q: query.trim() || undefined }, abort)).items.map((row) => ({
                value: row.id,
                label: row.name,
              }))
            }
            error={() => baseError() || undefined}
            required
            disabled={busy()}
          />
          <TextInput
            label={t.targetEntry}
            description={t.targetEntryDescription}
            placeholder="shop-01:9100"
            value={entry()}
            onValueChange={(value) => {
              setEntry(value);
              setEntryError("");
            }}
            error={entryError() || undefined}
            monospace
            autocomplete="off"
            spellcheck={false}
            required
            disabled={busy()}
          />
          <p class="min-h-5 text-sm text-danger" role="alert">
            {error()}
          </p>
          <div class="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" disabled={busy()} onClick={() => close()}>
              {t.cancel}
            </Button>
            <Button type="submit" variant="primary" loading={busy()}>
              {t.addTarget}
            </Button>
          </div>
        </form>
      );
    },
    { title: t.addTargetTitle, icon: "ti ti-route", size: "small" },
  );

export default function TargetsAdmin(props: { initialPage: InternalTargetsPage | null }) {
  const locale = useLocale();
  const t = createMemo(() => pulseAdminMessages.resolve([locale()]).t);
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const [rows, setRows] = createSignal<InternalTarget[]>(props.initialPage?.items ?? []);
  const [nextOffset, setNextOffset] = createSignal(props.initialPage?.nextOffset ?? null);
  const [loadFailed, setLoadFailed] = createSignal(!props.initialPage);
  const [loading, setLoading] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const page = await adminClient.targets({ limit: PAGE_SIZE }, controller.signal);
      setRows(page.items);
      setNextOffset(page.nextOffset);
      setLoadFailed(false);
    } catch {
      if (!controller.signal.aborted) setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  };
  const more = async () => {
    const offset = nextOffset();
    if (offset === null || loadingMore()) return;
    setLoadingMore(true);
    try {
      const page = await adminClient.targets({ limit: PAGE_SIZE, offset }, controller.signal);
      const known = new Set(rows().map((row) => row.id));
      setRows([...rows(), ...page.items.filter((row) => !known.has(row.id))]);
      setNextOffset(page.nextOffset);
    } catch (cause) {
      if (!controller.signal.aborted) toast.error(adminErrorText(t(), codeOf(cause)));
    } finally {
      setLoadingMore(false);
    }
  };
  const add = async () => {
    const created = await openAddTarget(t(), controller.signal);
    if (created) setRows([created, ...rows().filter((row) => row.id !== created.id)]);
  };
  const remove = async (target: InternalTarget) => {
    const confirmed = await prompts.confirm(t().removeTargetText({ base: target.baseName }), {
      title: t().removeTargetTitle({ entry: target.entry }),
      confirmText: t().remove,
      variant: "danger",
      icon: "ti ti-route-off",
    });
    if (!confirmed) return;
    setBusy(target.id);
    try {
      await adminClient.removeTarget(target.id, controller.signal);
      setRows(rows().filter((row) => row.id !== target.id));
    } catch (cause) {
      if (!controller.signal.aborted) toast.error(adminErrorText(t(), codeOf(cause)));
    } finally {
      setBusy(null);
    }
  };

  const columns = (): DataTableColumn<InternalTarget>[] => [
    { id: "entry", header: t().colTarget, value: "entry" },
    { id: "scope", header: t().colScope, value: (row) => scopeText(t(), row), class: "max-sm:hidden" },
    { id: "base", header: t().colBase, value: "baseName", class: "max-sm:hidden" },
    { id: "actions", header: <span class="sr-only">{t().colActions}</span>, align: "right", nowrap: true },
  ];

  return (
    <div class="flex max-w-4xl flex-col gap-4">
      <p class="text-sm text-secondary">{t().targetsIntro}</p>
      <Show
        when={!loadFailed()}
        fallback={<Placeholder state="error" surface="paper" title={t().targetsLoadFailed} onRetry={() => void reload()} />}
      >
        <DataTable.Panel>
          <DataTable.Header title={t().targetsTitle} as="h2">
            <Button size="sm" variant="secondary" onClick={() => void add()}>
              <i class="ti ti-plus" aria-hidden="true" />
              {t().addTarget}
            </Button>
          </DataTable.Header>
          <DataTable
            rows={rows()}
            columns={columns()}
            getRowId={(row) => row.id}
            surface="plain"
            stickyHeader={false}
            loading={loading()}
            hasMore={nextOffset() !== null}
            loadingMore={loadingMore()}
            onLoadMore={() => void more()}
            empty={<Placeholder title={t().targetsEmpty} description={t().targetsEmptyDescription} icon="ti ti-route" />}
            renderCell={({ row, col, render }) => {
              if (col.id === "entry")
                return (
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate font-mono text-sm text-primary">{row.entry}</span>
                    {/* A phone shows only this column and the remove button; scope and base move under the entry. */}
                    <span class="truncate text-xs text-dimmed sm:hidden">
                      {row.baseName} · {scopeText(t(), row)}
                    </span>
                  </span>
                );
              if (col.id === "scope") return <span class="text-secondary">{scopeText(t(), row)}</span>;
              if (col.id === "base") return <span class="truncate">{row.baseName}</span>;
              if (col.id === "actions")
                return (
                  <IconButton
                    size="sm"
                    variant="ghost"
                    label={t().removeTargetTitle({ entry: row.entry })}
                    loading={busy() === row.id}
                    disabled={busy() !== null}
                    onClick={() => void remove(row)}
                  >
                    <i class="ti ti-x" aria-hidden="true" />
                  </IconButton>
                );
              return render(undefined);
            }}
          />
        </DataTable.Panel>
      </Show>
    </div>
  );
}
