import type { GroupRelations } from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import {
  Band,
  Bar,
  Button,
  Dialog,
  Empty,
  Facts,
  Input,
  List,
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
import RelationsView from "../relations/RelationsView";
import { relationsMessages } from "../relations/relations-messages";
import type { RecordRelationsState } from "../relations/relations-view";
import { AddEntriesDialog, DescriptionDialog } from "./GroupDialogs";
import { groupDeeds } from "./group-deeds";
import { entityOf, type GroupMember, type GroupTab, loadEntities } from "./group-screen";
import { useGroupDetailMessages } from "./messages";

export type { GroupMember, GroupTab } from "./group-screen";

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
    props.tab === "members" ? a().searchMembers : props.tab === "managers" ? t().searchManagers : t().searchParentGroups;
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
  const finish = async (result: { ok: true } | { ok: false; message: string }, done: string, retry: () => unknown) => {
    if (!result.ok) {
      toast(result.message, { status: "bad", retry });
      return;
    }
    await showChanges();
    toast(done, { status: "ok" });
  };
  const remove = async (member: GroupMember) => {
    if (busy()) return;
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
      await finish(result, t().removed({ name: member.name }), () => void remove(member));
    } finally {
      setBusy(null);
    }
  };
  const convert = async () => {
    if (busy()) return;
    const agreed = await Dialog.confirm({
      title: a().makePosix,
      description: a().posixConfirm({ name: props.group.name }),
      confirm: a().convert,
      cancel: a().cancel,
    });
    if (!agreed || busy()) return;
    setBusy("posix");
    try {
      await finish(await deeds.posix(a().posixFailed), t().posixDone, () => void convert());
    } finally {
      setBusy(null);
    }
  };
  const destroy = async () => {
    if (busy()) return;
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
      if (!result.ok) return void toast(result.message, { status: "bad", retry: () => void destroy() });
      await openPage(props.links.list);
      toast(a().groupDeletedFrom({ name: props.group.name, provider: providerWord(props.group.provider) }), { status: "ok" });
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

  return (
    <Workspace
      sidebar={<AccountsNav active="groups" pendingRequests={props.pendingRequests} isAdmin={props.isAdmin} />}
      head={
        <Bar
          start={
            <>
              <Button variant="ghost" icon="arrow-left" label={a().backToGroups} href={props.links.list} />
              <RecordHead
                name={props.group.name}
                kinds={[
                  providerWord(props.group.provider),
                  ...(props.group.gid !== null ? ["POSIX"] : []),
                  ...(props.group.owner ? [a().personalGroupOf({ name: props.group.owner.name })] : []),
                ]}
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
              if (added > 0) void showChanges().then(() => toast(t().added({ count: added }), { status: "ok" }));
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
          <Tabs
            label={a().groupDetailSections}
            items={props.tabs.map((entry) => ({
              label: tabLabel(entry.tab),
              icon: TAB_ICONS[entry.tab],
              href: entry.href,
              current: entry.tab === props.tab,
            }))}
          />
        }
      >
        <Show when={!props.canMutate}>
          <Notice tone="warn" icon="alert-triangle">
            {a().ipaDisabledMutations}
          </Notice>
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
            <Pane.Split>
              <Pane
                label={tabLabel(props.tab)}
                scrollKey={`accounts-group-${props.tab}`}
                status={
                  <Bar
                    start={<Text>{countText()}</Text>}
                    end={
                      <Show when={showMenu().length > 0}>
                        <Menu variant="ghost" icon="adjustments-horizontal" items={showMenu()}>
                          {t().show}
                        </Menu>
                      </Show>
                    }
                  />
                }
              >
                <Show when={props.tab === "managers" && props.group.provider === "local"}>
                  <Band>
                    <Text>{a().machineManagementHint}</Text>
                  </Band>
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
                  <List label={tabLabel(props.tab)}>
                    <For each={props.rows}>
                      {(member) => (
                        <Row
                          lines={[member.name, second(member)]}
                          avatar={member.kind === "group" ? undefined : { name: member.name, image: member.image }}
                          icon={member.kind === "group" ? "users-group" : undefined}
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
                      { label: a().provider, value: providerWord(props.group.provider) },
                      {
                        label: a().description,
                        value: props.group.description ? props.group.description : <Text muted>{a().noDescription}</Text>,
                      },
                      {
                        label: a().groupType,
                        value: props.group.gid !== null ? a().posixGroup : a().standardGroup,
                        hint:
                          canEdit() && props.group.gid === null && props.group.provider === "local" && !props.linuxEnabled
                            ? a().localPosixUnavailable
                            : undefined,
                      },
                      props.group.gid !== null
                        ? { label: a().gid, value: String(props.group.gid), mono: true, copy: String(props.group.gid) }
                        : { label: a().gid, value: <Text muted>{a().notSet}</Text> },
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
                      { label: a().parentGroups, value: String(props.group.parents) },
                      { label: a().managedGroups, value: String(props.group.managedGroups) },
                      { label: a().access, value: props.canManage ? a().canManageMembers : a().readOnly },
                      { label: a().mutations, value: props.canMutate ? a().available : a().unavailableWithoutIpa },
                    ]}
                  />
                </Section>
              </Pane>
            </Pane.Split>
          }
        >
          {(view) => <RelationsView state={view().state} relations={view().data} context={view().context} />}
        </Show>
      </Pane>
    </Workspace>
  );
}
