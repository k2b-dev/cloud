import { useLocale } from "@k2b/ui";
import { Bar, Button, Cells, Chip, Digest, Mark, Menu, Pane, Row, Section, Tabs, Text, Workspace } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import AccountsNav from "../AccountsNav";
import { type AuditRow, targetMark } from "../audit/rows";
import { useAccountsMessages } from "../messages";
import { useOverviewMessages } from "./messages";

/** A log page the overview links to; `label` names a word of the Accounts catalog. */
export type OverviewLogLink = {
  href: string;
  label: "syncLogs" | "ipaBackfill" | "localUserBackfill" | "guestBackfill" | "reminderRuns" | "deletedAccounts" | "reminderHistory";
};

/** One change of the audit log as the overview tells it: worded and dated by the server (`audit/rows.ts`). */
export type OverviewActivity = AuditRow;

export type OverviewRun = { run: "ipaSync" | "ipaDemotion" | "reminders"; runs: number; failed: number };

/** What waits today, the account runs and the newest changes of the audit log. */
export type OverviewAdmin = {
  accounts: { total: number; freeIpa: number; local: number };
  openRequests: number;
  expiring: { freeIpa: number; local: number; guests: number };
  /** When the last FreeIPA sync ran, relative to the page's time; null when none ran yet. */
  lastSync: string | null;
  health: OverviewRun[];
  window: number;
  /** The newest changes of the audit log; null when it could not be read. */
  activity: OverviewActivity[] | null;
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
  /** How many groups the person belongs to, and the list of all groups. */
  groups: { memberCount: number; allHref: string };
  /** The person's own groups, the managed ones first, at most a handful. */
  myGroups: OverviewGroup[];
  admin: OverviewAdmin;
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

/**
 * The Accounts overview on v2, an administrator's page: the first row says what waits today, then who I am here, my
 * groups and the account runs, and beside them who changed what.
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
  const admin = () => props.admin;
  const expiring = () => admin().expiring.freeIpa + admin().expiring.local + admin().expiring.guests;
  const sync = () => admin().health.find((row) => row.run === "ipaSync");
  const reminders = () => admin().health.find((row) => row.run === "reminders");
  const groupWords = (group: OverviewGroup) =>
    [group.provider === "ipa" ? "FreeIPA" : t().local, group.description].filter(Boolean).join(" · ");

  return (
    <Workspace
      sidebar={<AccountsNav active="dashboard" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={
            <Tabs
              label={o().views}
              items={[
                { label: t().dashboard, current: true },
                { label: o().activity, href: "/app/accounts/activity" },
              ]}
            />
          }
          end={
            <>
              <Menu icon="file-text" items={admin().logs.map((link) => ({ label: t()[link.label], href: link.href }))}>
                {o().logs}
              </Menu>
              <Button avatar={me()} href="/me">
                {t().profilePage}
              </Button>
              <Button variant="primary" icon="user-plus" href="/app/accounts/users/new">
                {t().newUser}
              </Button>
            </>
          }
        />
      }
      primary={{ label: t().newUser, icon: "user-plus", href: "/app/accounts/users/new" }}
    >
      <Pane label={t().dashboard} scrollKey="accounts-dashboard">
        {/* k2b-ui gap: on the phone `Cells` stand one under the other; the approved mockup shows them two by two. */}
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
                marks={expiryChip()}
                href="/me"
              />
            </Section>
            <Section
              title={o().yourGroups}
              count={number(props.groups.memberCount)}
              more={{ label: t().allGroups, href: props.groups.allHref, forward: true }}
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
          </Pane>
              <Pane side label={o().activity} width={{ min: 300, default: 380 }}>
                <Section title={o().activity} more={{ label: o().allActivity, href: "/app/accounts/activity", forward: true }}>
                  <Show when={admin().activity} fallback={<Text muted>{o().activityFailed}</Text>}>
                    {(rows) => (
                      <Show when={rows().length > 0} fallback={<Text muted>{t().noAuditEvents}</Text>}>
                        <Digest
                          label={o().activity}
                          activity={rows().map((row) => ({
                            // a change without a person is the system's, as in the audit log
                            person: row.actor.userId
                              ? { name: row.actor.label }
                              : { name: row.actor.label, initials: "S", color: "#475569" },
                            text: (
                              <>
                                <Text weight="strong">{row.actor.label}</Text> {row.action.label}
                                <Show when={row.target.label !== "–"}>
                                  {" · "}
                                  <Mark {...targetMark(row.target.type)} />
                                  {row.target.href ? (
                                    <Text weight="strong" href={row.target.href}>
                                      {row.target.label}
                                    </Text>
                                  ) : (
                                    <Text weight="strong">{row.target.label}</Text>
                                  )}
                                </Show>
                                <Show when={row.outcome !== "allowed"}>
                                  {" "}
                                  {row.outcome === "denied" ? (
                                    <Chip status="warn">{t().denied}</Chip>
                                  ) : (
                                    <Chip status="bad">{t().failed}</Chip>
                                  )}
                                </Show>
                              </>
                            ),
                            time: `${row.day}, ${row.time}`,
                          }))}
                        />
                      </Show>
                    )}
                  </Show>
                </Section>
              </Pane>
        </Pane.Split>
      </Pane>
    </Workspace>
  );
}
