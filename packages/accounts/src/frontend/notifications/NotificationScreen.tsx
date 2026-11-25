import { formatNumber } from "@k2b/cloud/shared";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Check,
  Chip,
  Dialog,
  Empty,
  Facts,
  Failed,
  FilterBar,
  Inline,
  Menu,
  Notice,
  Pane,
  Prose,
  RecordHead,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, Show } from "solid-js";
import { apiClient } from "@/api/client";
import AccountsNav from "../AccountsNav";
import { kindHref } from "../activity/kind";
import { usePageSwap } from "../lib/page-swap";
import { useListMessages } from "../list-messages";
import { useAccountsMessages } from "../messages";
import { type BatchStatus, batchChip } from "./chips";
import { useNotificationMessages } from "./messages";
import { batchHref, batchStatusLabel, type RecipientsState, recipientStatusLabel, recipientsQuery } from "./query";

/** A batch as its page shows it; numbers and dates are worded on the server. */
export type BatchView = {
  id: string;
  subject: string;
  status: BatchStatus;
  created: string;
  matched: string;
  deliverable: string;
  skipped: string;
  sent: string;
  errors: string;
  errorCount: number;
  selection: { userIds: string[]; groupIds: string[] };
  selectionHash: string;
  bodyMarkdown: string;
};

/** Who the batch was meant for: chosen users and groups, or the rules of a legacy batch. */
export type AudienceView = {
  legacy: boolean;
  users: { id: string; name: string; uid: string; image?: string }[];
  groups: { id: string; name: string }[];
  /** "12 more" when the page names only the first users or groups. */
  moreUsers: string | null;
  moreGroups: string | null;
  /** The rules of a legacy audience, worded. */
  rules: { label: string; icon: string }[];
};

export type RecipientRow = {
  userId: string;
  name: string;
  /** The address of the person's picture, if they have one. */
  image?: string;
  uid: string;
  email: string;
  source: string;
  status: "pending" | "sending" | "sent" | "skipped" | "error";
  /** The mail's own state where it differs from the recipient's, such as a bounce. */
  mail: { label: string; bad: boolean } | null;
  attempts: number;
  sent: string;
  error: string | null;
};

export type NotificationScreenProps = {
  batch: BatchView;
  audience: AudienceView;
  state: RecipientsState;
  page: number;
  pages: number;
  total: number;
  /** The recipients of this page; null when they could not be read. A draft has none yet. */
  recipients: RecipientRow[] | null;
  /** Why the draft cannot be sent (a legacy audience), or null. */
  blocked: string | null;
  pendingRequests: number;
};

type Preview = { deliverableCount: number; skippedNoEmailCount: number; recipientHash: string };

const readError = async (res: Pick<Response, "json">, fallback: string) => {
  try {
    const data = await res.json();
    return data.message ?? data.error?.message ?? fallback;
  } catch {
    return fallback;
  }
};

const recipientChip = (status: RecipientRow["status"], label: string) =>
  status === "sent" ? (
    <Chip status="ok">{label}</Chip>
  ) : status === "error" ? (
    <Chip status="bad">{label}</Chip>
  ) : status === "pending" || status === "sending" ? (
    <Chip status="warn">{label}</Chip>
  ) : (
    <Chip>{label}</Chip>
  );

/**
 * A notification batch on v2: its subject and state in the head, its recipients with their status as a statement, and
 * beside them the numbers, the audience and the message. A draft is sent after a second look at its recipients; a
 * batch with errors sends its failed recipients again.
 */
export default function NotificationScreen(props: NotificationScreenProps) {
  const locale = useLocale();
  const t = useAccountsMessages();
  const words = useNotificationMessages();
  const list = useListMessages();
  const toast = useToast();
  const { showChanges, openPage } = usePageSwap();
  const query = createMemo(() => recipientsQuery(locale()));
  const [state, setState] = createSignal<RecipientsState>(props.state);
  const [refreshing, setRefreshing] = createSignal(false);
  const [busy, setBusy] = createSignal<"finalize" | "retry" | "delete" | null>(null);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [errorOf, setErrorOf] = createSignal<RecipientRow | null>(null);
  const draft = () => props.batch.status === "draft";
  const number = (value: number) => formatNumber(value, { locale: locale() });
  const statusLabel = () => batchStatusLabel(t(), props.batch.status);
  const fail = (error: unknown) => toast(error instanceof Error ? error.message : String(error), { status: "bad" });

  /** The bar wrote the address; a new filter starts at page 1, and the server shows the recipients for it. */
  const change = (next: RecipientsState) => {
    setState(next);
    setRefreshing(true);
    const params = new URLSearchParams(location.search);
    if (params.has("page")) {
      params.delete("page");
      history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}${location.hash}`);
    }
    void showChanges();
  };

  /** "Review and send": the recipients as they are now, then the second look in the dialog. */
  const review = async () => {
    setBusy("finalize");
    try {
      const res = await apiClient.notifications.batches.preview.$post({ json: { selection: props.batch.selection } });
      if (!res.ok) throw new Error(await readError(res, t().previewRecipientsFailed));
      const next = (await res.json()) as Preview;
      if (next.deliverableCount === 0) throw new Error(t().noDeliverableBatch);
      setPreview(next);
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };
  const retryFailed = async () => {
    setBusy("retry");
    try {
      const res = await apiClient.notifications.batches[":id"]["retry-failed"].$post({ param: { id: props.batch.id } });
      if (!res.ok) throw new Error(await readError(res, t().retryRecipientsFailed));
      toast(words().retriedToast, { status: "ok" });
      void showChanges();
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };
  const deleteDraft = async () => {
    if (!(await Dialog.confirm({ title: t().deleteDraft, description: t().deleteDraftConfirm, confirm: t().deleteDraft }))) return;
    setBusy("delete");
    try {
      const res = await apiClient.notifications.batches[":id"].$delete({ param: { id: props.batch.id } });
      if (!res.ok) throw new Error(await readError(res, t().deleteDraftFailed));
      void openPage(kindHref("notifications"));
    } catch (error) {
      fail(error);
    } finally {
      setBusy(null);
    }
  };
  const retryRecipient = async (row: RecipientRow) => {
    try {
      const res = await apiClient.notifications.batches[":id"].recipients[":userId"].retry.$post({
        param: { id: props.batch.id, userId: row.userId },
      });
      if (!res.ok) throw new Error(await readError(res, t().retryRecipientFailed));
      toast(words().recipientRetriedToast({ name: row.name }), { status: "ok" });
      void showChanges();
    } catch (error) {
      fail(error);
    }
  };

  const primary = () =>
    draft()
      ? { label: t().finalize, icon: "send", onClick: () => void review(), disabled: Boolean(props.blocked) }
      : props.batch.errorCount > 0
        ? { label: t().retryFailed, icon: "refresh", onClick: () => void retryFailed(), disabled: false }
        : undefined;

  return (
    <Workspace
      sidebar={<AccountsNav active="notifications" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={<RecordHead name={props.batch.subject} kinds={[statusLabel()]} />}
          end={
            <>
              <Show when={draft()}>
                <Menu
                  label={words().moreActions}
                  items={[{ label: t().deleteDraft, icon: "trash", danger: true, onClick: () => void deleteDraft() }]}
                />
              </Show>
              <Show when={primary()}>
                {(action) => (
                  <Button
                    variant="primary"
                    icon={action().icon}
                    busy={busy() === "finalize" || busy() === "retry"}
                    disabled={action().disabled}
                    onClick={action().onClick}
                  >
                    {action().label}
                  </Button>
                )}
              </Show>
            </>
          }
        />
      }
      primary={primary()}
    >
      <Pane.Split>
        <Pane
          label={t().recipients}
          scrollKey="accounts-notification-recipients"
          status={
            draft() ? (
              <StatusRow lead={t().recipientsSnapshotted} />
            ) : (
              <>
                <FilterBar
                  query={query()}
                  state={state()}
                  onChange={change}
                  icons={{ status: "circle-check" }}
                  results={t().recipientCount({ count: number(props.total) })}
                />
                <StatusRow
                  lead={props.recipients ? t().recipientCount({ count: number(props.total) }) : words().recipientsFailed}
                  loading={refreshing()}
                  facts={[
                    { value: props.batch.sent, after: t().sent },
                    ...(props.batch.errorCount > 0 ? [{ value: props.batch.errors, after: t().errors }] : []),
                  ]}
                />
              </>
            )
          }
        >
          <Show when={props.blocked}>
            {(reason) => (
              <Notice tone="warn" icon="alert-triangle">
                {reason()}
              </Notice>
            )}
          </Show>
          <Show
            when={!draft()}
            fallback={<Empty icon="send" text={props.audience.legacy ? t().createNewNotificationBatch : t().finalizeDraftForRecipients} />}
          >
            {/* k2b-ui gap: virtualized list (lane MW). Until it lands the server pages the list (at most one page of rows in the DOM). */}
            <Show when={props.recipients} fallback={<Failed text={words().recipientsFailed} onRetry={() => void showChanges()} />}>
              {(rows) => (
                <Table
                  label={t().recipients}
                  rows={rows()}
                  rowKey={(row) => row.userId}
                  sticky
                  // k2b-ui gap: a Menu in a cell of a table with `open` also opens the row; the name links to the user instead
                  empty={
                    state().filters.status
                      ? {
                          icon: "filter-off",
                          text: words().noRecipientMatches,
                          action: {
                            label: list().resetFilters,
                            icon: "filter-off",
                            href: batchHref(query(), props.batch.id, query().reset()),
                          },
                        }
                      : { icon: "users", text: t().noRecipients }
                  }
                  phone={(row) => ({
                    lines: [row.name, row.mail ? `${row.email} · ${row.mail.label}` : row.email],
                    avatar: { name: row.name, image: row.image },
                    time: row.sent,
                    marks: recipientChip(row.status, recipientStatusLabel(t(), row.status)),
                  })}
                  columns={[
                    {
                      title: t().user,
                      width: { min: 160, default: 190 },
                      cell: (row) => ({
                        lines: [
                          <Inline>
                            <Avatar name={row.name} image={row.image} decorative />
                            <Text href={`/app/accounts/users/${row.userId}`}>{row.name}</Text>
                          </Inline>,
                          row.uid,
                        ],
                      }),
                    },
                    {
                      title: t().email,
                      width: { min: 160, default: 190 },
                      cell: (row) => ({ lines: [row.email, row.source] }),
                      drop: true,
                    },
                    {
                      title: t().status,
                      width: { min: 150, default: 160 },
                      cell: (row) => {
                        const chip = recipientChip(row.status, recipientStatusLabel(t(), row.status));
                        return row.mail
                          ? { lines: [chip, row.mail.bad ? <Text tone="bad">{row.mail.label}</Text> : row.mail.label] }
                          : chip;
                      },
                    },
                    {
                      title: t().sent,
                      width: { min: 160, default: 170 },
                      cell: (row) =>
                        row.attempts > 1 ? { lines: [row.sent, words().attempts({ count: number(row.attempts) })] } : row.sent,
                      drop: true,
                    },
                    {
                      title: "",
                      // a failed recipient's deeds: read the delivery error, send it again
                      cell: (row) => (
                        <Show when={row.status === "error"}>
                          <Menu
                            label={words().recipientActions({ name: row.name })}
                            items={[
                              { label: t().deliveryError, icon: "alert-circle", onClick: () => setErrorOf(row) },
                              { label: t().sendAgain, icon: "refresh", onClick: () => retryRecipient(row) },
                            ]}
                          />
                        </Show>
                      ),
                      drop: true,
                    },
                  ]}
                />
              )}
            </Show>
            <Show when={props.pages > 1}>
              <Bar
                start={<Text type="meta">{list().pageOf({ page: props.page, pages: props.pages })}</Text>}
                end={
                  <>
                    <Button
                      icon="chevron-left"
                      href={batchHref(query(), props.batch.id, state(), props.page - 1)}
                      disabled={props.page <= 1}
                    >
                      {list().previous}
                    </Button>
                    <Button href={batchHref(query(), props.batch.id, state(), props.page + 1)} disabled={props.page >= props.pages} forward>
                      {list().next}
                    </Button>
                  </>
                }
              />
            </Show>
          </Show>
        </Pane>
        <Pane side label={words().status} width={{ min: 300, default: 380 }}>
          <Section title={words().status}>
            <Facts
              items={[
                { label: t().status, value: batchChip(props.batch.status, statusLabel()) },
                { label: t().created, value: props.batch.created },
                { label: t().matched, value: props.batch.matched },
                { label: t().deliverable, value: props.batch.deliverable, hint: t().skippedCount({ count: props.batch.skipped }) },
                { label: t().sent, value: props.batch.sent },
                {
                  label: t().errors,
                  value: props.batch.errorCount > 0 ? <Text tone="bad">{props.batch.errors}</Text> : props.batch.errors,
                },
              ]}
            />
          </Section>
          <Section title={t().audience} summary={props.audience.legacy ? t().legacyAudienceDescription : t().explicitAudienceDescription}>
            <Show
              when={!props.audience.legacy}
              fallback={props.audience.rules.map((rule) => <Row icon={rule.icon} lines={[rule.label]} />)}
            >
              <Show when={props.audience.users.length > 0} fallback={<Row icon="user" lines={[t().noSelectedUsers]} />}>
                {props.audience.users.map((user) => (
                  <Row
                    avatar={{ name: user.name, image: user.image }}
                    lines={[user.name, user.uid]}
                    href={`/app/accounts/users/${user.id}`}
                  />
                ))}
              </Show>
              <Show when={props.audience.moreUsers}>{(more) => <Row icon="dots" lines={[more()]} />}</Show>
            </Show>
            <Show when={props.audience.groups.length > 0} fallback={<Row icon="users-group" lines={[t().noSelectedGroups]} />}>
              {props.audience.groups.map((group) => (
                <Row icon="users-group" lines={[group.name]} href={`/app/accounts/groups/${group.id}`} />
              ))}
            </Show>
            <Show when={props.audience.moreGroups}>{(more) => <Row icon="dots" lines={[more()]} />}</Show>
          </Section>
          <Section title={t().messagePreview}>
            <Prose markdown={props.batch.bodyMarkdown} />
          </Section>
        </Pane>
      </Pane.Split>
      <Dialog
        title={t().deliveryError}
        open={errorOf() !== null}
        onOpenChange={(open) => {
          if (!open) setErrorOf(null);
        }}
        foot={<Button onClick={() => setErrorOf(null)}>{t().close}</Button>}
      >
        <Text>{t().deliveryErrorDescription}</Text>
        <Facts
          items={[
            { label: t().user, value: errorOf()?.name ?? "" },
            {
              label: t().error,
              value: errorOf()?.error || t().noDeliveryError,
              mono: Boolean(errorOf()?.error),
              copy: errorOf()?.error ?? undefined,
            },
          ]}
        />
      </Dialog>
      <Show when={preview()}>
        {(current) => (
          <FinalizeDialog
            batch={props.batch}
            preview={current()}
            close={(sent) => {
              setPreview(null);
              if (sent) {
                toast(words().sentToast, { status: "ok" });
                void showChanges();
              }
            }}
          />
        )}
      </Show>
    </Workspace>
  );
}

/** The second look before a batch is sent: how many get it and how many are skipped, confirmed with a tick. */
function FinalizeDialog(props: { batch: BatchView; preview: Preview; close: (sent: boolean) => void }) {
  const t = useAccountsMessages();
  const locale = useLocale();
  const [confirmed, setConfirmed] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const send = async () => {
    if (!confirmed() || sending()) return;
    setSending(true);
    setError(null);
    try {
      const res = await apiClient.notifications.batches[":id"].finalize.$post({
        param: { id: props.batch.id },
        json: {
          expectedSelectionHash: props.batch.selectionHash,
          expectedDeliverableCount: props.preview.deliverableCount,
          expectedRecipientHash: props.preview.recipientHash,
        },
      });
      if (!res.ok) throw new Error(await readError(res, t().finalizeBatchFailed));
      props.close(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };
  return (
    <Dialog
      title={t().finalizeNotificationBatch}
      open
      onOpenChange={(open) => {
        if (!open && !sending()) props.close(false);
      }}
      foot={
        <>
          <Button onClick={() => props.close(false)} disabled={sending()}>
            {t().cancel}
          </Button>
          <Button variant="primary" icon="send" busy={sending()} disabled={!confirmed()} onClick={() => void send()}>
            {t().finalizeAndSend}
          </Button>
        </>
      }
    >
      <Notice tone="warn" icon="alert-triangle">
        {t().deliveryWarning({
          deliverable: formatNumber(props.preview.deliverableCount, { locale: locale() }),
          skipped: formatNumber(props.preview.skippedNoEmailCount, { locale: locale() }),
        })}
      </Notice>
      <Check name="confirm" label={t().confirmRecipients} checked={confirmed()} onChange={setConfirmed} />
      <Text type="meta">{t().finalizeDescription}</Text>
      <Show when={error()}>
        {(message) => (
          <Notice tone="bad" icon="alert-circle">
            {message()}
          </Notice>
        )}
      </Show>
    </Dialog>
  );
}
