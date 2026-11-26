import { cloudAvatarImage } from "@k2b/cloud/account/ui";
import type { GroupRelations } from "@k2b/cloud/contracts";
import type { AuthContext } from "@k2b/cloud/server";
import { expectUserBackedActor, getLocale } from "@k2b/cloud/server";
import { accountsAppService as accountsService, audit, coreSettings, linuxIdentities } from "@k2b/cloud/services";
import { canManageGroup, getDefaultGroupScope, groupDisplayName, isAdminUser } from "@k2b/cloud/shared";
import { Layout, requestPath } from "@k2b/cloud/ssr";
import { dates } from "@k2b/stdlib";
import { z } from "zod";
import type { EntityListItem } from "@/contracts";
import { ssr } from "../../../config";
import { toAccountsActor } from "../../../shared/actor";
import AccountsNavigation from "../../AccountsNavigation.island";
import { accountsNavigationItems } from "../../accounts-nav";
import { buildGroupsUrl, GROUPS_CONTEXT_QUERY_KEYS, parseGroupsListState } from "../../lib/url-state";
import { accountsMessages } from "../../messages";
import { parseRelationsUrl, type RecordRelationsState } from "../relations/relations-view";
import GroupScreen from "./GroupScreen.island";
import {
  buildGroupDetailPageBaseUrl,
  createGroupDetailHrefBuilder,
  getVisibleGroupDetailTabs,
  parseGroupDetailTab,
} from "./group-detail-url";
import type { GroupActivity, GroupMember, GroupPerson } from "./group-screen";

/** Entries per page of each tab, as before v2. */
const PER_PAGE = 100;
/** How many managers show their face in the key figures before "+n". */
const MANAGER_FACES = 4;

/**
 * The relations around a group, read by the one admin-checked service: `none` when it has none to show (the service
 * leaves personal groups out), null when the read failed, so the view offers to try again.
 */
const readRelations = async (
  actor: ReturnType<typeof toAccountsActor>,
  state: RecordRelationsState,
  signal: AbortSignal,
): Promise<GroupRelations | "none" | null> => {
  try {
    const result = await accountsService.group.relations({
      actor,
      focus: state.focus,
      selected: state.sel,
      depth: state.depth,
      managers: state.managers,
      view: state.view,
      expand: state.expand,
      signal,
    });
    return result.ok ? result.data : result.error.status === 404 ? "none" : null;
  } catch {
    return null;
  }
};

/** The audit actions a group's activity tells, by their short code. */
const ACTIVITY_ACTIONS: Record<string, GroupActivity["action"]> = {
  "accounts.group.create": "create",
  "accounts.group.update": "update",
  "accounts.group.make_posix": "posix",
  "accounts.group.member.add": "member.add",
  "accounts.group.member.remove": "member.remove",
  "accounts.group.manager.add": "manager.add",
  "accounts.group.manager.remove": "manager.remove",
};
/** How many changes the side column tells. */
const ACTIVITY_SIZE = 5;

type AuditEvents = Awaited<ReturnType<typeof audit.list>>["items"];
type Named = GroupPerson & { kind: "user" | "group" | "agent" };
type Wanted = { user: Set<string>; group: Set<string>; service_account: Set<string> };

const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** A directory entry as the face it shows. */
const named = (item: EntityListItem, locale: string): [string, Named] =>
  item.kind === "user"
    ? [
        item.user.id,
        {
          kind: "user",
          name: item.user.displayName || item.user.uid,
          image: cloudAvatarImage({ kind: "user", userId: item.user.id, avatarHash: item.user.avatarHash }),
        },
      ]
    : item.kind === "group"
      ? [item.group.id, { kind: "group", name: groupDisplayName(item.group.name, locale) }]
      : [
          item.serviceAccount.id,
          {
            kind: "agent",
            name: item.serviceAccount.name,
            image: cloudAvatarImage({ kind: "service_account", userId: item.serviceAccount.id }),
          },
        ];

/**
 * The group's last changes (administrators, who may read the audit log), newest first: one read of the audit log, of
 * which only the group's own changes stay. A failure leaves the activity out.
 * k2b-ui gap (platform): `audit.list` always counts beside its page; the record needs the rows only (a second statement).
 */
const readEvents = async (groupId: string): Promise<AuditEvents> => {
  try {
    const page = await audit.list({ pagination: { page: 1, perPage: ACTIVITY_SIZE * 2 }, filter: { target: groupId, outcome: "allowed" } });
    return page.items.filter((event) => event.target.id === groupId && ACTIVITY_ACTIONS[event.action]).slice(0, ACTIVITY_SIZE);
  } catch {
    return [];
  }
};

/** The people and groups the events name: the one who did it, and whom it concerned. */
const eventIds = (events: AuditEvents, wanted: Wanted) => {
  for (const event of events) {
    if (isId(event.actor.userId)) wanted.user.add(event.actor.userId);
    if (isId(event.metadata.userId)) wanted.user.add(event.metadata.userId);
    if (isId(event.metadata.groupId)) wanted.group.add(event.metadata.groupId);
    if (isId(event.metadata.serviceAccountId)) wanted.service_account.add(event.metadata.serviceAccountId);
  }
};

/**
 * Names every wanted id: the page's own rows name most of them; the rest come from ONE directory read, of the kinds that
 * are still missing only. A failed read leaves them unnamed.
 */
const nameAll = async (
  actor: ReturnType<typeof toAccountsActor>,
  known: Map<string, Named>,
  wanted: Wanted,
  locale: string,
): Promise<Map<string, Named>> => {
  const missing = (type: keyof Wanted) => [...wanted[type]].filter((id) => !known.has(id));
  const users = missing("user");
  const groups = missing("group");
  const agents = missing("service_account");
  const kinds = [
    ...(users.length ? (["user"] as const) : []),
    ...(groups.length ? (["group"] as const) : []),
    ...(agents.length ? (["service_account"] as const) : []),
  ];
  if (kinds.length === 0) return known;
  const read = await accountsService.entity
    .list({
      actor,
      pagination: { page: 1, perPage: users.length + groups.length + agents.length },
      userIds: users.length ? users : undefined,
      groupIds: groups.length ? groups : undefined,
      serviceAccountIds: agents.length ? agents : undefined,
      kinds: [...kinds],
    })
    .catch(() => ({ items: [] as EntityListItem[] }));
  return new Map([...known, ...read.items.map((item) => named(item, locale))]);
};

/** The events as sentences: who did what to whom, and when (relative to the time of this answer). */
const sentences = (events: AuditEvents, people: Map<string, Named>, locale: string): GroupActivity[] => {
  const now = new Date();
  return events.map((event) => {
    const subjectId = [event.metadata.userId, event.metadata.groupId, event.metadata.serviceAccountId].find(isId);
    const subject = subjectId ? people.get(subjectId) : undefined;
    const by = event.actor.userId ? people.get(event.actor.userId) : undefined;
    return {
      id: String(event.id),
      action: ACTIVITY_ACTIONS[event.action]!,
      actor: { name: by?.name ?? event.actor.uid ?? "?", image: by?.image },
      subject: subject ? { kind: subject.kind, name: subject.name } : null,
      time: dates.formatDateTimeRelative(event.createdAt, { locale, base: now }),
    };
  });
};

/**
 * One group on v2: its name and kinds in the head, its members, managers and the groups it belongs to as tabs, and its
 * facts beside them. The address holds the tab, the search, the page and the two display choices (`indirect`,
 * `service_accounts`), and the group list it was opened from (`list_*`), so the way back keeps that list.
 */
export default ssr<AuthContext>(async (c) => {
  const locale = getLocale(c);
  const { t } = accountsMessages.resolve([locale]);
  const groupId = c.req.param("id");
  const user = expectUserBackedActor(c);
  const accountsActor = toAccountsActor(user);
  const isAdmin = isAdminUser(user);
  const linuxEnabled = isAdmin && (await linuxIdentities.configuration(user)).enabled;
  const freeIpaEnabled = Boolean(await coreSettings.get<boolean>("freeipa.enable"));
  const defaultScope = getDefaultGroupScope(user);

  const listState = parseGroupsListState(
    {
      search: c.req.query("list_search"),
      page: c.req.query("list_page"),
      provider: c.req.query("list_provider"),
      scope: c.req.query("list_scope"),
    },
    { keys: GROUPS_CONTEXT_QUERY_KEYS, defaultScope },
  );
  const groupsListHref = buildGroupsUrl(listState, { defaultScope });
  const renderGroupNotFound = () => ssr.error(c, 404, { action: { label: t.backToGroups, href: groupsListHref } });

  if (!groupId || !z.uuid().safeParse(groupId).success) return renderGroupNotFound();
  const group = await accountsService.group.get({ id: groupId });
  if (!group) return renderGroupNotFound();

  const canManage = canManageGroup(user, groupId);
  const tab = parseGroupDetailTab(c.req.query("tab"), isAdmin);
  const canMutateGroup = group.provider === "local" || freeIpaEnabled;
  const canManageMutations = canManage && canMutateGroup;

  const rawPage = Number.parseInt(c.req.query("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const search = c.req.query("search") ?? "";
  const indirect = tab === "members" && c.req.query("indirect") === "true";
  const showServiceAccounts = tab !== "member-of" && c.req.query("service_accounts") === "true";
  const buildDetailHref = createGroupDetailHrefBuilder({ listState, defaultScope });
  const kinds: EntityListItem["kind"][] = showServiceAccounts ? ["user", "group", "service_account"] : ["user", "group"];

  const relationsState = tab === "relations" ? { ...parseRelationsUrl((name) => c.req.query(name)), focus: groupId } : null;
  const noEntries = { items: [] as EntityListItem[], total: 0 };
  const summary = tab !== "relations";
  const [pendingRequests, parentGroupIdsPage, managedGroupIdsPage, entries, directMembers, directManagers, relations, events] =
    await Promise.all([
      isAdmin ? accountsService.accountRequest.countPending() : Promise.resolve(0),
      accountsService.group.parent.list({ id: groupId }),
      accountsService.group.managedGroup.list({ id: groupId }),
      tab === "relations"
        ? Promise.resolve(noEntries)
        : accountsService.entity.list({
            actor: accountsActor,
            pagination: { page, perPage: PER_PAGE },
            search: search || undefined,
            ...(tab === "members"
              ? { memberOfGroupId: groupId, recursive: indirect, kinds }
              : tab === "managers"
                ? { managerOfGroupId: groupId, kinds }
                : { parentGroupId: groupId, kinds: ["group" as const] }),
          }),
      // Who stands in the group and who manages it directly: the key figures count them, the add dialogs leave them
      // out, only they can be removed, and the first managers show their faces.
      summary ? accountsService.group.member.list({ id: groupId, recursive: false }).then((result) => result.items) : Promise.resolve([]),
      summary ? accountsService.group.manager.list({ id: groupId }).then((result) => result.items) : Promise.resolve([]),
      relationsState ? readRelations(accountsActor, relationsState, c.req.raw.signal) : Promise.resolve(null),
      isAdmin && summary ? readEvents(groupId) : Promise.resolve([] as AuditEvents),
    ]);
  // The managers' faces and the names of the activity: the page's own rows name most; one read names the rest.
  const faceIds = directManagers.slice(0, MANAGER_FACES);
  const wanted: Wanted = { user: new Set(), group: new Set(), service_account: new Set() };
  for (const manager of faceIds) wanted[manager.type].add(manager.id);
  eventIds(events, wanted);
  const people = await nameAll(accountsActor, new Map(entries.items.map((item) => named(item, locale))), wanted, locale);
  const activity = sentences(events, people, locale);
  const faces = faceIds.flatMap((manager) => {
    const face = people.get(manager.id);
    return face ? [{ name: face.name, image: face.image }] : [];
  });

  // A page past the end, from an old link or after the last entries of a page were removed, opens the last page instead
  // of an empty one that reads as "no members". The URL then names the page shown, so a reload or Back shows it again.
  const pages = Math.max(1, Math.ceil(entries.total / PER_PAGE));
  if (page > pages) {
    const url = new URL(requestPath(c), "https://local.invalid");
    if (pages === 1) url.searchParams.delete("page");
    else url.searchParams.set("page", String(pages));
    return c.redirect(`${url.pathname}${url.search}`);
  }

  const parentGroupIds = parentGroupIdsPage.items;
  const directIds = (type: "user" | "group" | "service_account") =>
    tab === "member-of"
      ? type === "group"
        ? parentGroupIds
        : []
      : (tab === "members" ? directMembers : directManagers).filter((entry) => entry.type === type).map((entry) => entry.id);
  const count = (type: "user" | "group" | "service_account") => directMembers.filter((entry) => entry.type === type).length;

  const rows: GroupMember[] = entries.items.map((item): GroupMember => {
    const isDirect = tab === "member-of" || item.relation?.direct !== false;
    if (item.kind === "user")
      return {
        key: `user:${item.user.id}`,
        kind: "user",
        id: item.user.id,
        name: item.user.displayName || item.user.mail || item.user.uid,
        line: [item.user.uid, item.user.mail].filter(Boolean).join(" · "),
        profile: item.user.profile === "user" ? "user" : "guest",
        direct: isDirect,
        href: isAdmin ? `/app/accounts/users/${item.user.id}` : null,
        image: cloudAvatarImage({ kind: "user", userId: item.user.id, avatarHash: item.user.avatarHash }),
      };
    if (item.kind === "group")
      return {
        key: `group:${item.group.id}`,
        kind: "group",
        id: item.group.id,
        name: groupDisplayName(item.group.name, locale),
        line: item.group.description,
        provider: item.group.provider,
        direct: isDirect,
        href: buildDetailHref(item.group.id),
      };
    const account = item.serviceAccount;
    const agent = account.kind === "agent" || account.kind === "standalone";
    return {
      key: `service_account:${account.id}`,
      kind: agent ? "agent" : account.kind === "user_delegated" ? "user-bound" : "resource-bound",
      id: account.id,
      name: account.name,
      line: agent ? null : account.appId,
      direct: isDirect,
      // every kind of account has its record at the same address
      href: isAdmin ? `/app/accounts/users/${account.id}` : null,
      image: cloudAvatarImage({ kind: "service_account", userId: account.id }),
    };
  });

  const toggle = (change: { indirect?: boolean; agents?: boolean }) =>
    buildDetailHref(groupId, {
      tab,
      search: search || null,
      indirect: (change.indirect ?? indirect) ? "true" : null,
      service_accounts: (change.agents ?? showServiceAccounts) ? "true" : null,
      page: null,
    });
  const pageBase = buildGroupDetailPageBaseUrl(buildDetailHref, groupId, {
    tab,
    search: search || null,
    indirect: indirect ? "true" : null,
    service_accounts: showServiceAccounts ? "true" : null,
  });
  const name = groupDisplayName(group.name, locale);
  // The parameters a record keeps for the way back to its list, for the relations view's own links.
  const listContext = new URL(buildDetailHref(groupId), "https://local.invalid").searchParams.toString();

  return () => (
    <Layout
      c={c}
      fullWidth
      ui="v2"
      title={[
        { title: t.start, href: "/" },
        { title: t.accounts, href: "/app/accounts" },
        // The way up keeps the list's scope and filters this detail was opened from.
        { title: t.groups, href: groupsListHref },
        { title: name },
      ]}
    >
      <AccountsNavigation items={accountsNavigationItems(t, { active: "groups", pendingRequests, isAdmin })} />
      <GroupScreen
        group={{
          id: group.id,
          name,
          storedName: group.name,
          provider: group.provider,
          gid: group.gidnumber,
          description: group.description,
          owner: group.personalOwner ? { id: group.personalOwner.id, name: group.personalOwner.displayName } : null,
          parents: parentGroupIds.length,
          managedGroups: managedGroupIdsPage.items.length,
          people: count("user"),
          agents: count("service_account"),
          subGroups: count("group"),
          managers: { total: directManagers.length, faces },
        }}
        activity={activity}
        tab={tab}
        tabs={getVisibleGroupDetailTabs(isAdmin).map((entry) => ({
          tab: entry,
          href: buildDetailHref(groupId, { tab: entry, search: null, page: null, indirect: null, service_accounts: null }),
        }))}
        rows={rows}
        total={entries.total}
        search={search}
        indirect={indirect}
        agents={showServiceAccounts}
        links={{
          search: toggle({}),
          clearSearch: buildDetailHref(groupId, {
            tab,
            search: null,
            page: null,
            indirect: indirect ? "true" : null,
            service_accounts: showServiceAccounts ? "true" : null,
          }),
          indirect: toggle({ indirect: !indirect }),
          agents: toggle({ agents: !showServiceAccounts }),
          previous: page > 1 ? (page === 2 ? toggle({}) : `${pageBase}${page - 1}`) : null,
          next: page < pages ? `${pageBase}${page + 1}` : null,
          list: groupsListHref,
        }}
        page={page}
        pages={pages}
        exclude={{ users: directIds("user"), groups: directIds("group"), agents: directIds("service_account") }}
        isAdmin={isAdmin}
        canManage={canManageMutations}
        canMutate={canMutateGroup}
        linuxEnabled={linuxEnabled}
        pendingRequests={pendingRequests}
        relations={relationsState ? { state: relationsState, data: relations, context: listContext } : undefined}
      />
    </Layout>
  );
});
