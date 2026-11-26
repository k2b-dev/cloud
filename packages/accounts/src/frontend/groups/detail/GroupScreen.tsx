import type { GroupRelations } from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import {
  Avatar,
  Bar,
  Button,
  Cells,
  Chip,
  Dialog,
  Digest,
  Empty,
  Facts,
  Inline,
  Input,
  List,
  Mark,
  Menu,
  type MenuEntry,
  Notice,
  Pane,
  RecordHead,
  Row,
  Section,
  Tabs,
  Text,
  useToast,
  Workspace,
} from "@k2b/ui/v2";
import { createMemo, createSignal, For, Show } from "solid-js";
import AccountsNav from "../../AccountsNav";
import { usePageSwap } from "../../lib/page-swap";
import { useListMessages } from "../../list-messages";
import { useAccountsMessages } from "../../messages";
import { groupMark, groupTags, personalGroupMark } from "../group-mark";
import RelationsView, { RelationsTools } from "../relations/RelationsView";
import { relationsMessages } from "../relations/relations-messages";
import type { RecordRelationsState } from "../relations/relations-view";
import { AddEntriesDialog, DescriptionDialog } from "./GroupDialogs";
import { groupDeeds } from "./group-deeds";
import { entityOf, type GroupActivity, type GroupMember, type GroupPerson, type GroupTab, loadEntities } from "./group-screen";
import { useGroupDetailMessages } from "./messages";

export type { GroupActivity, GroupMember, GroupTab } from "./group-screen";

export type GroupView = {
  id: string;
  /** The name as people read it (`groupDisplayName`). */
  name: string;
  /** The name as stored, for the action notices. */
  storedName: string;
  provider: "ipa" | "local";
  gid: number | null;
  description: string | null;
  /** The user whose personal Linux group this is. */
  owner: { id: string; name: string } | null;
  parents: number;
  managedGroups: number;
  /** Direct members by kind: people, agents, and the groups it contains. */
  people: number;
  agents: number;
  subGroups: number;
  /** How many manage it, and the first of them for their faces. */
  managers: { total: number; faces: GroupPerson[] };
};

export type GroupScreenProps = {
  group: GroupView;
  tab: GroupTab;
  tabs: { tab: GroupTab; href: string }[];
  rows: GroupMember[];
  total: number;
  search: string;
  indirect: boolean;
  agents: boolean;
  /** Addresses the server built with the list context (`list_*`) of the page. */
  links: {
    /** This tab with its display choices and without a search; the search adds `search`. */
    search: string;
    clearSearch: string;
    indirect: string;
    agents: string;
    previous: string | null;
    next: string | null;
    /** The group list this page was opened from. */
    list: string;
  };
  page: number;
  pages: number;
  /** Who stands in the tab directly; the add dialog leaves them out. */
  exclude: { users: string[]; groups: string[]; agents: string[] };
  isAdmin: boolean;
  /** May change members and managers: manages the group, and the group can be changed. */
  canManage: boolean;
  /** The group can be changed here (a local group, or FreeIPA is on). */
  canMutate: boolean;
  linuxEnabled: boolean;
  pendingRequests: number;
  /** The relations view (administrators, tab `relations`): its state, the relations, and the list context it keeps. */
  relations?: { state: RecordRelationsState; data: GroupRelations | "none" | null; context: string };
  /** The last changes, for administrators; empty for everyone else or when there are none. */
  activity: GroupActivity[];
};

const TAB_ICONS: Record<GroupTab, string> = {
  members: "users-group",
  managers: "user-cog",
  "member-of": "folders",
  relations: "hierarchy-3",
};

/**
 * A group's page on v2, a record: its name and kinds in the head with the one deed of the open tab, its members,
 * managers and the groups it belongs to as tabs, its facts beside them. Every change is written through the API and
 * then shown by the server again; what is open (tab, search, page, display) lives in the address.
 */
export default function GroupScreen(props: GroupScreenProps) {
  const t = useGroupDetailMessages();
  const a = useAccountsMessages();
  const list = useListMessages();
  const locale = useLocale();
  const relationsWords = createMemo(() => relationsMessages.resolve([locale()]).t);
  const toast = useToast();
  const { showChanges, openPage } = usePageSwap();
  const [dialog, setDialog] = createSignal<"add" | "describe" | null>(null);
  const [busy, setBusy] = createSignal<string | null>(null);
  const deeds = groupDeeds(props.group, a);
  const canEdit = () => props.isAdmin && props.canMutate;
  const providerWord = (provider: "ipa" | "local") => (provider === "ipa" ? "FreeIPA" : a().local);
  const role = () => (props.tab === "managers" ? "managers" : "members");
  /** The tab's one deed, for those who may take it. */
  const addLabel = () =>
    props.tab === "relations"
      ? null
      : props.tab === "member-of"
        ? canEdit()
          ? a().addToGroup
          : null
        : props.canManage
          ? props.tab === "managers"
            ? a().addManager
            : a().addMember
          : null;
  const add = () => {
    const label = addLabel();
    return label ? { label, icon: props.tab === "member-of" ? "folder-plus" : "plus", onClick: () => setDialog("add") } : undefined;
  };
  const tabLabel = (tab: GroupTab) =>
    tab === "members" ? a().members : tab === "managers" ? a().managers : tab === "member-of" ? a().memberOf : relationsWords().relations;
  const countText = () => {
    const matching = Boolean(props.search);
    return props.tab === "members"
      ? a().memberCount({ count: props.total, matching })
      : props.tab === "managers"
        ? a().managerCount({ count: props.total, matching })
        : a().parentGroupCount({ count: props.total, matching });
  };
  const emptyText = () =>
    props.search
      ? a().noMatchingMembers
      : props.tab === "members"
        ? a().noMembers
        : props.tab === "managers"
          ? a().noManagers
          : a().noParentGroups;
  const placeholder = () =>
    props.tab === "members" ? a().searchMembers : props.tab === "managers" ? t().searchManagers : a().searchGroups;
  const search = (text: string) => {
    const url = new URL(props.links.search, window.location.origin);
    if (text.trim()) url.searchParams.set("search", text.trim());
    void openPage(`${url.pathname}${url.search}`);
  };

  const kindWord = (member: GroupMember) =>
    member.kind === "user"
      ? member.profile === "guest"
        ? a().guestAccount
        : a().fullAccount
      : member.kind === "group"
        ? `${a().group} · ${providerWord(member.provider ?? "local")}`
        : member.kind === "agent"
          ? props.tab === "managers"
            ? `${a().agent} · ${a().machineManagementAccess}`
            : a().agent
          : member.kind === "user-bound"
            ? a().userBound
            : a().resourceBound;
  const second = (member: GroupMember) =>
    [kindWord(member), member.kind === "user-bound" || member.kind === "resource-bound" ? (member.line ?? a().noAppId) : member.line]
      .filter(Boolean)
      .join(" · ");
  /** Only direct entries can be removed here, by those who may change the tab. */
  const removable = (member: GroupMember) => member.direct && (props.tab === "member-of" ? canEdit() : props.canManage);
  const removeLabel = (member: GroupMember) =>
    props.tab === "member-of" ? a().removeFromLabel({ name: member.name }) : a().removeLabel({ name: member.name });

  /** A deed that ran: on success the page shows the change and says so; a refusal says why and changes nothing. */
  /** A deed the server refused: its reason stands on the page with a way to take it again, until the next deed. */
  const [failure, setFailure] = createSignal<{ title: string; message: string; again: { label: string; onClick: () => void } } | null>(
    null,
  );
  const refused = (title: string, message: string, label: string, again: () => unknown) =>
    setFailure({
      title,
      message,
      again: {
        label,
        onClick: () => {
          setFailure(null);
          void again();
        },
      },
    });
  const remove = async (member: GroupMember): Promise<void> => {
    if (busy()) return;
    setFailure(null);
    const agreed = await Dialog.confirm({
      title:
        props.tab === "member-of"
          ? a().removeFromGroupConfirm({ name: member.name })
          : props.tab === "managers"
            ? a().removeManagerConfirm({ name: member.name })
            : a().removeMemberConfirm({ name: member.name }),
      confirm: a().remove,
      cancel: a().cancel,
    });
    const entity = entityOf(member.key);
    if (!agreed || !entity || busy()) return;
    setBusy(member.key);
    try {
      const result =
        props.tab === "member-of"
          ? await deeds.leave({ id: member.id, name: member.name }, a().removeFromGroupFailed)
          : await deeds.remove(role(), entity, a().removeFailed);
      if (!result.ok) return void refused(t().notRemoved, result.message, a().remove, () => remove(member));
      await showChanges();
      toast(t().removed, { status: "ok" });
    } finally {
      setBusy(null);
    }
  };
  const convert = async (): Promise<void> => {
    if (busy()) return;
    setFailure(null);
    const agreed = await Dialog.confirm({
      title: a().makePosix,
      description: a().posixConfirm({ name: props.group.name }),
      confirm: a().convert,
      cancel: a().cancel,
    });
    if (!agreed || busy()) return;
    setBusy("posix");
    try {
      const result = await deeds.posix(a().posixFailed);
      if (!result.ok) return void refused(t().notConverted, result.message, a().convert, convert);
      await showChanges();
      toast(t().posixDone, { status: "ok" });
    } finally {
      setBusy(null);
    }
  };
  const destroy = async (): Promise<void> => {
    if (busy()) return;
    setFailure(null);
    const agreed = await Dialog.confirm({
      title: a().deleteGroupQuestion({ name: props.group.name }),
      description: a().deleteGroupExplanation({ freeIpa: props.group.provider === "ipa" }),
      confirm: a().delete,
      cancel: a().cancel,
    });
    if (!agreed || busy()) return;
    setBusy("delete");
    try {
      const result = await deeds.delete(a().deleteGroupFailed);
      if (!result.ok) return void refused(t().notDeleted, result.message, a().delete, destroy);
      await openPage(props.links.list);
      toast(t().groupDeleted, { status: "ok" });
    } finally {
      setBusy(null);
    }
  };
  const groupMenu = (): MenuEntry[] => [
    ...(props.group.gid === null
      ? [
          {
            label: a().makePosix,
            icon: "transform",
            // the reason stands at the group type in the facts
            disabled: props.group.provider === "local" && !props.linuxEnabled,
            onClick: () => void convert(),
          },
        ]
      : []),
    // a personal Linux group stays while it is its user's primary group; the notice on the page says so
    { label: a().delete, icon: "trash", danger: true, disabled: props.group.owner !== null, onClick: () => void destroy() },
  ];
  const showMenu = (): MenuEntry[] =>
    props.tab === "member-of" || props.tab === "relations"
      ? []
      : [
          {
            title: t().show,
            items: [
              ...(props.tab === "members"
                ? [{ label: t().indirectMembers, checked: props.indirect, onClick: () => void openPage(props.links.indirect) }]
                : []),
              { label: t().agentMemberships, checked: props.agents, onClick: () => void openPage(props.links.agents) },
            ],
          },
        ];
  const addDialog = () => {
    if (props.tab === "member-of")
      return {
        title: t().addToGroupsTitle,
        lookup: t().lookupGroups,
        load: loadEntities(
          {
            kinds: ["group"],
            provider: props.group.provider,
            exclude: { users: [], groups: [...props.exclude.groups, props.group.id], agents: [] },
          },
          { agent: a().agent },
        ),
        add: (key: string) => deeds.join(entityOf(key)?.id ?? key, a().addGroupFailed),
      };
    // groups join groups only through administrators; agents join only local groups
    const groups = props.isAdmin;
    const agents = props.group.provider === "local";
    return {
      title: props.tab === "managers" ? t().addManagersTitle : t().addMembersTitle,
      lookup: t().lookupPeople({ groups, agents }),
      load: loadEntities(
        {
          kinds: ["user", ...(groups ? (["group"] as const) : []), ...(agents ? (["service_account"] as const) : [])],
          provider: props.group.provider,
          exclude: props.exclude,
        },
        { agent: a().agent },
      ),
      add: async (key: string) => {
        const entity = entityOf(key);
        if (!entity) return { ok: false as const, message: role() === "members" ? a().addMemberFailed : a().addManagerFailed };
        return deeds.add(role(), entity, role() === "members" ? a().addMemberFailed : a().addManagerFailed);
      },
    };
  };

  /** How many each tab holds, where the page knows it. */
  const tabCount = (tab: GroupTab) =>
    tab === "members"
      ? props.group.people + props.group.agents + props.group.subGroups
      : tab === "managers"
        ? props.group.managers.total
        : tab === "member-of"
          ? props.group.parents
          : undefined;
  /** The entries of the page in their kinds, each under its own head: people, groups, agents. */
  const sections = () => {
    const of = (kinds: GroupMember["kind"][]) => props.rows.filter((member) => kinds.includes(member.kind));
    return [
      { key: "people", title: t().people, rows: of(["user"]) },
      { key: "groups", title: props.tab === "members" ? t().subGroups : t().groups, rows: of(["group"]) },
      { key: "agents", title: t().agentsTitle, rows: of(["agent", "user-bound", "resource-bound"]) },
    ].filter((section) => section.rows.length > 0);
  };
  const tabHref = (tab: GroupTab) => props.tabs.find((entry) => entry.tab === tab)?.href;
  const mark = () => (props.group.owner ? personalGroupMark : groupMark);
  /** One change as a sentence: the actor in bold, the verb, and whom it concerned (a group with its mark). */
  const sentence = (entry: GroupActivity) => {
    const words = {
      create: t().activityCreate,
      update: t().activityUpdate,
      posix: t().activityPosix,
      "member.add": t().activityMemberAdd,
      "member.remove": t().activityMemberRemove,
      "manager.add": t().activityManagerAdd,
      "manager.remove": t().activityManagerRemove,
    }[entry.action];
    const [before, after = ""] = words.split("{subject}");
    return (
      <>
        <Text weight="strong">{entry.actor.name}</Text> {before}
        <Show when={words.includes("{subject}")}>
          <Show when={entry.subject?.kind === "group"}>
            <Mark icon={groupMark.icon} color={groupMark.color} />
          </Show>
          <Text weight="strong">{entry.subject?.name ?? t().someone}</Text>
          {after}
        </Show>
      </>
    );
  };

  return (
    <Workspace
      sidebar={<AccountsNav active="groups" pendingRequests={props.pendingRequests} isAdmin={props.isAdmin} />}
      head={
        <Bar
          start={
            <>
              <Button variant="ghost" icon="arrow-left" label={a().backToGroups} href={props.links.list} />
              <Mark icon={mark().icon} color={mark().color} />
              <RecordHead
                name={props.group.name}
                ids={props.group.gid !== null ? [{ label: a().gid, value: String(props.group.gid), copy: true }] : []}
              />
            </>
          }
          end={
            <>
              <Show when={props.tab !== "relations"}>
                <Input
                  type="search"
                  icon="search"
                  label={placeholder()}
                  placeholder={placeholder()}
                  value={props.search}
                  onKeyDown={(event) => {
                    if (event.isComposing) return;
                    const input = event.currentTarget as HTMLInputElement;
                    if (event.key === "Enter") search(input.value);
                    if (event.key === "Escape" && input.value) {
                      input.value = "";
                      search("");
                    }
                  }}
                />
              </Show>
              <Show when={add()}>
                {(action) => (
                  <Button variant="primary" icon={action().icon} onClick={action().onClick}>
                    {action().label}
                  </Button>
                )}
              </Show>
              <Show when={canEdit()}>
                <Menu label={a().groupActions} disabled={busy() !== null} items={groupMenu()} />
              </Show>
            </>
          }
        />
      }
      primary={add()}
    >
      <Show when={dialog() === "add" && addDialog()}>
        {(spec) => (
          <AddEntriesDialog
            title={spec().title}
            lookup={spec().lookup}
            load={spec().load}
            add={spec().add}
            close={(added) => {
              setDialog(null);
              if (added > 0) void showChanges().then(() => toast(t().added, { status: "ok" }));
            }}
          />
        )}
      </Show>
      <Show when={dialog() === "describe"}>
        <DescriptionDialog
          description={props.group.description}
          save={(description) => deeds.describe(description, a().updateGroupFailed)}
          close={(saved) => {
            setDialog(null);
            if (saved) void showChanges().then(() => toast(t().descriptionSaved, { status: "ok" }));
          }}
        />
      </Show>
      <Pane
        label={props.group.name}
        head={
          <Bar
            start={
              <Tabs
                label={a().groupDetailSections}
                items={props.tabs.map((entry) => ({
                  label: tabLabel(entry.tab),
                  count: tabCount(entry.tab),
                  icon: TAB_ICONS[entry.tab],
                  href: entry.href,
                  current: entry.tab === props.tab,
                }))}
              />
            }
            end={
              <Show
                when={props.tab === "relations" && props.relations}
                fallback={
                  <>
                    <Show when={props.search}>
                      <Text type="meta">{countText()}</Text>
                    </Show>
                    <Show when={showMenu().length > 0}>
                      <Menu variant="ghost" icon="adjustments-horizontal" items={showMenu()}>
                        {t().show}
                      </Menu>
                    </Show>
                  </>
                }
              >
                {(view) => <RelationsTools state={view().state} relations={view().data} context={view().context} />}
              </Show>
            }
          />
        }
      >
        <Show when={!props.canMutate}>
          <Notice tone="warn" icon="alert-triangle">
            {a().ipaDisabledMutations}
          </Notice>
        </Show>
        <Show when={failure()}>
          {(shown) => (
            <Notice
              tone="bad"
              icon="alert-circle"
              title={shown().title}
              actions={[shown().again, { label: t().hide, onClick: () => setFailure(null) }]}
            >
              {shown().message}
            </Notice>
          )}
        </Show>
        <Show when={canEdit() && props.group.owner}>
          {(owner) => (
            <Notice
              tone="note"
              icon="user"
              title={t().personalTitle}
              actions={[{ label: t().openOwner, href: `/app/accounts/users/${encodeURIComponent(owner().id)}` }]}
            >
              {a().personalGroupDeleteBlocked({ name: owner().name })}
            </Notice>
          )}
        </Show>
        <Show
          when={props.tab === "relations" && props.relations}
          fallback={
            <>
              <Cells>
                {/* what the group is, in its colours: where it is managed, POSIX, personal */}
                <Cells.Cell
                  icon={mark().icon}
                  color={mark().color}
                  label={t().kind}
                  value={
                    <Inline>
                      <Show when={props.group.provider === "ipa"}>
                        <Chip tag icon={groupTags.ipa.icon} color={groupTags.ipa.color}>
                          FreeIPA
                        </Chip>
                      </Show>
                      <Show
                        when={props.group.owner}
                        fallback={
                          <Show
                            when={props.group.gid !== null}
                            fallback={
                              <Show when={props.group.provider !== "ipa"}>
                                <Text>{a().standardGroup}</Text>
                              </Show>
                            }
                          >
                            <Chip tag icon={groupTags.posix.icon} color={groupTags.posix.color}>
                              POSIX
                            </Chip>
                          </Show>
                        }
                      >
                        <Chip tag icon={groupTags.personal.icon} color={groupTags.personal.color}>
                          {t().personal}
                        </Chip>
                      </Show>
                    </Inline>
                  }
                  meta={[
                    providerWord(props.group.provider),
                    props.group.owner && props.group.gid !== null ? "POSIX" : null,
                    props.group.gid !== null ? `GID ${props.group.gid}` : null,
                    canEdit() && props.group.gid === null && props.group.provider === "local" && !props.linuxEnabled
                      ? a().localPosixUnavailable
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                />
                <Cells.Cell
                  icon="users"
                  color="#2563eb"
                  label={a().members}
                  value={String(props.group.people + props.group.agents)}
                  meta={t().memberMix({ people: props.group.people, agents: props.group.agents })}
                  href={props.tab === "members" ? undefined : tabHref("members")}
                />
                <Cells.Cell
                  icon="user-cog"
                  color="#7c3aed"
                  label={a().managers}
                  value={String(props.group.managers.total)}
                  meta={
                    props.group.managers.faces.length > 0 ? <Avatar.Stack people={props.group.managers.faces} max={4} /> : t().noManagers
                  }
                  href={props.tab === "managers" ? undefined : tabHref("managers")}
                />
                <Cells.Cell
                  icon={groupMark.icon}
                  color={groupMark.color}
                  label={t().subGroups}
                  value={String(props.group.subGroups)}
                  meta={t().subGroupsMeta}
                />
              </Cells>
              <Pane.Split>
                <Pane label={tabLabel(props.tab)} scrollKey={`accounts-group-${props.tab}`}>
                  <Show when={props.tab === "managers" && props.agents && props.group.provider === "local"}>
                    <Notice tone="note" icon="robot">
                      {a().machineManagementHint}
                    </Notice>
                  </Show>
                  <Show
                    when={props.total > 0}
                    fallback={
                      <Empty
                        icon={props.search ? "search-off" : TAB_ICONS[props.tab]}
                        text={emptyText()}
                        action={props.search ? { label: t().clearSearch, icon: "x", href: props.links.clearSearch } : add()}
                      />
                    }
                  >
                    {/* k2b-ui gap: virtualized list (lane MW). Until it lands the server pages the entries, 100 at a time. */}
                    <For each={sections()}>
                      {(section) => (
                        <Section title={section.title} count={section.rows.length}>
                          <List label={section.title}>
                            <For each={section.rows}>
                              {(member) => (
                                <Row
                                  lines={[member.name, second(member)]}
                                  avatar={member.kind === "group" ? undefined : { name: member.name, image: member.image }}
                                  mark={member.kind === "group" ? groupMark : undefined}
                                  meta={member.direct ? undefined : a().indirect}
                                  href={member.href ?? undefined}
                                  end={
                                    removable(member) ? (
                                      <Button
                                        variant="ghost"
                                        icon="x"
                                        label={removeLabel(member)}
                                        busy={busy() === member.key}
                                        onClick={() => void remove(member)}
                                      />
                                    ) : undefined
                                  }
                                />
                              )}
                            </For>
                          </List>
                        </Section>
                      )}
                    </For>
                  </Show>
                  <Show when={props.pages > 1}>
                    <Bar
                      start={<Text type="meta">{list().pageOf({ page: props.page, pages: props.pages })}</Text>}
                      end={
                        <>
                          <Button icon="chevron-left" href={props.links.previous ?? undefined} disabled={!props.links.previous}>
                            {list().previous}
                          </Button>
                          <Button href={props.links.next ?? undefined} disabled={!props.links.next} forward>
                            {list().next}
                          </Button>
                        </>
                      }
                    />
                  </Show>
                </Pane>
                <Pane side label={t().details} width={{ min: 280, default: 340 }}>
                  <Section
                    title={t().details}
                    actions={canEdit() ? [{ label: a().edit, icon: "pencil", onClick: () => setDialog("describe") }] : undefined}
                  >
                    <Facts
                      items={[
                        {
                          label: a().description,
                          value: props.group.description ? props.group.description : <Text muted>{a().noDescription}</Text>,
                        },
                        ...(props.group.owner
                          ? [
                              {
                                label: t().ownedBy,
                                value: props.isAdmin ? (
                                  <Text href={`/app/accounts/users/${encodeURIComponent(props.group.owner.id)}`}>
                                    {props.group.owner.name}
                                  </Text>
                                ) : (
                                  props.group.owner.name
                                ),
                              },
                            ]
                          : []),
                        { label: a().managedGroups, value: String(props.group.managedGroups) },
                        { label: a().access, value: props.canManage ? a().canManageMembers : a().readOnly },
                        { label: a().mutations, value: props.canMutate ? a().available : a().unavailableWithoutIpa },
                      ]}
                    />
                  </Section>
                  <Show when={props.activity.length > 0}>
                    <Section title={t().activity}>
                      <Digest
                        label={t().activity}
                        activity={props.activity.map((entry) => ({
                          person: entry.actor,
                          text: sentence(entry),
                          time: entry.time,
                        }))}
                      />
                    </Section>
                  </Show>
                </Pane>
              </Pane.Split>
            </>
          }
        >
          {(view) => <RelationsView state={view().state} relations={view().data} context={view().context} />}
        </Show>
      </Pane>
    </Workspace>
  );
}
