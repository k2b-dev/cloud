import type { AdminMailApp, AdminMailRecord, MailPage, MailRetention, MailStatus } from "@k2b/cloud/contracts";
import { formatBytes, principalLabel } from "@k2b/cloud/shared";
import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Chip,
  Dialog,
  Facts,
  FilterBar,
  type NavProps,
  Notice,
  Pane,
  Path,
  Prose,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  useToast,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import { OUTGOING_MAIL_HREF } from "./area";
import { type LogState, logFilter, logHref, logQuery, statusLabel } from "./log-query";
import { outgoingMailMessages } from "./messages";
import RetentionDialog from "./RetentionDialog";
import { api } from "./shared";

export const SEND_LOG_PAGE_SIZE = 25;
type Content = { purged: true; contentPurgedAt: string } | { purged: false; text: string | null; html: string | null };
const STATUS: Record<MailStatus, "ok" | "warn" | "bad" | undefined> = {
  queued: undefined,
  sending: undefined,
  sent: "ok",
  failed: "bad",
  bounced: "warn",
  cancelled: undefined,
};

/** The state of a mail as a chip: a tone for done, failed and bounced, a plain word for the rest. */
const MailChip = (props: { status: MailStatus }) => {
  const locale = useLocale();
  const label = () => statusLabel(props.status, outgoingMailMessages.resolve([locale()]).t);
  const tone = () => STATUS[props.status];
  return (
    <Show when={tone()} fallback={<Chip>{label()}</Chip>}>
      {(status) => <Chip status={status()}>{label()}</Chip>}
    </Show>
  );
};

const errorText = async (response: { json: () => Promise<unknown> }, fallback: string) => {
  const body = await response.json().catch(() => null);
  return body && typeof body === "object" && "message" in body && typeof body.message === "string" ? body.message : fallback;
};

export type LogScreenProps = {
  nav: NavProps;
  apps: Pick<AdminMailApp, "appId" | "name">[];
  state: LogState;
  page: MailPage<AdminMailRecord>;
  retention: MailRetention;
  /** The open message from the address, read by the server. */
  message: AdminMailRecord | null;
  /** The reader's time zone, so the server and the browser word times alike. */
  timeZone: string;
};

/**
 * The send log of Outgoing mail on v2: filter statements for app, state and recipient in the address, newest mail
 * first with "Load more", and the open message beside it with its details, its text on request, and cancelling.
 */
export default function LogScreen(props: LogScreenProps) {
  const locale = useLocale();
  const t = () => outgoingMailMessages.resolve([locale()]).t;
  const toast = useToast();
  const query = createMemo(() => logQuery(locale(), props.apps));
  const [state, setState] = createSignal(props.state);
  const [page, setPage] = createSignal(props.page);
  const [loading, setLoading] = createSignal(false);
  const [failed, setFailed] = createSignal<string | null>(null);
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [retention, setRetention] = createSignal(props.retention);
  const [retentionOpen, setRetentionOpen] = createSignal(false);
  const [record, setRecord] = createSignal(props.message);
  const [content, setContent] = createSignal<Content | null>(null);
  const [busy, setBusy] = createSignal(false);
  let generation = 0;
  const time = (iso: string) =>
    new Intl.DateTimeFormat(locale(), { dateStyle: "medium", timeStyle: "short", timeZone: props.timeZone }).format(new Date(iso));
  const appName = (appId: string) => props.apps.find((app) => app.appId === appId)?.name ?? appId;

  const fetchPage = async (current: LogState, cursor?: string) => {
    const filter = logFilter(current);
    const response = await api.messages.$get({
      query: {
        ...(filter.app ? { app: filter.app } : {}),
        ...(filter.status ? { status: filter.status[0] } : {}),
        ...(filter.recipient ? { recipient: filter.recipient } : {}),
        limit: String(SEND_LOG_PAGE_SIZE),
        ...(cursor ? { cursor } : {}),
      },
    });
    if (!response.ok) throw new Error(await errorText(response, t().logFailed));
    return (await response.json()) as MailPage<AdminMailRecord>;
  };
  const load = async (next: LogState) => {
    const asked = ++generation;
    setLoading(true);
    try {
      const fresh = await fetchPage(next);
      if (asked !== generation) return;
      setPage(fresh);
      setFailed(null);
    } catch (error) {
      if (asked === generation) setFailed(error instanceof Error ? error.message : t().logFailed);
    } finally {
      if (asked === generation) setLoading(false);
    }
  };
  /** The filter bar already wrote the address; the log loads in place. */
  const change = (next: LogState) => {
    setState(next);
    void load(next);
  };
  const loadMore = async () => {
    const cursor = page().nextCursor;
    if (!cursor || loadingMore()) return;
    const asked = generation;
    setLoadingMore(true);
    try {
      const next = await fetchPage(state(), cursor);
      if (asked !== generation) return;
      setPage((current) => ({ ...next, items: [...current.items, ...next.items] }));
    } catch (error) {
      toast(error instanceof Error ? error.message : t().logFailed, { status: "bad" });
    } finally {
      setLoadingMore(false);
    }
  };

  const showContent = async () => {
    const current = record();
    if (!current) return;
    setBusy(true);
    try {
      const response = await api.messages[":id"].content.$get({ param: { id: current.id } });
      if (!response.ok) throw new Error(await errorText(response, t().contentFailed));
      setContent((await response.json()) as Content);
    } catch (error) {
      toast(error instanceof Error ? error.message : t().contentFailed, { status: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    const current = record();
    if (!current || !(await Dialog.confirm({ title: t().cancelTitle, description: t().cancelConfirm, confirm: t().cancelMail }))) return;
    setBusy(true);
    try {
      const response = await api.messages[":id"].cancel.$post({ param: { id: current.id } });
      if (!response.ok) throw new Error(await errorText(response, t().cancelFailed));
      setRecord((await response.json()) as AdminMailRecord);
      toast(t().cancelDone, { status: "ok" });
      void load(state());
    } catch (error) {
      toast(error instanceof Error ? error.message : t().cancelFailed, { status: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const [batchCancelled, setBatchCancelled] = createSignal(false);
  const cancelBatch = async (batchId: string) => {
    if (!(await Dialog.confirm({ title: t().cancelBatch, description: t().cancelBatchConfirm, confirm: t().cancelBatch }))) return;
    setBusy(true);
    try {
      const response = await api.batches[":batchId"].cancel.$post({ param: { batchId } });
      if (!response.ok) throw new Error(await errorText(response, t().cancelBatchFailed));
      const { cancelled } = (await response.json()) as { cancelled: number };
      setBatchCancelled(true);
      toast(cancelled === 0 ? t().cancelBatchEmpty : t().cancelBatchDone({ count: cancelled }), { status: "ok" });
      const current = record();
      const fresh = current ? await api.messages[":id"].$get({ param: { id: current.id } }).catch(() => undefined) : undefined;
      if (fresh?.ok) setRecord((await fresh.json()) as AdminMailRecord);
      void load(state());
    } catch (error) {
      toast(error instanceof Error ? error.message : t().cancelBatchFailed, { status: "bad" });
    } finally {
      setBusy(false);
    }
  };
  const purged = () => !!record()?.contentPurgedAt || content()?.purged === true;
  const body = () => {
    const value = content();
    return value && !value.purged ? value : undefined;
  };
  const facts = (r: AdminMailRecord) => [
    { label: t().app, value: appName(r.appId) },
    { label: t().profile, value: r.profile, mono: true },
    { label: t().recipients, value: r.to.join(", ") },
    { label: t().created, value: time(r.createdAt) },
    ...(r.sentAt ? [{ label: t().sentAt, value: time(r.sentAt) }] : []),
    { label: t().attempts, value: String(r.attempts) },
    ...(r.actor
      ? [
          {
            label: t().actor,
            value: principalLabel({ principal: { type: "user", userId: r.actor.id }, displayName: r.actor.name }, locale()),
          },
        ]
      : []),
    ...(r.batchId ? [{ label: t().batch, value: r.batchId, mono: true, copy: r.batchId }] : []),
    ...(r.ref ? [{ label: t().reference, value: `${r.ref.scope}:${r.ref.id}`, mono: true }] : []),
    ...(r.error ? [{ label: t().error, value: r.error }] : []),
    ...(r.response ? [{ label: t().response, value: r.response, mono: true }] : []),
  ];
  const filtered = () => !!(state().filters.app || state().filters.status || state().search);

  return (
    <AdminWorkspace
      nav={props.nav}
      detail={460}
      detailEmpty={{ icon: "mail", text: t().noMessageOpen }}
      head={
        <Bar
          start={<Path label={t().title} items={[{ label: t().title, href: OUTGOING_MAIL_HREF.profiles }, { label: t().sendLog }]} />}
          end={
            <Button icon="history" onClick={() => setRetentionOpen(true)}>
              {t().retention}
            </Button>
          }
        />
      }
    >
      <Pane.Split>
        <Pane
          label={t().sendLog}
          width={{ min: 420, default: 640 }}
          scrollKey="admin-outgoing-mail-log"
          status={
            <>
              <FilterBar query={query()} state={state()} onChange={change} />
              <StatusRow lead={t().logDescription(retention())} loading={loading()} />
            </>
          }
        >
          <Show when={failed()}>
            {(message) => (
              <Notice tone="bad" title={t().logFailed}>
                {message()}
              </Notice>
            )}
          </Show>
          <Table
            label={t().sendLog}
            rows={page().items}
            rowKey={(row) => row.id}
            current={record()?.id}
            open={(row) => ({ href: logHref(query(), state(), row.id) })}
            empty={filtered() ? { icon: "filter-off", text: t().noMatches } : { icon: "mail-off", text: t().noMailDescription }}
            phone={(row) => ({
              lines: [row.subject, `${row.to[0] ?? ""} · ${time(row.createdAt)}`],
              marks: <MailChip status={row.status} />,
            })}
            columns={[
              {
                title: t().message,
                width: { min: 220, default: 280 },
                cell: (row) => ({
                  lines: [
                    row.subject,
                    `${row.to[0] ?? ""}${row.to.length > 1 ? ` ${t().moreRecipients({ count: row.to.length - 1 })}` : ""}`,
                  ],
                }),
              },
              {
                title: t().app,
                width: { min: 120, default: 140 },
                drop: true,
                cell: (row) => ({ lines: [appName(row.appId), row.profile] }),
              },
              { title: t().created, width: { min: 150, default: 170 }, drop: true, cell: (row) => time(row.createdAt) },
              { title: t().statusLabel, cell: (row) => <MailChip status={row.status} /> },
            ]}
          />
          <Show when={page().nextCursor}>
            <Bar
              end={
                <Button busy={loadingMore()} onClick={() => void loadMore()}>
                  {t().loadMore}
                </Button>
              }
            />
          </Show>
        </Pane>
        {record() ? (
          <Pane
            detail
            label={record()!.subject}
            back={{ label: t().sendLog, href: logHref(query(), state()) }}
            head={
              <Bar
                start={<Text type="body">{record()!.subject}</Text>}
                end={<Button variant="ghost" icon="x" label={t().close} href={logHref(query(), state())} />}
              />
            }
            status={
              <Bar
                start={<MailChip status={record()!.status} />}
                end={
                  <>
                    <Show when={record()!.status === "queued"}>
                      <Button icon="mail-x" disabled={busy()} onClick={() => void cancel()}>
                        {t().cancelMail}
                      </Button>
                    </Show>
                    <Show when={!batchCancelled() && record()!.batchId}>
                      {(batchId) => (
                        <Button variant="text" disabled={busy()} onClick={() => void cancelBatch(batchId())}>
                          {t().cancelBatch}
                        </Button>
                      )}
                    </Show>
                  </>
                }
              />
            }
          >
            <Section icon="list-details" title={t().detailsSection}>
              <Facts items={facts(record()!)} />
            </Section>
            <Show when={record()!.failures.length}>
              <Section icon="alert-triangle" title={t().failuresSection} count={record()!.failures.length}>
                <For each={record()!.failures}>{(failure) => <Row lines={[failure.recipient, failure.reason]} icon="user-x" />}</For>
              </Section>
            </Show>
            <Show when={record()!.attachments.length}>
              <Section icon="paperclip" title={t().attachmentsSection} summary={t().attachmentsHint}>
                <For each={record()!.attachments}>
                  {(attachment) => (
                    <Row
                      lines={[
                        attachment.filename,
                        `${attachment.contentType} · ${formatBytes(attachment.size, { locale: locale() })}`,
                        `SHA-256 ${attachment.sha256}`,
                      ]}
                      icon="file"
                    />
                  )}
                </For>
              </Section>
            </Show>
            <Section
              icon="eye"
              title={t().contentSection}
              summary={t().contentHint}
              actions={
                !body() && !purged()
                  ? [{ label: t().showContent, icon: "eye", onClick: () => void showContent(), disabled: busy() }]
                  : undefined
              }
            >
              <Show when={purged()}>
                <Text muted>{t().contentPurged}</Text>
              </Show>
              <Show when={body()}>
                {(value) => (
                  <>
                    <Prose>{value().text ?? ""}</Prose>
                    {/* k2b-ui gap: no code view in v2; the HTML source shows as reading text. */}
                    <Show when={value().html}>
                      {(html) => <Facts items={[{ label: t().htmlSource, value: html(), mono: true, copy: html() }]} />}
                    </Show>
                  </>
                )}
              </Show>
            </Section>
          </Pane>
        ) : undefined}
      </Pane.Split>
      <RetentionDialog open={retentionOpen()} retention={retention()} onClose={() => setRetentionOpen(false)} onSaved={setRetention} />
    </AdminWorkspace>
  );
}
