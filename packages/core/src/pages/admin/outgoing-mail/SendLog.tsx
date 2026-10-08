import { coreClient } from "@k2b/cloud/clients/core";
import {
  type AdminMailApp,
  type AdminMailRecord,
  type MailPage,
  type MailRetention,
  type MailStatus,
  MailStatusSchema,
} from "@k2b/cloud/contracts";
import { mutation, query } from "@k2b/stdlib/solid";
import {
  Button,
  CodeDisplay,
  DataTable,
  type DataTableColumn,
  DescriptionList,
  dialogCore,
  Format,
  NoticeCard,
  NumberInput,
  PanelDialog,
  Placeholder,
  panelDialogOptions,
  prompts,
  Select,
  StatusBadge,
  type StatusTone,
  TextInput,
  toast,
  useLocale,
} from "@k2b/ui";
import { createSignal, For, onCleanup, Show } from "solid-js";
import { outgoingMailMessages } from "./messages";

export type SendLogFilter = { app?: string; status?: MailStatus; recipient?: string };
export type SendLogState = { filter: SendLogFilter; page: MailPage<AdminMailRecord>; retention: MailRetention };
type Messages = ReturnType<typeof outgoingMailMessages.resolve>["t"];
type Content = { purged: true; contentPurgedAt: string } | { purged: false; text: string | null; html: string | null };

const api = coreClient.admin.core["outgoing-mail"];
export const SEND_LOG_PAGE_SIZE = 25;

const TONES: Record<MailStatus, StatusTone> = {
  queued: "info",
  sending: "running",
  sent: "ok",
  failed: "error",
  bounced: "warning",
  cancelled: "neutral",
};

const messages = () => {
  const locale = useLocale();
  return () => outgoingMailMessages.resolve([locale()]).t;
};

const errorText = async (response: { json: () => Promise<unknown> }, fallback: string) => {
  const body = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
};

/** The filter as URL query parameters, shared by the SSR page and the island so reload shows the same log. */
export const sendLogQuery = (filter: SendLogFilter) => ({
  ...(filter.app ? { app: filter.app } : {}),
  ...(filter.status ? { status: filter.status } : {}),
  ...(filter.recipient ? { recipient: filter.recipient } : {}),
});
const status = (value: string | null | undefined): MailStatus | undefined => MailStatusSchema.safeParse(value).data;
export const parseSendLogFilter = (params: Record<string, string | undefined>): SendLogFilter => ({
  ...(params.app ? { app: params.app.slice(0, 200) } : {}),
  ...(status(params.status) ? { status: status(params.status) } : {}),
  ...(params.recipient ? { recipient: params.recipient.slice(0, 320) } : {}),
});

const statusLabel = (status: MailStatus, t: Messages) =>
  ({
    queued: t.statusQueued,
    sending: t.statusSending,
    sent: t.statusSent,
    failed: t.statusFailed,
    bounced: t.statusBounced,
    cancelled: t.statusCancelled,
  })[status];

function StatusCell(props: { status: MailStatus }) {
  const t = messages();
  return <StatusBadge tone={TONES[props.status]} label={statusLabel(props.status, t())} />;
}

function RetentionDialog(props: { retention: MailRetention; close: () => void; onSaved: (value: MailRetention) => void }) {
  const t = messages();
  const [contentDays, setContentDays] = createSignal<number | null>(props.retention.contentDays);
  const [recordDays, setRecordDays] = createSignal<number | null>(props.retention.recordDays);
  const valid = () => !!contentDays() && !!recordDays() && recordDays()! >= contentDays()!;
  const save = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const json = { contentDays: contentDays()!, recordDays: recordDays()! };
      const response = await api.retention.$put({ json }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorText(response, t().retentionFailed));
      return json;
    },
    onSuccess: (value) => {
      props.onSaved(value);
      props.close();
    },
  });
  onCleanup(() => save.abort());
  return (
    <form
      class="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid() && !save.loading()) void save.mutate(undefined);
      }}
    >
      <NumberInput
        label={t().retentionContent}
        description={t().retentionContentHint}
        value={contentDays()}
        onValueChange={setContentDays}
        min={1}
        max={36500}
        disabled={save.loading()}
        required
        autofocus
      />
      <NumberInput
        label={t().retentionRecords}
        description={t().retentionRecordsHint}
        value={recordDays()}
        onValueChange={setRecordDays}
        min={1}
        max={36500}
        disabled={save.loading()}
        required
        error={() => (contentDays() && recordDays() && recordDays()! < contentDays()! ? t().retentionOrder : undefined)}
      />
      <Show when={save.error()}>{(error) => <NoticeCard tone="danger" title={t().retentionFailed} detail={error().message} />}</Show>
      <div class="flex justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => props.close()} disabled={save.loading()}>
          {t().cancel}
        </Button>
        <Button type="submit" size="sm" disabled={!valid() || save.loading()}>
          {t().save}
        </Button>
      </div>
    </form>
  );
}

/** Exported for the layout test: one log entry must fit a phone. */
export function MessageDialog(props: { record: AdminMailRecord; appName: string; close: () => void; onChanged: () => void }) {
  const t = messages();
  const [record, setRecord] = createSignal(props.record);
  const [batchCancelled, setBatchCancelled] = createSignal(false);
  const cancellableBatch = () => !batchCancelled() && record().batchId;
  const content = mutation.create({
    mutation: async (_: void, { abortSignal }): Promise<Content> => {
      const response = await api.messages[":id"].content.$get({ param: { id: record().id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorText(response, t().contentFailed));
      return response.json();
    },
  });
  const cancel = mutation.create({
    mutation: async (_: void, { abortSignal }) => {
      const response = await api.messages[":id"].cancel.$post({ param: { id: record().id } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorText(response, t().cancelFailed));
      return response.json();
    },
    onSuccess: (updated) => {
      setRecord(updated);
      props.onChanged();
      toast.success(t().cancelDone);
    },
    onError: (error) => toast.error(error.message),
  });
  const cancelBatch = mutation.create({
    mutation: async (batchId: string, { abortSignal }) => {
      const response = await api.batches[":batchId"].cancel.$post({ param: { batchId } }, { init: { signal: abortSignal } });
      if (!response.ok) throw new Error(await errorText(response, t().cancelBatchFailed));
      return response.json();
    },
    onSuccess: async ({ cancelled }) => {
      setBatchCancelled(true);
      props.onChanged();
      toast.success(cancelled === 0 ? t().cancelBatchEmpty : t().cancelBatchDone({ count: cancelled }));
      const response = await api.messages[":id"].$get({ param: { id: record().id } }).catch(() => undefined);
      if (response?.ok) setRecord(await response.json());
    },
    onError: (error) => toast.error(error.message),
  });
  onCleanup(() => {
    content.abort();
    cancel.abort();
    cancelBatch.abort();
  });
  const confirmCancel = async () => {
    const confirmed = await prompts.confirm(t().cancelConfirm, {
      title: t().cancelTitle,
      icon: "ti ti-mail-x",
      variant: "danger",
      confirmText: t().cancelMail,
    });
    if (confirmed) void cancel.mutate(undefined);
  };
  const confirmCancelBatch = async (batchId: string) => {
    const confirmed = await prompts.confirm(t().cancelBatchConfirm, {
      title: t().cancelBatch,
      icon: "ti ti-mail-x",
      variant: "danger",
      confirmText: t().cancelBatch,
    });
    if (confirmed) void cancelBatch.mutate(batchId);
  };
  const busy = () => content.loading() || cancel.loading() || cancelBatch.loading();
  const body = () => {
    const value = content.data();
    return value && !value.purged ? value : undefined;
  };
  const purged = () => !!record().contentPurgedAt || content.data()?.purged === true;
  const details = () => {
    const r = record();
    return [
      { term: t().statusLabel, description: <StatusCell status={r.status} /> },
      { term: t().app, description: props.appName },
      { term: t().profile, description: <span class="font-mono">{r.profile}</span> },
      {
        term: t().recipients,
        description: (
          <ul class="flex flex-col gap-0.5">
            <For each={r.to}>{(address) => <li class="[overflow-wrap:anywhere]">{address}</li>}</For>
          </ul>
        ),
      },
      { term: t().created, description: <Format.DateTime value={r.createdAt} /> },
      ...(r.sentAt ? [{ term: t().sentAt, description: <Format.DateTime value={r.sentAt} /> }] : []),
      { term: t().attempts, description: <span class="tabular-nums">{r.attempts}</span> },
      ...(r.actor ? [{ term: t().actor, description: r.actor.name }] : []),
      ...(r.batchId ? [{ term: t().batch, description: <span class="font-mono break-all">{r.batchId}</span> }] : []),
      ...(r.ref
        ? [
            {
              term: t().reference,
              description: (
                <span class="font-mono break-all">
                  {r.ref.scope}:{r.ref.id}
                </span>
              ),
            },
          ]
        : []),
      ...(r.error ? [{ term: t().error, description: <span class="break-words">{r.error}</span> }] : []),
      ...(r.response ? [{ term: t().response, description: <span class="font-mono text-xs break-words">{r.response}</span> }] : []),
    ];
  };
  return (
    <PanelDialog>
      <PanelDialog.Header title={record().subject} subtitle={t().messageSubtitle} icon="ti ti-mail" close={props.close} />
      <PanelDialog.Body scrollPreserveKey="outgoing-mail-message">
        <PanelDialog.Section title={t().detailsSection}>
          <DescriptionList items={details()} layout="rows" size="sm" />
        </PanelDialog.Section>
        <Show when={record().failures.length}>
          <PanelDialog.Section title={t().failuresSection}>
            <ul class="flex flex-col gap-2">
              <For each={record().failures}>
                {(failure) => (
                  <li class="min-w-0 text-sm">
                    <p class="text-primary [overflow-wrap:anywhere]">{failure.recipient}</p>
                    <p class="mt-0.5 break-words text-xs text-dimmed">{failure.reason}</p>
                  </li>
                )}
              </For>
            </ul>
          </PanelDialog.Section>
        </Show>
        <Show when={record().attachments.length}>
          <PanelDialog.Section title={t().attachmentsSection} subtitle={t().attachmentsHint}>
            <ul class="flex flex-col gap-2">
              <For each={record().attachments}>
                {(attachment) => (
                  <li class="min-w-0 text-sm">
                    <p class="truncate text-primary">{attachment.filename}</p>
                    <p class="mt-0.5 truncate text-xs text-dimmed">
                      {attachment.contentType} · <Format.Bytes value={attachment.size} />
                    </p>
                    <p class="mt-0.5 truncate font-mono text-xs text-dimmed" title={attachment.sha256}>
                      SHA-256 {attachment.sha256}
                    </p>
                  </li>
                )}
              </For>
            </ul>
          </PanelDialog.Section>
        </Show>
        <PanelDialog.Section title={t().contentSection} subtitle={t().contentHint}>
          <Show
            when={body()}
            fallback={
              <Show when={!purged()} fallback={<p class="text-sm text-dimmed">{t().contentPurged}</p>}>
                <div>
                  <Button type="button" variant="secondary" size="sm" onClick={() => void content.mutate(undefined)} disabled={busy()}>
                    <i class="ti ti-eye" aria-hidden="true" />
                    {t().showContent}
                  </Button>
                </div>
              </Show>
            }
          >
            {(value) => (
              <div class="flex flex-col gap-3">
                <CodeDisplay code={value().text ?? ""} title={t().textBody} lineNumbers={false} copy class="max-h-96" />
                <Show when={value().html}>
                  {(html) => <CodeDisplay code={html()} title={t().htmlSource} lineNumbers={false} copy class="max-h-96" />}
                </Show>
              </div>
            )}
          </Show>
          <Show when={content.error()}>{(error) => <NoticeCard tone="danger" title={t().contentFailed} detail={error().message} />}</Show>
        </PanelDialog.Section>
      </PanelDialog.Body>
      <PanelDialog.Footer>
        <Show when={record().status === "queued" || cancellableBatch()}>
          <div class="flex flex-wrap gap-2">
            <Show when={record().status === "queued"}>
              <Button type="button" variant="danger" size="sm" onClick={() => void confirmCancel()} disabled={busy()}>
                {t().cancelMail}
              </Button>
            </Show>
            <Show when={cancellableBatch()}>
              {(batchId) => (
                <Button type="button" variant="secondary" size="sm" onClick={() => void confirmCancelBatch(batchId())} disabled={busy()}>
                  {t().cancelBatch}
                </Button>
              )}
            </Show>
          </div>
        </Show>
        <Button type="button" variant="secondary" size="sm" onClick={props.close} disabled={cancel.loading() || cancelBatch.loading()}>
          {t().close}
        </Button>
      </PanelDialog.Footer>
    </PanelDialog>
  );
}

export function SendLog(props: { initial: SendLogState; apps: readonly AdminMailApp[] }) {
  const t = messages();
  const [filter, setFilter] = createSignal<SendLogFilter>(props.initial.filter);
  const [search, setSearch] = createSignal(props.initial.filter.recipient ?? "");
  const [retention, setRetention] = createSignal(props.initial.retention);
  const [revision, setRevision] = createSignal(0);
  const [more, setMore] = createSignal<{ items: AdminMailRecord[]; nextCursor?: string } | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  let first = true;
  let generation = 0;

  const fetchPage = async (current: SendLogFilter, cursor: string | undefined, signal?: AbortSignal) => {
    const response = await api.messages.$get(
      { query: { ...sendLogQuery(current), limit: String(SEND_LOG_PAGE_SIZE), ...(cursor ? { cursor } : {}) } },
      { init: { signal } },
    );
    if (!response.ok) throw new Error(await errorText(response, t().logFailed));
    return response.json();
  };
  const page = query.create({
    source: () => ({ filter: filter(), revision: revision() }),
    load: async (source, { abortSignal }) => {
      generation++;
      setMore(null);
      if (first) {
        first = false;
        return props.initial.page;
      }
      return fetchPage(source.filter, undefined, abortSignal);
    },
  });
  const current = () => page.data() ?? props.initial.page;
  const rows = () => [...current().items, ...(more()?.items ?? [])];
  const nextCursor = () =>
    page.loading() || page.refreshing() || page.stale() ? undefined : more() ? more()!.nextCursor : current().nextCursor;
  const loadMore = async () => {
    const cursor = nextCursor();
    if (!cursor || loadingMore()) return;
    const requestGeneration = generation;
    const requestFilter = filter();
    const requestRevision = revision();
    const isCurrent = () => generation === requestGeneration && filter() === requestFilter && revision() === requestRevision;
    setLoadingMore(true);
    try {
      const next = await fetchPage(requestFilter, cursor);
      if (!isCurrent()) return;
      setMore((previous) => ({ items: [...(previous?.items ?? []), ...next.items], nextCursor: next.nextCursor }));
    } catch (error) {
      if (isCurrent()) toast.error(error instanceof Error ? error.message : t().logFailed);
    } finally {
      setLoadingMore(false);
    }
  };

  const update = (change: Partial<SendLogFilter>) => {
    const next = { ...filter(), ...change };
    for (const key of Object.keys(next) as (keyof SendLogFilter)[]) if (!next[key]) delete next[key];
    setFilter(next);
    const url = new URL(window.location.href);
    for (const key of ["app", "status", "recipient"]) url.searchParams.delete(key);
    for (const [key, value] of Object.entries(sendLogQuery(next))) url.searchParams.set(key, value);
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  };
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const onSearch = (value: string) => {
    setSearch(value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => update({ recipient: value.trim() || undefined }), 300);
  };
  onCleanup(() => clearTimeout(searchTimer));

  const appName = (appId: string) => props.apps.find((app) => app.appId === appId)?.name ?? appId;
  const openMessage = (record: AdminMailRecord) =>
    void dialogCore.open<void>(
      (close) => (
        <MessageDialog record={record} appName={appName(record.appId)} close={() => close()} onChanged={() => setRevision((v) => v + 1)} />
      ),
      panelDialogOptions,
    );
  const openRetention = () =>
    void prompts.dialog<void>((close) => <RetentionDialog retention={retention()} close={() => close()} onSaved={setRetention} />, {
      title: t().retentionTitle,
      icon: "ti ti-history",
    });

  const columns = (): DataTableColumn<AdminMailRecord>[] => [
    { id: "message", header: t().message },
    { id: "app", header: t().app, class: "hidden md:table-cell" },
    { id: "created", header: t().created, class: "hidden lg:table-cell" },
    { id: "status", header: t().statusLabel, headerClass: "w-px", cellClass: "text-right whitespace-nowrap" },
  ];
  const filtered = () => !!(filter().app || filter().status || filter().recipient);

  return (
    <section class="flex flex-col gap-3" aria-labelledby="outgoing-mail-log">
      <div class="flex flex-wrap items-end justify-between gap-2">
        <div class="min-w-0 flex-1">
          <h2 id="outgoing-mail-log" class="text-sm font-semibold text-primary">
            {t().log}
          </h2>
          <p class="mt-1 text-xs text-dimmed">{t().logDescription(retention())}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={openRetention}>
          <i class="ti ti-history" aria-hidden="true" />
          {t().retention}
        </Button>
      </div>
      <div class="grid gap-2 sm:grid-cols-3">
        <Select
          aria-label={t().app}
          placeholder={t().allApps}
          value={filter().app ?? null}
          onValueChange={(value) => update({ app: value ?? undefined })}
          options={props.apps.map((app) => ({ value: app.appId, label: app.name }))}
          clearable
        />
        <Select
          aria-label={t().statusLabel}
          placeholder={t().allStatuses}
          value={filter().status ?? null}
          onValueChange={(value) => update({ status: status(value) })}
          options={MailStatusSchema.options.map((value) => ({ value, label: statusLabel(value, t()) }))}
          clearable
        />
        <TextInput
          aria-label={t().recipientSearch}
          type="search"
          icon="ti ti-search"
          placeholder={t().recipientSearch}
          value={search()}
          onValueChange={onSearch}
          clearable
          maxLength={320}
        />
      </div>
      <Show when={page.error()}>
        {(error) => (
          <NoticeCard tone="danger" title={t().logFailed} detail={error().message}>
            <Button size="sm" onClick={() => void page.refresh()}>
              {t().retry}
            </Button>
          </NoticeCard>
        )}
      </Show>
      <DataTable
        ariaLabel={t().log}
        rows={rows()}
        columns={columns()}
        getRowId={(row) => row.id}
        onRowClick={openMessage}
        highlightColumns={false}
        stickyHeader={false}
        surface="paper"
        verticalAlign="top"
        hasMore={!!nextCursor()}
        loadingMore={loadingMore()}
        onLoadMore={() => void loadMore()}
        empty={
          <Placeholder
            icon={filtered() ? "ti ti-filter-off" : "ti ti-mail-off"}
            title={filtered() ? t().noMatches : t().noMail}
            description={filtered() ? undefined : t().noMailDescription}
          />
        }
        renderCell={({ row, col }) => {
          if (col.id === "message")
            return (
              <div class="min-w-0">
                <p class="truncate text-sm font-medium text-primary">{row.subject}</p>
                <p class="mt-0.5 truncate text-xs text-secondary">
                  {row.to[0]}
                  {row.to.length > 1 ? ` ${t().moreRecipients({ count: row.to.length - 1 })}` : ""}
                </p>
                <p class="mt-0.5 truncate text-xs text-dimmed lg:hidden">
                  <span class="md:hidden">{appName(row.appId)} · </span>
                  <Format.DateTime value={row.createdAt} />
                </p>
              </div>
            );
          if (col.id === "app")
            return (
              <div class="min-w-32">
                <p class="truncate text-sm text-secondary">{appName(row.appId)}</p>
                <p class="mt-0.5 truncate font-mono text-xs text-dimmed">{row.profile}</p>
              </div>
            );
          if (col.id === "created")
            return (
              <p class="min-w-36 text-sm tabular-nums text-secondary">
                <Format.DateTime value={row.createdAt} />
              </p>
            );
          if (col.id === "status") return <StatusCell status={row.status} />;
          return "";
        }}
      />
    </section>
  );
}
