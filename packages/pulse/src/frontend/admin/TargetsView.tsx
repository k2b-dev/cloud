import { useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Dialog,
  Empty,
  Failed,
  Field,
  Input,
  List,
  Lookup,
  Menu,
  Notice,
  Pane,
  Row,
  StatusRow,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
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
  const [loading, setLoading] = createSignal(false);
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
  return (
    <Pane
      label={props.label}
      scrollKey="pulse-admin-targets"
      status={<StatusRow lead={t().targetsCount({ count: total() })} loading={loading()} />}
    >
      <Band>
        <Text>{t().targetsIntro}</Text>
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
          <List label={t().targetsTitle}>
            <For each={rows()}>
              {(row) => (
                <Row
                  icon="route"
                  lines={[row.entry, `${row.baseName} · ${scopeText(t(), row)}`]}
                  end={
                    <Menu
                      label={t().removeTargetTitle({ entry: row.entry })}
                      disabled={busy() !== null}
                      items={[{ label: t().remove, icon: "x", danger: true, onClick: () => void remove(row) }]}
                    />
                  }
                />
              )}
            </For>
          </List>
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
