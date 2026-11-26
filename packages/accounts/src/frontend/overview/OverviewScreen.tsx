import { useLocale } from "@k2b/ui";
import { Bar, Button, Cells, Chip, Digest, Menu, Pane, Row, Section, Tabs, Text, Workspace } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { type AccountsMessages, useAccountsMessages } from "../messages";
import { type OverviewMessages, useOverviewMessages } from "./messages";

/** A log page the overview links to; `label` names a word of the Accounts catalog. */
export type OverviewLogLink = {
  href: string;
  label: "syncLogs" | "ipaBackfill" | "localUserBackfill" | "guestBackfill" | "reminderRuns" | "deletedAccounts" | "reminderHistory";
};

/** One line of the lifecycle log: the run that wrote it (`source`), its level and words, and when, formatted. */
export type OverviewActivity = { id: string; level: string; source: string; message: string; time: string };

export type OverviewRun = { run: "ipaSync" | "ipaDemotion" | "reminders"; runs: number; failed: number };

/** What only administrators see: what waits today, the account runs and the recent lifecycle activity. */
export type OverviewAdmin = {
  accounts: { total: number; freeIpa: number; local: number };
  openRequests: number;
  expiring: { freeIpa: number; local: number; guests: number };
  /** When the last FreeIPA sync ran, relative to the page's time; null when none ran yet. */
  lastSync: string | null;
  health: OverviewRun[];
  window: number;
  activity: OverviewActivity[];
  logs: OverviewLogLink[];
};

/** A group of the person: theirs to manage, or one they belong to. */
export type OverviewGroup = {
  id: string;
  name: string;
  description: string | null;
  provider: "ipa" | "local";
  managed: boolean;
  href: string;
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
  /** The person's own groups, the managed ones first, at most a handful. */
  myGroups: OverviewGroup[];
  isAdmin: boolean;
  admin: OverviewAdmin | null;
  pendingRequests: number;
};

/** Each kind of thing has one colour, the same in a row's mark, a cell and a sentence. */
const kind = {
  request: { icon: "user-plus", color: "#c2410c" },
  expiry: { icon: "calendar-due", color: "#b45309" },
  sync: { icon: "refresh", color: "#7c3aed" },
  demotion: { icon: "user-down", color: "#be185d" },
  reminder: { icon: "bell", color: "#0f766e" },
  backfill: { icon: "database-import", color: "#2563eb" },
  account: { icon: "users", color: "#4f46e5" },
  ipaGroup: { icon: "users-group", color: "#7c3aed" },
  localGroup: { icon: "users-group", color: "#2563eb" },
};

const runKind = { ipaSync: kind.sync, ipaDemotion: kind.demotion, reminders: kind.reminder } as const;

/** The run a log line comes from: its name and its colour, as it stands in a sentence. */
const sourceOf = (t: AccountsMessages, source: string) =>
  source === "auth:ipa:sync"
    ? { name: t.ipaSync, ...kind.sync }
    : source === "auth:ipa:backfill"
      ? { name: t.ipaBackfill, ...kind.backfill }
      : source === "auth:local-user:backfill"
        ? { name: t.localUserBackfill, ...kind.backfill }
        : source === "auth:guest:backfill"
          ? { name: t.guestBackfill, ...kind.backfill }
          : source === "auth:reminder:daily"
            ? { name: t.reminders, ...kind.reminder }
            : { name: source, icon: "terminal-2", color: "#475569" };

const initials = (name: string) =>
  name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");

const levelChip = (o: OverviewMessages, level: string) =>
  level === "error" ? (
    <Chip status="bad" icon="alert-triangle">
      {o.levelError}
    </Chip>
  ) : level === "warn" ? (
    <Chip status="warn">{o.levelWarn}</Chip>
  ) : undefined;

/**
 * The Accounts overview on v2: the first row says what waits today, then who I am here and my groups, and for
 * administrators the account runs and, beside them, what the runs did.
 */
export default function OverviewScreen(props: OverviewScreenProps) {
  const t = useAccountsMessages();
  const o = useOverviewMessages();
  const locale = useLocale();
  const number = (value: number) => new Intl.NumberFormat(locale()).format(value);
  const me = () => ({ name: props.me.name, image: props.me.image });
  const kindWord = () => (props.me.profile === "user" ? t().fullAccount : t().guestAccount);
  const providerWord = () => (props.me.provider === "ipa" ? "FreeIPA" : t().local);
  const runLabel = (run: OverviewRun["run"]) => (run === "ipaSync" ? t().ipaSync : run === "ipaDemotion" ? t().ipaDemotion : t().reminders);
  const expiryChip = () =>
    props.me.expired ? (
      <Chip status="bad" icon="alert-triangle">
        {o().expiredOn({ when: props.me.expires ?? "" })}
      </Chip>
    ) : props.me.expires ? (
      <Chip>{o().expiresOn({ when: props.me.expires })}</Chip>
    ) : (
      <Chip status="ok">{o().noExpiry}</Chip>
    );
  /** The names of a few groups, as a quiet line under their count. */
  const names = (groups: OverviewGroup[]) =>
    groups
      .slice(0, 3)
      .map((group) => group.name)
      .join(", ");
  const groupWords = (group: OverviewGroup) =>
    [group.provider === "ipa" ? "FreeIPA" : t().local, group.description].filter(Boolean).join(" · ");

  return (
    <Workspace
      sidebar={<AccountsNav active="dashboard" pendingRequests={props.pendingRequests} isAdmin={props.isAdmin} />}
      head={
        <Bar
          start={
            <Tabs
              label={o().views}
              items={[
                { label: t().dashboard, current: true },
                props.isAdmin
                  ? { label: o().activity, href: "/app/accounts/activity" }
                  : { label: t().myGroups, count: props.groups.member.count, href: props.groups.member.href },
              ]}
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
              <Button avatar={me()} href="/me">
                {t().profilePage}
              </Button>
              <Show when={props.isAdmin}>
                <Button variant="primary" icon="user-plus" href="/app/accounts/users/new">
                  {t().newUser}
                </Button>
              </Show>
            </>
          }
        />
      }
      primary={props.isAdmin ? { label: t().newUser, icon: "user-plus", href: "/app/accounts/users/new" } : undefined}
    >
      <Pane label={t().dashboard} scrollKey="accounts-dashboard">
        <Show
          when={props.admin}
          fallback={
            <Cells>
              <Cells.Cell
                icon="id-badge-2"
                color={kind.account.color}
                label={o().yourAccount}
                value={props.me.expired ? <Chip status="bad">{t().expired}</Chip> : <Chip status="ok">{o().active}</Chip>}
                meta={
                  props.me.expires
                    ? props.me.expired
                      ? o().expiredOn({ when: props.me.expires })
                      : o().expiresOn({ when: props.me.expires })
                    : o().noExpiry
                }
                href="/me"
              />
              <Cells.Cell
                icon="shield"
                color={kind.ipaGroup.color}
                label={t().managedByMe}
                value={number(props.groups.managed.count)}
                meta={names(props.myGroups.filter((group) => group.managed)) || t().groupCount({ count: props.groups.managed.count })}
                href={props.groups.managed.href}
              />
              <Cells.Cell
                icon="users-group"
                color={kind.localGroup.color}
                label={t().myGroups}
                value={number(props.groups.member.count)}
                meta={names(props.myGroups.filter((group) => !group.managed)) || t().groupCount({ count: props.groups.member.count })}
                href={props.groups.member.href}
              />
              <Cells.Cell icon="layout-grid" label={t().allGroups} value={number(props.groups.all.count)} href={props.groups.all.href} />
            </Cells>
          }
        >
          {(admin) => {
            const expiring = () => admin().expiring.freeIpa + admin().expiring.local + admin().expiring.guests;
            const sync = () => admin().health.find((row) => row.run === "ipaSync");
            const reminders = () => admin().health.find((row) => row.run === "reminders");
            return (
              <Cells>
                <Cells.Cell
                  icon={kind.request.icon}
                  color={kind.request.color}
                  label={t().requests}
                  value={
                    admin().openRequests > 0 ? (
                      <Chip status="warn">{o().waiting({ count: admin().openRequests, text: number(admin().openRequests) })}</Chip>
                    ) : (
                      <Chip status="ok">{o().noneWaiting}</Chip>
                    )
                  }
                  meta={admin().openRequests > 0 ? t().pendingReview : t().nonePending}
                  href="/app/accounts/requests"
                />
                <Cells.Cell
                  icon={kind.expiry.icon}
                  color={kind.expiry.color}
                  label={t().expiring30d}
                  value={expiring() > 0 ? <Chip status="warn">{o().accounts({ count: expiring(), text: number(expiring()) })}</Chip> : 0}
                  meta={
                    expiring() > 0
                      ? o().expiringSplit({
                          freeIpa: number(admin().expiring.freeIpa),
                          local: number(admin().expiring.local),
                          guests: number(admin().expiring.guests),
                        })
                      : t().noneSoon
                  }
                />
                <Show
                  when={sync()}
                  fallback={
                    <Show when={reminders()}>
                      {(run) => (
                        <Cells.Cell
                          icon={kind.reminder.icon}
                          color={kind.reminder.color}
                          label={t().reminders}
                          value={
                            run().failed > 0 ? (
                              <Chip status="bad">{o().errors({ count: run().failed })}</Chip>
                            ) : (
                              <Chip status="ok">{o().noErrors}</Chip>
                            )
                          }
                          meta={o().runsOk({ ok: run().runs - run().failed, runs: run().runs })}
                        />
                      )}
                    </Show>
                  }
                >
                  {(run) => (
                    <Cells.Cell
                      icon={kind.sync.icon}
                      color={kind.sync.color}
                      label="FreeIPA"
                      value={
                        admin().lastSync === null ? (
                          <Chip status="warn">{t().noSyncYet}</Chip>
                        ) : run().failed > 0 ? (
                          <Chip status="warn">{o().errors({ count: run().failed })}</Chip>
                        ) : (
                          <Chip status="ok">{o().synced}</Chip>
                        )
                      }
                      meta={[admin().lastSync, o().runsOk({ ok: run().runs - run().failed, runs: run().runs })].filter(Boolean).join(" · ")}
                    />
                  )}
                </Show>
                <Cells.Cell
                  icon={kind.account.icon}
                  color={kind.account.color}
                  label={t().accountTotalLabel}
                  value={number(admin().accounts.total)}
                  meta={o().sourceCounts({ freeIpa: number(admin().accounts.freeIpa), local: number(admin().accounts.local) })}
                  href="/app/accounts/users"
                />
              </Cells>
            );
          }}
        </Show>
        <Pane.Split>
          <Pane label={t().dashboard}>
            <Section title={o().yourAccount}>
              <Row
                strong
                avatar={me()}
                lines={[
                  props.me.name,
                  `${props.me.uid} · ${kindWord()} · ${providerWord()} · ${props.me.provider === "ipa" ? t().freeIpaPassword : t().magicLink}`,
                ]}
                // without the administration's figures, the first row already says when the account expires
                marks={props.admin ? expiryChip() : undefined}
                href="/me"
              />
            </Section>
            <Section
              title={o().yourGroups}
              count={number(props.groups.member.count)}
              more={{ label: t().allGroups, href: props.groups.all.href, forward: true }}
            >
              <Show when={props.myGroups.length > 0} fallback={<Text muted>{o().noGroups}</Text>}>
                <For each={props.myGroups}>
                  {(group) => (
                    <Row
                      strong
                      mark={group.provider === "ipa" ? kind.ipaGroup : kind.localGroup}
                      lines={[group.name, groupWords(group)]}
                      marks={group.managed ? <Chip yours>{o().youManage}</Chip> : undefined}
                      href={group.href}
                    />
                  )}
                </For>
              </Show>
            </Section>
            <Show when={props.admin}>
              {(admin) => (
                <Section
                  title={t().runHealth}
                  count={admin().health.length}
                  actions={[
                    { label: t().operations, icon: "tool", href: "/admin/signin/operations" },
                    { label: t().settings, icon: "settings", href: "/admin/signin" },
                  ]}
                >
                  <For each={admin().health}>
                    {(row) => {
                      const ok = row.runs - row.failed;
                      return (
                        <Row
                          strong
                          mark={runKind[row.run]}
                          lines={[runLabel(row.run), o().runsOk({ ok, runs: row.runs })]}
                          marks={
                            row.failed > 0 ? (
                              <Chip status="bad" icon="alert-triangle">
                                {o().failedRuns({ count: row.failed })}
                              </Chip>
                            ) : (
                              <Chip status="ok" icon="circle-check">
                                {o().noErrors}
                              </Chip>
                            )
                          }
                        />
                      );
                    }}
                  </For>
                </Section>
              )}
            </Show>
          </Pane>
          <Show when={props.admin}>
            {(admin) => (
              <Pane side label={o().activity} width={{ min: 300, default: 380 }}>
                <Section
                  title={o().activity}
                  count={admin().activity.length}
                  more={{ label: t().auditLog, href: "/app/accounts/activity", forward: true }}
                >
                  <Show when={admin().activity.length > 0} fallback={<Text muted>{t().noLifecycleActivity}</Text>}>
                    <Digest
                      label={o().activity}
                      activity={admin().activity.map((entry) => {
                        const run = sourceOf(t(), entry.source);
                        return {
                          person: { name: run.name, initials: initials(run.name), color: run.color },
                          text: (
                            <>
                              <Text weight="strong">{run.name}</Text>: {entry.message} {levelChip(o(), entry.level)}
                            </>
                          ),
                          time: entry.time,
                        };
                      })}
                    />
                  </Show>
                </Section>
              </Pane>
            )}
          </Show>
        </Pane.Split>
      </Pane>
    </Workspace>
  );
}
