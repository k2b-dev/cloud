import { useLocale } from "@k2b/ui";
import { Band, Bar, Button, Dialog, Empty, Failed, Field, Input, Lookup, Menu, Notice, Pane, Table, Text, useToast } from "@k2b/ui/v2";
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

/** A new internal target: the base it belongs to (found by name) and the host, port or network. */
function AddTargetDialog(props: {
  t: PulseAdminMessages;
  open: boolean;
  signal: AbortSignal;
  close: (created: InternalTarget | null) => void;
}) {
  const [baseId, setBaseId] = createSignal<string[]>([]);
  const [entry, setEntry] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [baseError, setBaseError] = createSignal("");
  const [entryError, setEntryError] = createSignal("");
  const [error, setError] = createSignal("");
  const reset = () => {
    setBaseId([]);
    setEntry("");
    setBaseError("");
    setEntryError("");
    setError("");
  };
  const close = (created: InternalTarget | null) => {
    if (busy()) return;
    reset();
    props.close(created);
  };
  const submit = async () => {
    if (busy()) return;
    const chosen = baseId()[0];
    setBaseError(chosen ? "" : props.t.errorBaseRequired);
    setEntryError(entry().trim() ? "" : props.t.errorInvalidTarget);
    setError("");
    if (!chosen || !entry().trim()) return;
    setBusy(true);
    try {
      const created = await adminClient.addTarget({ baseId: chosen, entry: entry().trim() }, props.signal);
      setBusy(false);
      close(created);
    } catch (cause) {
      setBusy(false);
      if (props.signal.aborted) return;
      const code = codeOf(cause);
      // Input refusals belong to their field; everything else to the dialog.
      if (["INVALID_TARGET", "TARGET_TOO_BROAD", "TARGET_EXISTS"].includes(code)) setEntryError(adminErrorText(props.t, code));
      else if (code === "NOT_FOUND") setBaseError(adminErrorText(props.t, code));
      else setError(adminErrorText(props.t, code));
    }
  };
  return (
    <Dialog
      title={props.t.addTargetTitle}
      open={props.open}
      onOpenChange={(open) => {
        if (!open) close(null);
      }}
      foot={
        <>
          <Button disabled={busy()} onClick={() => close(null)}>
            {props.t.cancel}
          </Button>
          <Button variant="primary" icon="plus" busy={busy()} onClick={() => void submit()}>
            {props.t.addTarget}
          </Button>
        </>
      }
    >
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
      <Field name="base" label={props.t.targetBase} required error={baseError() || undefined}>
        <Lookup
          label={props.t.targetBase}
          value={baseId()}
          limit={1}
          onChange={(value) => {
            setBaseId(value.slice(-1));
            setBaseError("");
          }}
          load={async (query, context) => ({
            items: (await adminClient.bases({ limit: context.limit, q: query.trim() || undefined }, context.signal)).items.map((row) => ({
              value: row.id,
              label: row.name,
            })),
          })}
        />
      </Field>
      <Field name="entry" label={props.t.targetEntry} hint={props.t.targetEntryDescription} required error={entryError() || undefined}>
        <Input
          value={entry()}
          placeholder="shop-01:9100"
          disabled={busy()}
          onInput={(value) => {
            setEntry(value);
            setEntryError("");
          }}
        />
      </Field>
    </Dialog>
  );
}

/** Hosts and networks inside the instance that bases may scrape, each for one base. */
export default function TargetsView(props: {
  label: string;
  initialPage: InternalTargetsPage | null;
  adding: boolean;
  setAdding: (open: boolean) => void;
}) {
  const locale = useLocale();
  const t = createMemo(() => pulseAdminMessages.resolve([locale()]).t);
  const toast = useToast();
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  const [rows, setRows] = createSignal<InternalTarget[]>(props.initialPage?.items ?? []);
  const [total, setTotal] = createSignal(props.initialPage?.total ?? 0);
  const [nextOffset, setNextOffset] = createSignal(props.initialPage?.nextOffset ?? null);
  const [loadFailed, setLoadFailed] = createSignal(!props.initialPage);
  const [_loading, setLoading] = createSignal(false);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const reload = async () => {
    setLoading(true);
    try {
      const page = await adminClient.targets({ limit: PAGE_SIZE }, controller.signal);
      setRows(page.items);
      setTotal(page.total);
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
      if (!controller.signal.aborted) toast(adminErrorText(t(), codeOf(cause)), { status: "bad" });
    } finally {
      setLoadingMore(false);
    }
  };
  const remove = async (target: InternalTarget) => {
    const agreed = await Dialog.confirm({
      title: t().removeTargetTitle({ entry: target.entry }),
      description: t().removeTargetText({ base: target.baseName }),
      confirm: t().remove,
      cancel: t().cancel,
    });
    if (!agreed) return;
    setBusy(target.id);
    try {
      await adminClient.removeTarget(target.id, controller.signal);
      setRows(rows().filter((row) => row.id !== target.id));
      // Reload the first page: a removed row shifts the server offsets of every later page.
      await reload();
    } catch (cause) {
      if (!controller.signal.aborted) toast(adminErrorText(t(), codeOf(cause)), { status: "bad" });
    } finally {
      setBusy(null);
    }
  };
  // a network stands apart from a single server, one port from all of a host
  const targetMark = (row: InternalTarget) =>
    row.scope === "network"
      ? { icon: "network", color: "#7c3aed" }
      : row.scope === "host_port"
        ? { icon: "plug-connected", color: "#2563eb" }
        : { icon: "server", color: "#0891b2" };
  return (
    <Pane label={props.label} scrollKey="pulse-admin-targets">
      {/* one sentence of help and the count as meta; the head above carries the one deed */}
      <Band>
        <Text>{t().targetsIntro}</Text>
        <Text type="meta" muted>
          {t().targetsCount({ count: total() })}
        </Text>
      </Band>
      <Show when={!loadFailed()} fallback={<Failed text={t().targetsLoadFailed} onRetry={() => void reload()} />}>
        {/* k2b-ui gap: v2 lists do not virtualize yet (lane MW); the list loads 50 targets a page. */}
        <Show
          when={rows().length > 0}
          fallback={
            <Empty
              icon="route"
              text={t().targetsEmpty}
              action={{ label: t().addTarget, icon: "plus", onClick: () => props.setAdding(true) }}
            />
          }
        >
          {/* a dense table, one line per target (identity B, rule 4): what is released, for which base, how far */}
          <Table
            label={t().targetsTitle}
            rows={rows()}
            rowKey={(row) => row.id}
            phone={(row) => ({ mark: targetMark(row), lines: [row.entry, `${row.baseName} · ${scopeText(t(), row)}`] })}
            columns={[
              {
                title: t().targetColumn,
                width: { min: 200, default: 280 },
                mark: targetMark,
                cell: (row) => <Text weight="strong">{row.entry}</Text>,
              },
              { title: t().baseColumn, width: { min: 160, default: 220 }, cell: (row) => row.baseName },
              { title: t().scopeColumn, width: { min: 140, default: 180 }, drop: true, cell: (row) => scopeText(t(), row) },
              {
                title: t().releasedColumn,
                width: { min: 110, default: 130 },
                drop: true,
                cell: (row) => new Intl.DateTimeFormat(locale(), { dateStyle: "medium" }).format(new Date(row.createdAt)),
              },
              {
                title: "",
                align: "end",
                width: { min: 56, default: 56 },
                cell: (row) => (
                  <Menu
                    label={t().removeTargetTitle({ entry: row.entry })}
                    disabled={busy() !== null}
                    items={[{ label: t().remove, icon: "x", danger: true, onClick: () => void remove(row) }]}
                  />
                ),
              },
            ]}
          />
        </Show>
        <Show when={nextOffset() !== null}>
          <Bar
            end={
              <Button icon="chevrons-down" busy={loadingMore()} onClick={() => void more()}>
                {t().loadMore}
              </Button>
            }
          />
        </Show>
      </Show>
      <AddTargetDialog
        t={t()}
        open={props.adding}
        signal={controller.signal}
        close={(created) => {
          props.setAdding(false);
          if (created) void reload();
        }}
      />
    </Pane>
  );
}
