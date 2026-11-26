/**
 * The activity screens for the browser test, built from the invented samples as the server would build them for the
 * page's address: each kind's declaration reads the address and the sample is filtered like its service does. `worst`
 * swaps the samples for worst-case data (very long names, subjects and errors); `huge` stands for a list of thousands
 * of entries, of which the server sends one full page, as it does.
 */
import { formatNumber } from "@k2b/cloud/shared";
import { dates } from "@k2b/stdlib";
import AuditScreen from "../audit/AuditScreen";
import { auditQuery, parseAuditAddress } from "../audit/query";
import { AUDIT_EVENTS, denseAuditEvents } from "../audit/render-fixture";
import { auditRows } from "../audit/rows";
import DeletedAccountsScreen from "../deleted-accounts/DeletedAccountsScreen";
import { deletedQuery, parseDeletedAddress } from "../deleted-accounts/query";
import { accountsMessages } from "../messages";
import NotificationScreen from "../notifications/NotificationScreen";
import NotificationsScreen from "../notifications/NotificationsScreen";
import { batchesQuery, parseListAddress, recipientsQuery } from "../notifications/query";
import { BATCH_ID, batch, recipient } from "../notifications/render-fixture";
import { parseRemindersAddress, remindersQuery } from "../reminders/query";
import RemindersScreen from "../reminders/RemindersScreen";
import { activityKindOf, BATCH_PATH } from "./kind";
import { DELETED, REMINDERS } from "./render-fixture";

const locale = "de";
const timeZone = "Europe/Berlin";
const { t } = accountsMessages.resolve([locale]);
const number = (value: number) => formatNumber(value, { locale });
const when = (iso: string) => dates.formatDateTime(iso, { locale, timeZone });

const LONG = "Außerordentliche Mitgliederversammlung des Fördervereins Werkstattgemeinschaft Solberg-Kramer am Donnerstag";
const UNBROKEN = "verylongunbrokenidentifier_without_any_space_0123456789abcdefghijklmnopqrstuvwxyz@solberg-kramer-werkstatt.example";

const worstEvents = (length = 24) =>
  Array.from({ length }, (_, index) => ({
    ...AUDIT_EVENTS[index % AUDIT_EVENTS.length]!,
    id: 100 + index,
    actor: { userId: null, uid: index % 2 ? UNBROKEN : "ü", provider: "local", roles: [] },
    target: { type: "group", id: `g-${index}`, label: LONG, provider: "ipa" },
    reason: index % 3 ? `${LONG}: ${UNBROKEN}` : null,
  }));

/** The page's clock: the samples' "today" is 20 Nov 2026. */
const NOW = new Date("2026-11-20T15:30:00.000Z");

export const AuditFixture = (props: { worst?: boolean; huge?: boolean }) => {
  const query = auditQuery(locale);
  const address = parseAuditAddress(query, new URLSearchParams(location.search));
  const outcome = address.state.filters.outcome;
  const events = (props.huge ? denseAuditEvents(NOW, 100) : props.worst ? worstEvents() : denseAuditEvents(NOW)).filter(
    (event) => !outcome || event.outcome === outcome,
  );
  return (
    <AuditScreen
      state={address.state}
      page={1}
      pages={props.huge ? 125 : props.worst ? 3 : 1}
      total={props.huge ? 12_480 : props.worst ? 2_480 : events.length}
      rows={auditRows(events, { t, locale, timeZone, names: [], now: NOW, today: "Heute", yesterday: "Gestern" })}
      names={{ actor: [], target: [], serviceAccountId: [], action: [] }}
      automatic={{ shown: address.automatic, hidden: 32, href: `${location.pathname}?automatic=yes` }}
      ignored={null}
      pendingRequests={2}
    />
  );
};

const batchRows = (worst: boolean, length = 18) =>
  (worst
    ? Array.from({ length }, (_, index) => batch(index, { subject: `${LONG} ${index + 1}`, lastError: index % 2 ? UNBROKEN : null }))
    : Array.from({ length: 12 }, (_, index) => batch(index))
  ).map((entry) => ({
    id: entry.id,
    subject: entry.subject,
    note: entry.lastError ?? t.emailBatch,
    status: entry.status,
    recipients: t.deliverableRatio({ deliverable: number(entry.deliverableCount), total: number(entry.targetCount) }),
    sent: number(entry.sentCount),
    sentCount: entry.sentCount,
    deliverableCount: entry.deliverableCount,
    deliverable: number(entry.deliverableCount),
    errors: number(entry.errorCount),
    hasErrors: entry.errorCount > 0,
    created: when(entry.createdAt),
  }));

export const NotificationsFixture = (props: { worst?: boolean; huge?: boolean }) => {
  const params = new URLSearchParams(location.search);
  const address = parseListAddress(batchesQuery(locale), params);
  const status = address.state.filters.status;
  const rows = batchRows(Boolean(props.worst || props.huge), props.huge ? 50 : 18).filter((row) => !status || row.status === status);
  return (
    <NotificationsScreen
      state={address.state}
      page={1}
      pages={props.huge ? 40 : 1}
      total={props.huge ? 2_000 : rows.length}
      rows={rows}
      creating={params.get("new") === "1"}
      ignored={null}
      pendingRequests={2}
    />
  );
};

export const NotificationFixture = (props: { status?: "draft" | "running" | "completed_with_errors"; worst?: boolean; huge?: boolean }) => {
  const address = parseListAddress(recipientsQuery(locale), new URLSearchParams(location.search));
  const status = props.status ?? "completed_with_errors";
  const filter = address.state.filters.status;
  const source =
    props.worst || props.huge
      ? Array.from({ length: props.huge ? 100 : 30 }, (_, index) =>
          recipient(index, index % 4 === 0 ? "error" : "sent", index % 4 === 0 ? "failed" : "sent", {
            displayName: `${LONG} ${index}`,
            recipient: UNBROKEN,
            error: `${UNBROKEN} ${LONG}`,
          }),
        )
      : Array.from({ length: 24 }, (_, index) => {
          const status = (["sent", "sent", "sent", "error", "sent", "pending", "sent", "skipped"] as const)[index % 8]!;
          return recipient(
            index,
            status,
            status === "sent" ? (index % 5 === 0 ? "bounced" : "sent") : status === "error" ? "failed" : null,
          );
        });
  const recipients = source.filter((entry) => !filter || entry.status === filter);
  const current = batch(0, { status, subject: props.worst ? LONG : "Wartungsfenster heute Nacht", errorCount: status === "draft" ? 0 : 2 });
  return (
    <NotificationScreen
      batch={{
        id: BATCH_ID,
        subject: current.subject,
        status,
        created: when(current.createdAt),
        matched: number(current.targetCount),
        deliverable: number(current.deliverableCount),
        skipped: number(current.skippedCount),
        sent: number(current.sentCount),
        sentCount: current.sentCount,
        deliverableCount: current.deliverableCount,
        errors: number(current.errorCount),
        errorCount: current.errorCount,
        selection: { userIds: ["33333333-3333-4333-8333-000000000100"], groupIds: ["33333333-3333-4333-8333-000000000001"] },
        selectionHash: current.selectionHash,
        bodyMarkdown: current.bodyMarkdown,
      }}
      audience={{
        legacy: false,
        users: [{ id: "33333333-3333-4333-8333-000000000100", name: props.worst ? LONG : "Milan Horvat", uid: "milan.horvat" }],
        groups: [{ id: "33333333-3333-4333-8333-000000000001", name: props.worst ? UNBROKEN : "Verkauf" }],
        moreUsers: props.worst ? t.moreCount({ count: number(1240) }) : null,
        moreGroups: null,
        rules: [],
      }}
      state={address.state}
      page={1}
      pages={props.huge ? 50 : props.worst ? 4 : 1}
      total={props.huge ? 5_000 : recipients.length}
      recipients={
        status === "draft"
          ? []
          : recipients.map((entry) => ({
              userId: entry.userId,
              name: entry.displayName,
              uid: entry.uid,
              email: entry.recipient ?? "–",
              source: `${entry.provider === "ipa" ? "FreeIPA" : t.local} · ${t.user}`,
              status: entry.status,
              mail:
                entry.outgoingMailStatus && entry.outgoingMailStatus !== "sent"
                  ? {
                      label: t.outgoingMailStatus({ status: entry.outgoingMailStatus === "bounced" ? t.bounced : t.queued }),
                      bad: entry.outgoingMailStatus !== "queued",
                    }
                  : null,
              attempts: entry.attemptCount,
              sent: entry.sentAt ? when(entry.sentAt) : "–",
              error: entry.error,
            }))
      }
      blocked={null}
      pendingRequests={2}
    />
  );
};

export const RemindersFixture = () => {
  const address = parseRemindersAddress(remindersQuery(locale), new URLSearchParams(location.search));
  const status = address.state.filters.status;
  const rows = REMINDERS.filter((entry) => !status || entry.status === status).map((entry) => ({
    id: entry.id,
    name: entry.displayName || entry.uid || null,
    status: entry.status,
    target: when(entry.targetExpiryAt),
    days: entry.thresholdDays,
    attempts: entry.attemptCount,
    lastAttempt: entry.lastAttemptAt ? when(entry.lastAttemptAt) : null,
    error: entry.lastError || null,
  }));
  return <RemindersScreen state={address.state} page={1} pages={1} total={rows.length} rows={rows} ignored={null} pendingRequests={2} />;
};

export const DeletedFixture = () => {
  const address = parseDeletedAddress(deletedQuery(locale), new URLSearchParams(location.search));
  const rows = DELETED.map((entry) => ({
    id: entry.id,
    name: entry.displayName,
    uid: entry.uid,
    mail: entry.mail,
    provider: entry.previousProvider,
    profile: entry.previousProfile,
    reason: entry.reason,
    deleted: when(entry.deletedAt),
  }));
  const index = rows.findIndex((row) => row.id === address.entry);
  const open =
    index >= 0
      ? {
          ...rows[index]!,
          meta: Object.entries(DELETED[index]!.meta).map(([key, value]) => ({ key, value: value === null ? "–" : String(value) })),
        }
      : null;
  return (
    <DeletedAccountsScreen
      state={address.state}
      page={1}
      pages={1}
      total={rows.length}
      rows={rows}
      entry={address.entry}
      open={open}
      ignored={null}
      pendingRequests={2}
    />
  );
};

/** The screen of the address: a batch's record, or the activity list of the kind the address names. */
export const ActivityFixture = (props: { worst?: boolean; huge?: boolean; status?: "draft" | "running" | "completed_with_errors" }) => {
  if (location.pathname.startsWith(`${BATCH_PATH}/`))
    return <NotificationFixture status={props.status} worst={props.worst} huge={props.huge} />;
  const kind = activityKindOf(new URLSearchParams(location.search));
  return kind === "audit" ? (
    <AuditFixture worst={props.worst} huge={props.huge} />
  ) : kind === "notifications" ? (
    <NotificationsFixture worst={props.worst} huge={props.huge} />
  ) : kind === "reminders" ? (
    <RemindersFixture />
  ) : (
    <DeletedFixture />
  );
};
