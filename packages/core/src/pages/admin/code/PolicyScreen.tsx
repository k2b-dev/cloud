import { AdminWorkspace } from "@k2b/cloud/ssr/islands";
import { formatDateTime } from "@k2b/cloud/shared";
import {
  Bar,
  Button,
  Dialog,
  Digest,
  Empty,
  Facts,
  Icon,
  Inline,
  Lookup,
  Pane,
  Row,
  Section,
  StatusRow,
  Table,
  Text,
  useLocale,
} from "@k2b/ui/v2";
import type { LookupItem } from "@k2b/ui/v2/list-query";
import { createSignal, For, type JSX, Show } from "solid-js";
import { z } from "zod";
import type { CodeAdminEffective, CodeAdminPolicy, CodeAdminPolicyChange } from "../../../code/admin";
import type { CodePolicyValue } from "../../../code/policy-contracts";
import StateWord from "../_area/StateWord";
import { CODE_POLICY_ROW_GROUPS, codeAreaHref } from "./area";
import { type CodeScreenBase, type Loaded, ok } from "./data";
import { CodeHead, Lead, LoadFailed, Missing, useCodeText } from "./parts";
import CodePolicyEditor from "./policy-editor";

export type PolicyScreenProps = CodeScreenBase & {
  section: "policy" | "groups" | "effective" | "history";
  policy: Loaded<CodeAdminPolicy>;
  effective: Loaded<CodeAdminEffective>;
  history: Loaded<{ items: CodeAdminPolicyChange[]; nextPage: number | null }>;
};

const EntitiesSchema = z.object({
  items: z.array(
    z.union([
      z.object({ kind: z.literal("user"), user: z.object({ id: z.string(), displayName: z.string().nullish(), uid: z.string(), mail: z.string().nullish() }) }),
      z.object({ kind: z.literal("group"), group: z.object({ id: z.string(), name: z.string(), description: z.string().nullish() }) }),
      z.object({ kind: z.string() }),
    ]),
  ),
});

/** People or groups of this Cloud for the lookup, through the directory the access editors use. */
const searchEntities =
  (kind: "user" | "group") =>
  async (search: string, context: { signal: AbortSignal; limit: number }): Promise<{ items: LookupItem[] }> => {
    const url = new URL("/api/accounts/entities", window.location.origin);
    url.searchParams.set("search", search);
    url.searchParams.set("kinds", kind);
    url.searchParams.set("per_page", String(Math.min(context.limit, 10)));
    const response = await fetch(url, { signal: context.signal, credentials: "same-origin" });
    if (!response.ok) throw new Error(response.statusText);
    const parsed = EntitiesSchema.parse(await response.json());
    return {
      items: parsed.items.flatMap((entity): LookupItem[] =>
        "user" in entity
          ? [{ value: entity.user.id, label: entity.user.displayName || entity.user.uid, meta: entity.user.mail ?? entity.user.uid }]
          : "group" in entity
            ? [{ value: entity.group.id, label: entity.group.name, ...(entity.group.description ? { meta: entity.group.description } : {}) }]
            : [],
      ),
    };
  };

/** Choosing a group to give its own rules, or a person to see their table; choosing opens it. */
function PickDialog(props: { kind: "group" | "person"; open: boolean; onClose: () => void }) {
  const t = useCodeText();
  return (
    <Dialog
      title={props.kind === "group" ? t().addGroup : t().choosePersonTitle}
      open={props.open}
      onOpenChange={(open) => !open && props.onClose()}
      foot={<Button onClick={props.onClose}>{t().cancel}</Button>}
    >
      <Text>{props.kind === "group" ? t().groupLead : t().choosePerson}</Text>
      <Lookup
        label={props.kind === "group" ? t().searchGroup : t().searchPerson}
        value={[]}
        minChars={2}
        load={searchEntities(props.kind === "group" ? "group" : "user")}
        onChange={(value) => {
          const id = value[0];
          if (id) window.location.assign(codeAreaHref({ sec: props.kind === "group" ? "groups" : "effective", id }));
        }}
      />
    </Dialog>
  );
}

/** A value of the policy as words: automatic stays quiet, the stricter ones carry their sign. */
function PolicyValue(props: { value: CodePolicyValue }) {
  const t = useCodeText();
  return (
    <Show when={props.value !== "automatic"} fallback={<StateWord>{t().value({ value: props.value })}</StateWord>}>
      <Text>
        <Icon name={props.value === "never" ? "ban" : "user-shield"} /> {t().value({ value: props.value })}
      </Text>
    </Show>
  );
}

/**
 * The Code policy on v2: the default for everyone, the groups with their own rules beside their list, the effective
 * table of one person, and the history of who changed what. Every change names what it pauses before it saves.
 */
export default function PolicyScreen(props: PolicyScreenProps) {
  const t = useCodeText();
  const locale = useLocale();
  const num = (n: number) => new Intl.NumberFormat(locale()).format(n);
  const policy = ok(props.policy) ? props.policy : null;
  const pausedHref = codeAreaHref({ sec: "code", status: "paused" });
  const when = (iso: string) => formatDateTime(iso, props.dateConfig);
  const [picking, setPicking] = createSignal(false);

  const policyPane = (): JSX.Element => (
    <Pane label={t().sectionLabel({ s: "policy" })} scrollKey="admin-code-policy" status={
      // k2b-ui gap: Hero figure (#4360); the preset in force is the statement
      policy ? (
        <StatusRow
          lead={t().presetInForce({ preset: { off: t().presetOff, admin: t().presetAdmin, open: t().presetOpen, custom: t().presetCustom }[policy.policy.definition.preset] })}
          facts={policy.updatedByName ? [{ value: t().lastChange({ who: policy.updatedByName, when: when(policy.policy.updatedAt) }) }] : undefined}
        />
      ) : undefined
    }>
      <Show when={policy} fallback={<LoadFailed />}>
        {(current) => (
          <>
            <Lead>{t().policyLead}</Lead>
            <CodePolicyEditor
              revision={current().policy.revision}
              definition={current().policy.definition}
              groupId={null}
              usage={current().usage}
              pausedHref={pausedHref}
            />
          </>
        )}
      </Show>
    </Pane>
  );

  const groupsPanes = (): JSX.Element => {
    const open = props.query.id;
    const group = policy?.groups.find((entry) => entry.id === open);
    const list = () => (
        <Pane
          label={t().groups}
          width={open ? { min: 320, default: 420 } : undefined}
          scrollKey="admin-code-groups"
          status={policy ? <StatusRow lead={t().groupsSub({ n: policy.groups.length })} /> : undefined}
        >
          <Show when={policy} fallback={<LoadFailed />}>
            {(current) => (
              <Table
                label={t().groups}
                rows={current().groups}
                rowKey={(entry) => entry.id}
                current={open}
                open={(entry) => ({ href: codeAreaHref({ sec: "groups", id: entry.id }) })}
                empty={{ icon: "users-group", text: t().noGroupsSub, action: { label: t().addGroup, icon: "plus", onClick: () => setPicking(true) } }}
                phone={(entry) => ({
                  avatar: { name: entry.name },
                  lines: [entry.name, t().groupRules({ rules: entry.rules, members: entry.members })],
                })}
                columns={[
                  {
                    title: t().group,
                    width: { min: 160, default: open ? 220 : 260 },
                    avatar: (entry) => ({ name: entry.name }),
                    cell: (entry) => entry.name,
                  },
                  { title: t().rules, width: { min: 80, default: 100 }, align: "end", drop: true, cell: (entry) => num(entry.rules) },
                  ...(open
                    ? []
                    : [
                        {
                          title: t().members,
                          width: { min: 80, default: 100 },
                          align: "end" as const,
                          drop: true,
                          cell: (entry: CodeAdminPolicy["groups"][number]) => num(entry.members),
                        },
                      ]),
                  {
                    title: t().parentGroup,
                    drop: true,
                    cell: (entry) => entry.parents.join(", ") || <Text muted>{t().none}</Text>,
                  },
                ]}
              />
            )}
          </Show>
        </Pane>
    );
    if (!open || !policy) return list();
    return (
      <Pane.Split>
        {list()}
        <Show when={open && policy}>
          <Pane
            detail
            label={group?.name ?? t().groups}
            back={{ label: t().groups, href: codeAreaHref({ sec: "groups" }) }}
            scrollKey="admin-code-group"
            head={
              <Bar
                start={
                  <Text type="body" weight="strong">
                    {group?.name ?? t().groupNew}
                  </Text>
                }
                end={<Button variant="ghost" icon="x" label={t().close} href={codeAreaHref({ sec: "groups" })} />}
              />
            }
          >
            <Lead>{t().groupLead}</Lead>
            <CodePolicyEditor
              revision={policy!.policy.revision}
              definition={policy!.policy.definition}
              groupId={open ?? null}
              usage={policy!.usage}
              pausedHref={pausedHref}
            />
          </Pane>
        </Show>
      </Pane.Split>
    );
  };

  const effectivePane = (): JSX.Element => {
    const effective = props.effective;
    return (
      <Pane
        label={t().sectionLabel({ s: "effective" })}
        scrollKey="admin-code-effective"
        status={ok(effective) ? <StatusRow lead={effective.person.name} facts={[{ value: effective.groups.length, after: t().groupsWord({ n: effective.groups.length }) }]} /> : undefined}
      >
        <Show
          when={ok(effective) ? effective : null}
          fallback={
            effective === null ? (
              <Empty icon="user-search" text={t().choosePerson} action={{ label: t().choosePersonTitle, icon: "search", onClick: () => setPicking(true) }} />
            ) : effective === "missing" ? (
              <Missing text={t().personMissing} back={{ sec: "effective" }} />
            ) : (
              <LoadFailed />
            )
          }
        >
          {(current) => {
            const byRow = new Map(current().rows.map((row) => [row.row, row]));
            return (
              <>
                <Lead>{t().effectiveLead}</Lead>
                <Section icon="users-group" title={t().memberOf}>
                  <Facts
                    items={[
                      {
                        label: t().groups,
                        value: current().groups.length
                          ? current()
                              .groups.map((group) => (group.parents.length ? `${group.name} (${t().subgroupOf({ p: group.parents.join(", ") })})` : group.name))
                              .join(", ")
                          : t().none,
                      },
                    ]}
                  />
                </Section>
                <For each={CODE_POLICY_ROW_GROUPS}>
                  {(group) => (
                    <Section title={group.key === "grpRead" ? t().grpReadSection : t()[group.key]}>
                      <For each={group.rows}>
                        {(rowId) => {
                          const row = byRow.get(rowId);
                          if (!row) return null;
                          const groups = row.groups.join(", ");
                          const source =
                            row.source === "veto" ? t().sourceVeto({ groups }) : row.source === "group" ? t().sourceGroup({ groups }) : t().sourceDefault;
                          return (
                            <Row
                              icon={row.source === "default" ? "world" : "users"}
                              lines={[
                                t().rowLabel({ row: row.row }),
                                `${source}${row.source === "default" && current().groups.length ? ` · ${t().noGroupRule}` : ""}`,
                              ]}
                              end={<PolicyValue value={row.value} />}
                            />
                          );
                        }}
                      </For>
                    </Section>
                  )}
                </For>
              </>
            );
          }}
        </Show>
      </Pane>
    );
  };

  const historyPane = (): JSX.Element => {
    const loaded = props.history;
    const value = (cell: CodePolicyValue | null) => (cell ? t().value({ value: cell }) : t().unset);
    const presetLabel = (preset: string) =>
      ({ off: t().presetOff, admin: t().presetAdmin, open: t().presetOpen, custom: t().presetCustom })[preset] ?? preset;
    const sentence = (entry: CodeAdminPolicyChange): JSX.Element => (
      <>
        <Text weight="strong">{entry.by ?? t().unknownAuthor}</Text>{" "}
        {[
          ...(entry.preset ? [t().historyPresetChange({ before: presetLabel(entry.preset.before), after: presetLabel(entry.preset.after) })] : []),
          ...entry.changes.map((change) =>
            t().historyChange({
              row: t().historyRow({ row: t().rowLabel({ row: change.row }), group: change.group }),
              before: value(change.before),
              after: value(change.after),
            }),
          ),
        ].join("; ")}
      </>
    );
    return (
      <Pane label={t().history} scrollKey="admin-code-history">
        <Show when={ok(loaded) ? loaded : null} fallback={<LoadFailed text={t().historyFailedSub} />}>
          {(page) => (
            <Show when={page().items.length} fallback={<Empty icon="history-off" text={t().historyEmptySub} />}>
              <Section icon="history" title={t().historyChanges} count={page().items.length}>
                <Digest
                  label={t().historyChangesLabel}
                  activity={page().items.map((entry) => ({ person: { name: entry.by ?? t().unknownAuthor }, text: sentence(entry), time: when(entry.at) }))}
                />
              </Section>
              <Show when={page().nextPage}>
                {(next) => <Bar end={<Button icon="chevron-down" href={codeAreaHref({ sec: "history", after: String(next()) })}>{t().olderChanges}</Button>} />}
              </Show>
            </Show>
          )}
        </Show>
      </Pane>
    );
  };

  const pick: "group" | "person" | null = props.section === "groups" ? "group" : props.section === "effective" ? "person" : null;
  return (
    <AdminWorkspace
      nav={props.nav}
      detail={props.section === "groups" && props.query.id ? 520 : undefined}
      detailEmpty={{ icon: "users-group", text: t().chooseGroup }}
      primary={pick ? { label: pick === "group" ? t().addGroup : t().choosePersonTitle, icon: pick === "group" ? "plus" : "search", onClick: () => setPicking(true) } : undefined}
      head={
        <CodeHead
          section={props.section}
          end={
            <>
              <Show when={props.section === "policy"}>
                <Button variant="text" icon="history" href={codeAreaHref({ sec: "history" })}>
                  {t().history}
                </Button>
              </Show>
              <Show when={pick}>
                {(kind) => (
                  <Button variant="primary" icon={kind() === "group" ? "plus" : "search"} onClick={() => setPicking(true)}>
                    {kind() === "group" ? t().addGroup : t().choosePersonTitle}
                  </Button>
                )}
              </Show>
            </>
          }
        />
      }
    >
      {props.section === "policy" ? policyPane() : props.section === "groups" ? groupsPanes() : props.section === "effective" ? effectivePane() : historyPane()}
      <Show when={pick}>{(kind) => <PickDialog kind={kind()} open={picking()} onClose={() => setPicking(false)} />}</Show>
    </AdminWorkspace>
  );
}
