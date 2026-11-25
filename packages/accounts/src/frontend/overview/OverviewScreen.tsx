import { useLocale } from "@k2b/ui";
import { Bar, Button, Cells, Chip, Facts, Menu, Notice, Pane, Progress, RecordHead, Section, Table, Text, Workspace } from "@k2b/ui/v2";
import { Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { useAccountsMessages } from "../messages";
import { useOverviewMessages } from "./messages";

/** A log page the overview links to; `label` names a word of the Accounts catalog. */
export type OverviewLogLink = {
  href: string;
  label: "syncLogs" | "ipaBackfill" | "localUserBackfill" | "guestBackfill" | "reminderRuns" | "deletedAccounts" | "reminderHistory";
};

export type OverviewActivity = { id: string; level: string; source: string; message: string; time: string };

/** What only administrators see: the health of the account runs, key figures and the recent lifecycle activity. */
export type OverviewAdmin = {
  accounts: { total: number; freeIpa: number; local: number };
  groups: { total: number; freeIpa: number; local: number };
  openRequests: number;
  expiring: number;
  /** When the last FreeIPA sync ran, relative to the page's time; null when none ran yet. */
  lastSync: string | null;
  health: { run: "ipaSync" | "ipaDemotion" | "reminders"; runs: number; failed: number }[];
  window: number;
  activity: OverviewActivity[];
  logs: OverviewLogLink[];
};

export type OverviewScreenProps = {
  me: {
    name: string;
    uid: string;
    image?: string;
    profile: "user" | "guest";
    provider: "ipa" | "local";
    /** The expiry date, formatted by the server; null when the account never expires. */
    expires: string | null;
    expired: boolean;
  };
  groups: Record<"managed" | "member" | "all", { count: number; href: string }>;
  isAdmin: boolean;
  admin: OverviewAdmin | null;
  pendingRequests: number;
};

const levelStatus = (level: string) => (level === "error" ? "bad" : level === "warn" ? "warn" : undefined);

/** The Accounts overview on v2: who I am here, my groups, and for administrators the state of the account runs. */
export default function OverviewScreen(props: OverviewScreenProps) {
  const t = useAccountsMessages();
  const o = useOverviewMessages();
  const locale = useLocale();
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const levelLabel = (level: string) =>
    level === "error" ? o().levelError : level === "warn" ? o().levelWarn : level === "debug" ? o().levelDebug : o().levelInfo;
  const runLabel = (run: OverviewAdmin["health"][number]["run"]) =>
    run === "ipaSync" ? t().ipaSync : run === "ipaDemotion" ? t().ipaDemotion : t().reminders;
  return (
    <Workspace
      sidebar={<AccountsNav active="dashboard" pendingRequests={props.pendingRequests} isAdmin={props.isAdmin} />}
      head={
        <Bar
          start={
            <RecordHead
              name={props.me.name}
              avatar={{ name: props.me.name, image: props.me.image }}
              kinds={[
                props.me.profile === "user" ? t().fullAccount : t().guestAccount,
                props.me.provider === "ipa" ? "FreeIPA" : t().local,
              ]}
              ids={[{ label: "UID", value: props.me.uid }]}
            />
          }
          end={
            <>
              <Show when={props.admin}>
                {(admin) => (
                  <Menu icon="file-text" items={admin().logs.map((link) => ({ label: t()[link.label], href: link.href }))}>
                    {o().logs}
                  </Menu>
                )}
              </Show>
              <Button icon="user" href="/me">
                {t().profilePage}
              </Button>
            </>
          }
        />
      }
    >
      <Pane label={t().dashboard} scrollKey="accounts-dashboard">
        <Section icon="id-badge-2" title={o().yourAccount}>
          <Facts
            items={[
              { label: t().access, value: props.me.profile === "user" ? t().fullAccount : t().guestAccount },
              { label: t().managedBy, value: props.me.provider === "ipa" ? "FreeIPA" : t().local },
              { label: t().login, value: props.me.provider === "ipa" ? t().freeIpaPassword : t().magicLink },
              {
                label: t().expires,
                value: props.me.expired ? (
                  <Chip status="bad">{o().expiredOn({ when: props.me.expires ?? "" })}</Chip>
                ) : (
                  (props.me.expires ?? t().never)
                ),
              },
            ]}
          />
        </Section>
        {/* the cells stand under their section's head, not inside it: the section's one line then separates them */}
        <Section icon="users-group" title={t().groups} />
        <Cells>
          <Cells.Cell
            icon="shield"
            label={t().managedByMe}
            value={t().groupCount({ count: props.groups.managed.count })}
            href={props.groups.managed.href}
          />
          <Cells.Cell
            icon="users-group"
            label={t().myGroups}
            value={t().groupCount({ count: props.groups.member.count })}
            href={props.groups.member.href}
          />
          <Cells.Cell
            icon="layout-grid"
            label={t().allGroups}
            value={t().groupCount({ count: props.groups.all.count })}
            href={props.groups.all.href}
          />
        </Cells>
        <Show when={props.admin}>
          {(admin) => (
            <>
              <Section
                icon="shield-lock"
                title={t().administration}
                summary={t().administrationDescription}
                actions={[
                  { label: t().operations, icon: "tool", href: "/admin/signin/operations" },
                  { label: t().settings, icon: "settings", href: "/admin/signin" },
                ]}
              />
              <Cells>
                <Cells.Cell
                  icon="users"
                  label={t().accountTotalLabel}
                  value={number(admin().accounts.total)}
                  meta={o().sourceCounts({ freeIpa: number(admin().accounts.freeIpa), local: number(admin().accounts.local) })}
                  href="/app/accounts/users"
                />
                <Cells.Cell
                  icon="users-group"
                  label={t().groups}
                  value={number(admin().groups.total)}
                  meta={o().sourceCounts({ freeIpa: number(admin().groups.freeIpa), local: number(admin().groups.local) })}
                  href={props.groups.all.href}
                />
                <Cells.Cell
                  icon="user-plus"
                  label={t().requests}
                  value={admin().openRequests > 0 ? <Chip status="warn">{number(admin().openRequests)}</Chip> : 0}
                  meta={admin().openRequests > 0 ? t().pendingReview : t().nonePending}
                  href={admin().openRequests > 0 ? "/app/accounts/requests" : undefined}
                />
                <Cells.Cell
                  icon="calendar-due"
                  label={t().expiring30d}
                  value={admin().expiring > 0 ? <Chip status="warn">{number(admin().expiring)}</Chip> : 0}
                  meta={admin().expiring > 0 ? undefined : t().noneSoon}
                />
              </Cells>
              <Section icon="heart-rate-monitor" title={t().runHealth} summary={t().basedOnRuns({ count: admin().window })}>
                <Facts
                  items={[
                    ...(admin().health.some((row) => row.run === "ipaSync")
                      ? [
                          {
                            label: o().lastSync,
                            value: (
                              <Show when={admin().lastSync} fallback={<Text muted>{t().noSyncYet}</Text>}>
                                {(when) => <Chip status="ok">{t().synced({ value: when() })}</Chip>}
                              </Show>
                            ),
                          },
                        ]
                      : []),
                    ...admin().health.map((row) => {
                      const rate = row.runs > 0 ? Math.round(((row.runs - row.failed) / row.runs) * 100) : 100;
                      return {
                        label: runLabel(row.run),
                        value: <Progress value={rate} of={100} label={o().runRate({ rate })} />,
                        hint: row.failed > 0 ? o().failedRuns({ count: row.failed }) : undefined,
                      };
                    }),
                  ]}
                />
              </Section>
              <Notice
                tone="note"
                icon="clipboard-list"
                title={t().auditNotice}
                actions={[{ label: t().auditLog, href: "/app/accounts/activity" }]}
              >
                {t().auditNoticeDescription}
              </Notice>
              <Section icon="history" title={t().recentActivity} count={admin().activity.length}>
                <Table
                  label={t().recentActivity}
                  rows={admin().activity}
                  rowKey={(entry) => entry.id}
                  empty={{ icon: "history", text: t().noLifecycleActivity }}
                  phone={(entry) => ({ lines: [entry.message, entry.source], time: entry.time })}
                  columns={[
                    { title: t().time, width: { min: 150, default: 170 }, cell: (entry) => entry.time },
                    {
                      title: o().level,
                      width: { min: 90, default: 100 },
                      cell: (entry) => {
                        const status = levelStatus(entry.level);
                        return status ? <Chip status={status}>{levelLabel(entry.level)}</Chip> : levelLabel(entry.level);
                      },
                      drop: true,
                    },
                    { title: o().source, width: { min: 160, default: 220 }, cell: (entry) => entry.source, drop: true },
                    { title: t().message, cell: (entry) => entry.message },
                  ]}
                />
              </Section>
            </>
          )}
        </Show>
      </Pane>
    </Workspace>
  );
}
