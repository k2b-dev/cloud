import { openAvatarUploadDialog } from "@k2b/cloud/account/ui";
import { groupDisplayName } from "@k2b/cloud/shared";
import { useLocale } from "@k2b/ui";
import {
  Bar,
  Button,
  Cells,
  type ConfirmOptions,
  Dialog,
  Empty,
  Facts,
  Failed,
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
import { createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { usePageSwap } from "@/frontend/lib/page-swap";
import AccountsNav from "../../AccountsNav";
import { useAccountsMessages } from "../../messages";
import { deleteUserRequest } from "../delete-user";
import LinuxIdentitySection from "./linux-identity";
import { number, useUserRecordMessages } from "./messages";
import { createCloudAppPairing } from "./pair-cloud-app";
import { userActionAvailability } from "./user-actions";
import { AddToGroupsDialog, CredentialDialog, EditUserDialog, ExpiryDialog, NotifyDialog } from "./user-dialogs";
import {
  createLoginToken,
  removeAppDevice,
  removeAvatar,
  removeMembership,
  resetPassword,
  revokeApiKey,
  revokeSignInDevice,
  saveAvatar,
  setAdmin,
  setProfile,
  setProvider,
} from "./user-requests";
import { type UserGroupView, type UserRecordView, type UserTab, userRecordHref } from "./user-view";

/** Rows of direct groups the overview shows before "All groups". */
const OVERVIEW_GROUPS = 6;
/** Rows a long list shows at first and adds per press, so the page stays light with a thousand memberships. */
const REVEAL = 100;

type Props = {
  record: UserRecordView;
  tab: UserTab;
  recursive: boolean;
  /** The list address this page was opened from, so its links lead back to the same filtered list. */
  list: string;
  listHref: string;
  pendingRequests: number;
};

type Dialogs =
  | { kind: "none" }
  | { kind: "edit" | "notify" | "expiry" | "groups" }
  | { kind: "credential"; title: string; intro: string[]; fields: { label: string; value: string }[] };

/**
 * A user's record on v2: name, picture and kinds in the head with the account's deeds behind "…", and its areas as
 * tabs: the overview (key statements, direct groups, Linux identity, details), the memberships, the API keys and the
 * devices. The open tab and the inherited memberships live in the address; every deed asks first where it cannot be
 * taken back, says when it failed, and shows the page again after it worked.
 */
export default function UserScreen(props: Props) {
  const t = useAccountsMessages();
  const r = useUserRecordMessages();
  const locale = useLocale();
  const toast = useToast();
  const { showChanges, openPage } = usePageSwap();
  const record = () => props.record;
  const n = (count: number) => number(count, locale());
  const user = () => props.record.user;
  const can = () => userActionAvailability(user(), record().freeIpaEnabled);
  const href = (tab: UserTab, recursive = false) => userRecordHref(user().id, props.list, { tab, recursive });
  const [dialog, setDialog] = createSignal<Dialogs>({ kind: "none" });
  const [busy, setBusy] = createSignal<string | null>(null);
  const [shown, setShown] = createSignal({ memberships: REVEAL, managed: REVEAL });
  /** "Show more" at the end of a list that holds more rows than it shows. */
  const moreOf = (list: "memberships" | "managed", total: number) => {
    const rest = total - shown()[list];
    return rest > 0
      ? { label: r().showMore({ count: Math.min(REVEAL, rest) }), onClick: () => setShown((now) => ({ ...now, [list]: now[list] + REVEAL })) }
      : undefined;
  };
  const closed = (changed: boolean) => {
    setDialog({ kind: "none" });
    if (changed) void showChanges();
  };
  const pairing = createCloudAppPairing({
    userId: user().id,
    name: record().cloudApp.name,
    administrator: record().cloudApp.administrator,
    blocked: record().cloudApp.blocked,
    paired: () => void showChanges(),
  });

  /** One deed: asks first when `question` is given, runs once at a time, and says when it failed. */
  const deed = async (key: string, question: ConfirmOptions | null, run: () => Promise<void>) => {
    if (busy()) return;
    if (question && !(await Dialog.confirm(question))) return;
    setBusy(key);
    try {
      await run();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : r().deedFailed, { status: "bad" });
    } finally {
      setBusy(null);
    }
  };
  const changed = (key: string, question: ConfirmOptions | null, run: () => Promise<void>) =>
    deed(key, question, async () => {
      await run();
      await showChanges();
    });
  const uid = () => user().uid;

  const changeAvatar = () =>
    // k2b-ui gap: the avatar dialog comes from @k2b/cloud/account/ui (v1 dialog); v2 has no image crop dialog yet.
    void openAvatarUploadDialog({
      username: user().displayName || uid(),
      userId: user().id,
      avatarHash: user().avatarHash,
      subtitle: t().avatarSubtitle({ uid: uid() }),
      visibilityText: t().avatarVisibility,
      messages: { formats: t().avatarFormats },
      onSave: async (dataUrl) => {
        await saveAvatar(user().id, dataUrl, t());
        await showChanges();
      },
      onRemove: user().avatarHash
        ? async () => {
            await removeAvatar(user().id, t());
            await showChanges();
          }
        : undefined,
    });
  const resetUserPassword = () =>
    deed(
      "password",
      { title: t().resetPassword, description: t().resetPasswordConfirm({ uid: uid() }), confirm: t().reset, cancel: t().cancel },
      async () => {
        const password = await resetPassword(user(), t());
        setDialog({
          kind: "credential",
          title: t().temporaryPasswordCreated,
          intro: [t().temporaryPasswordIntro, t().temporaryPasswordNextLogin],
          fields: [{ label: t().temporaryPassword, value: password }],
        });
      },
    );
  const loginToken = () =>
    deed(
      "token",
      {
        title: t().createLoginToken,
        description: t().createLoginTokenConfirm({ identity: user().mail ?? uid() }),
        confirm: t().createToken,
        cancel: t().cancel,
      },
      async () => {
        const token = await createLoginToken(user(), t());
        setDialog({
          kind: "credential",
          title: t().loginTokenCreated,
          intro: [t().loginTokenIntro({ minutes: Math.ceil(token.expiresInSeconds / 60) }), t().loginTokenShare],
          fields: [
            { label: t().loginToken, value: token.token },
            { label: t().directLoginLink, value: token.magicLink },
          ],
        });
      },
    );
  const profile = (next: "user" | "guest") =>
    changed(
      "profile",
      {
        title: next === "guest" ? t().setGuestQuestion({ uid: uid() }) : t().setFullQuestion({ uid: uid() }),
        description: next === "guest" ? t().guestProfileDescription : t().fullProfileDescription,
        confirm: next === "guest" ? t().setGuestAccount : t().setFullAccount,
        cancel: t().cancel,
      },
      () => setProfile(user(), next, t()),
    );
  const admin = (next: boolean) =>
    changed(
      "admin",
      {
        title: next ? t().grantLocalAdmin : t().revokeLocalAdmin,
        description: next ? t().grantLocalAdminConfirm({ uid: uid() }) : t().revokeLocalAdminConfirm({ uid: uid() }),
        confirm: next ? t().grantAdmin : t().revokeAdmin,
        cancel: t().cancel,
      },
      () => setAdmin(user(), next, t()),
    );
  const provider = (next: "ipa" | "local") =>
    changed(
      "provider",
      next === "ipa"
        ? {
            title: t().switchToIpaQuestion({ uid: uid() }),
            description: [
              t().switchToIpaDescription,
              t().keepsUidEmail,
              t().keepsDatabaseIdentity,
              t().localGroupsStayLocal,
              t().ipaGroupsDerived,
            ].join(" "),
            confirm: t().createFreeIpaAccount,
            cancel: t().cancel,
          }
        : {
            title: t().switchToLocalQuestion({ uid: uid() }),
            description: [
              t().switchToLocalDescription,
              t().keepsDatabaseIdentity,
              t().localGroupsUntouched,
              t().ipaRelationsRemoved,
              t().profilePreserved,
            ].join(" "),
            confirm: t().makeLocal,
            cancel: t().cancel,
          },
      () => setProvider(user(), next, t()),
    );
  const destroy = () =>
    deed(
      "delete",
      {
        title: t().deleteUserQuestion({ uid: uid() }),
        description: [
          [user().displayName || uid(), user().mail].filter(Boolean).join(" · "),
          t().deleteUserExplanation({ freeIpa: user().provider === "ipa" }),
          t().deleteUserNoTransfer,
        ].join(" "),
        confirm: t().delete,
        cancel: t().cancel,
      },
      async () => {
        await deleteUserRequest(user(), t());
        toast(r().deleted, { status: "ok" });
        await openPage(props.listHref);
      },
    );

  const menu = (): MenuEntry[] => {
    const allowed = can();
    const entries: MenuEntry[] = [
      {
        title: t().auditLog,
        items: [
          { label: t().actionsByUser, icon: "clipboard-list", href: allowed.auditByUserHref },
          { label: t().actionsOnUser, icon: "user-search", href: allowed.auditOnUserHref },
        ],
      },
      {
        title: t().account,
        items: [
          { label: t().changeAvatar, icon: "camera", onClick: changeAvatar },
          ...(allowed.canMutate ? [{ label: t().edit, icon: "pencil", onClick: () => setDialog({ kind: "edit" }) }] : []),
          ...(allowed.notify ? [{ label: t().notify, icon: "send", onClick: () => setDialog({ kind: "notify" }) }] : []),
          ...(allowed.setExpiry ? [{ label: t().setExpiry, icon: "calendar", onClick: () => setDialog({ kind: "expiry" }) }] : []),
        ],
      },
      {
        title: t().access,
        items: [
          ...(allowed.ipaDeeds
            ? [
                { label: t().makeLocal, icon: "home-move", onClick: () => void provider("local") },
                { label: t().resetPassword, icon: "lock-open", danger: true, onClick: () => void resetUserPassword() },
              ]
            : []),
          ...(allowed.loginToken ? [{ label: t().loginToken, icon: "key", onClick: () => void loginToken() }] : []),
          ...(allowed.local
            ? [
                allowed.guest
                  ? { label: t().promote, icon: "user-up", onClick: () => void profile("user") }
                  : { label: t().demote, icon: "user-down", onClick: () => void profile("guest") },
              ]
            : []),
          ...(allowed.local && !allowed.guest
            ? [
                allowed.localAdmin
                  ? { label: t().revokeAdmin, icon: "shield-x", onClick: () => void admin(false) }
                  : { label: t().grantAdmin, icon: "shield-check", onClick: () => void admin(true) },
              ]
            : []),
          ...(allowed.createIpa ? [{ label: t().createFreeIpa, icon: "building-fortress", onClick: () => void provider("ipa") }] : []),
        ],
      },
      ...(allowed.canMutate ? [{ label: t().delete, icon: "trash", danger: true, onClick: () => void destroy() }] : []),
    ];
    return entries.filter((entry) => typeof entry === "string" || !("title" in entry) || entry.items.length > 0);
  };

  const providerName = (group: UserGroupView) => (group.provider === "ipa" ? "FreeIPA" : t().local);
  const groupRow = (group: UserGroupView, removable: boolean) => {
    const name = groupDisplayName(group.name, locale());
    const key = `group:${group.id}`;
    return (
      <Row
        icon="users-group"
        lines={[name, group.description || r().noDescription]}
        meta={removable ? `${providerName(group)} · ${group.direct ? r().direct : r().inherited}` : providerName(group)}
        href={`/app/accounts/groups/${group.id}`}
        end={
          removable && group.direct ? (
            <Button
              variant="ghost"
              icon="user-minus"
              label={r().removeFromGroup({ group: name })}
              busy={busy() === key}
              onClick={() =>
                void changed(
                  key,
                  {
                    title: r().removeFromGroupQuestion({ name: uid(), group: name }),
                    description: r().removeFromGroupConsequence,
                    confirm: r().remove,
                    cancel: t().cancel,
                  },
                  () => removeMembership(group.id, user().id, t()),
                )
              }
            />
          ) : undefined
        }
      />
    );
  };
  const addAction = () => ({ label: r().addToGroups, icon: "users-plus", onClick: () => setDialog({ kind: "groups" }) });
  const noGroups = () => <Empty icon="users-group" text={t().noGroupMemberships} action={addAction()} />;

  const overview = () => (
    <>
      <Show when={record().expired && record().expires}>
        {(date) => <Notice tone="warn">{r().expiredNotice({ date: date() })}</Notice>}
      </Show>
      <Cells>
        <Cells.Cell
          icon={user().profile === "guest" ? "user" : "user-check"}
          label={t().access}
          value={user().profile === "user" ? t().fullAccount : t().guestAccount}
          meta={
            record().expires
              ? record().expired
                ? r().expiredOn({ date: record().expires ?? "" })
                : r().expiresOn({ date: record().expires ?? "" })
              : r().neverExpires
          }
        />
        <Cells.Cell
          icon="users-group"
          label={t().groups}
          value={r().directCount({ count: record().directCount })}
          meta={
            record().managed.length > 0
              ? r().managesCount({ count: record().managed.length })
              : r().withInherited({ count: record().allCount })
          }
          href={href("groups")}
        />
        <Cells.Cell icon="key" label={t().apiKeys} value={n(record().keysTotal)} meta={r().keysMeta} href={href("keys")} />
        <Cells.Cell
          icon="devices"
          label={r().devices}
          value={
            record().signInDevices && record().appDevices
              ? n((record().signInDevices?.length ?? 0) + (record().appDevices?.length ?? 0))
              : "–"
          }
          meta={record().signInDevices && record().appDevices ? r().devicesMeta : r().notLoaded}
          href={href("devices")}
        />
      </Cells>
      <Pane.Split>
        <Pane label={r().overview}>
          <Section
            icon="users-group"
            title={r().directGroupsTitle}
            count={n(record().directCount)}
            actions={[addAction()]}
            more={record().directCount > OVERVIEW_GROUPS ? { label: r().allMemberships, href: href("groups"), forward: true } : undefined}
          >
            <Show when={record().directCount > 0} fallback={noGroups()}>
              <For each={directGroups().slice(0, OVERVIEW_GROUPS)}>{(group) => groupRow(group, false)}</For>
            </Show>
          </Section>
          <Show when={record().linux}>{(linux) => <LinuxIdentitySection initial={linux()} />}</Show>
        </Pane>
        <Pane side label={r().details} width={{ min: 280, default: 360 }}>
          <Section icon="id" title={t().account}>
            <Facts
              items={record().facts.map((fact) => ({
                label: fact.label,
                value: fact.overdue ? (
                  <Text tone="bad" weight="medium">
                    {fact.value}
                  </Text>
                ) : fact.missing ? (
                  <Text muted>{fact.value}</Text>
                ) : (
                  fact.value
                ),
                mono: fact.mono,
                copy: fact.copy ? fact.value : undefined,
              }))}
            />
          </Section>
          <Show when={record().sshFingerprints.length > 0}>
            <Section icon="key" title={r().sshKeys} count={n(record().sshFingerprints.length)}>
              <Facts
                items={record().sshFingerprints.map((value, index) => ({ label: String(index + 1), value, mono: true, copy: value }))}
              />
            </Section>
          </Show>
        </Pane>
      </Pane.Split>
    </>
  );
  // the overview lists direct groups even while the address asks for inherited ones on the groups tab
  const directGroups = () => record().memberships.filter((group) => group.direct);

  const groups = () => (
    <>
      <Section
        icon="users-group"
        title={r().memberOf}
        count={n(record().memberships.length)}
        summary={
          props.recursive
            ? t().membershipsIncludingInherited({ count: record().memberships.length })
            : t().directMemberships({ count: record().memberships.length })
        }
        actions={[
          props.recursive
            ? { label: t().directOnly, icon: "git-branch", href: href("groups") }
            : { label: r().includeInherited, icon: "git-branch", href: href("groups", true) },
          addAction(),
        ]}
        more={moreOf("memberships", record().memberships.length)}
      >
        <Show when={record().memberships.length > 0} fallback={noGroups()}>
          {/* k2b-ui gap: virtualized list (lane MW); until then the rows come in steps of REVEAL. */}
          <For each={record().memberships.slice(0, shown().memberships)}>{(group) => groupRow(group, true)}</For>
        </Show>
      </Section>
      <Show when={record().managed.length > 0}>
        <Section
          icon="shield"
          title={t().manages}
          count={n(record().managed.length)}
          summary={t().manageableGroups({ count: record().managed.length })}
          more={moreOf("managed", record().managed.length)}
        >
          {/* k2b-ui gap: virtualized list (lane MW); until then the rows come in steps of REVEAL. */}
          <For each={record().managed.slice(0, shown().managed)}>{(group) => groupRow(group, false)}</For>
        </Section>
      </Show>
    </>
  );

  const keys = () => (
    <Section
      icon="key"
      title={t().apiKeys}
      count={n(record().keysTotal)}
      summary={t().personalAutomationKeys({ count: record().keysTotal })}
      more={{ label: t().viewAll, href: record().keysHref, forward: true }}
    >
      <Show when={record().keys.length > 0} fallback={<Empty icon="key" text={t().noActiveApiKeys} />}>
        <For each={record().keys}>
          {(entry) => (
            <Row
              icon="key"
              lines={[
                entry.name,
                [
                  r().keyLine({ prefix: entry.tokenPrefix, created: entry.created }),
                  entry.expires ? r().keyExpires({ date: entry.expires }) : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ]}
              meta={entry.modelsOnly ? t().modelsOnlyKey : undefined}
              time={entry.lastUsed ? r().usedOn({ date: entry.lastUsed }) : r().neverUsed}
              end={
                <Button
                  variant="ghost"
                  icon="key-off"
                  label={t().revokeApiKeyLabel({ name: entry.name })}
                  busy={busy() === `key:${entry.id}`}
                  onClick={() =>
                    void changed(
                      `key:${entry.id}`,
                      {
                        title: r().revokeKeyQuestion({ name: entry.name }),
                        description: r().revokeKeyConsequence,
                        confirm: t().revoke,
                        cancel: t().cancel,
                      },
                      () => revokeApiKey(entry.id, t()),
                    )
                  }
                />
              }
            />
          )}
        </For>
      </Show>
    </Section>
  );

  const devices = () => (
    <>
      <Section
        icon="login"
        title={t().cloudLogin}
        count={record().signInDevices?.length}
        summary={t().cloudLoginDescription}
        actions={
          record().signInPairHref ? [{ label: t().pairAppDevice, icon: "device-mobile", href: record().signInPairHref ?? "" }] : undefined
        }
      >
        <Switch>
          <Match when={record().signInDevices === null}>
            <Failed text={t().devicesUnavailable} onRetry={() => void showChanges()} />
          </Match>
          <Match when={record().signInDevices?.length === 0}>
            <Empty icon="device-mobile" text={t().noPairedDevices} />
          </Match>
          <Match when={record().signInDevices}>
            {(list) => (
              <For each={list()}>
                {(device) => (
                  <Row
                    icon="device-mobile"
                    lines={[
                      device.name,
                      [r().pairedOn({ date: device.paired }), device.assisted ? t().pairedWithAdmin : null].filter(Boolean).join(" · "),
                    ]}
                    time={device.lastUsed ? r().usedOn({ date: device.lastUsed }) : t().notUsedYet}
                    end={
                      <Button
                        variant="ghost"
                        icon="device-mobile-off"
                        label={t().revokeDeviceLabel({ name: device.name })}
                        busy={busy() === `device:${device.id}`}
                        onClick={() =>
                          void changed(
                            `device:${device.id}`,
                            {
                              title: r().revokeDeviceQuestion({ name: device.name }),
                              description: r().revokeDeviceConsequence,
                              confirm: t().revokeDevice,
                              cancel: t().cancel,
                            },
                            () => revokeSignInDevice(user().id, device.id, t()),
                          )
                        }
                      />
                    }
                  />
                )}
              </For>
            )}
          </Match>
        </Switch>
      </Section>
      <Section
        icon="apps"
        title={t().cloudApp}
        count={record().appDevices?.length}
        summary={t().cloudAppDescription({ cloud: record().cloudApp.cloud })}
        actions={[{ label: t().cloudAppPair, icon: "qrcode", onClick: pairing.start, disabled: record().cloudApp.blocked }]}
      >
        <Show when={record().cloudApp.blocked}>
          <Notice tone="warn" icon="lock">
            {t().cloudAppBlocked({ name: record().cloudApp.name })}
          </Notice>
        </Show>
        <Switch>
          <Match when={record().appDevices === null}>
            <Failed text={t().appDevicesUnavailable} onRetry={() => void showChanges()} />
          </Match>
          <Match when={record().appDevices?.length === 0}>
            <Empty icon="device-mobile" text={t().cloudAppEmpty} />
          </Match>
          <Match when={record().appDevices}>
            {(list) => (
              <For each={list()}>
                {(device) => (
                  <Row
                    icon={device.platform === "other" ? "device-tablet" : "device-mobile"}
                    lines={[device.name, [platformName(device.platform), r().pairedOn({ date: device.paired })].join(" · ")]}
                    time={r().usedOn({ date: device.lastUsed })}
                    end={
                      <Button
                        variant="ghost"
                        icon="device-mobile-off"
                        label={t().removeAppDeviceLabel({ name: device.name })}
                        busy={busy() === `app:${device.id}`}
                        onClick={() =>
                          void changed(
                            `app:${device.id}`,
                            {
                              title: r().removeAppDeviceQuestion({ name: device.name }),
                              description: r().removeAppDeviceConsequence,
                              confirm: t().removeAppDevice,
                              cancel: t().cancel,
                            },
                            () => removeAppDevice(user().id, device.id, t()),
                          )
                        }
                      />
                    }
                  />
                )}
              </For>
            )}
          </Match>
        </Switch>
      </Section>
    </>
  );
  const platformName = (platform: "ios" | "android" | "other") =>
    platform === "ios" ? t().platformIos : platform === "android" ? t().platformAndroid : t().platformOther;

  const areas: Record<UserTab, () => JSX.Element> = { overview, groups, keys, devices };
  const credential = () => {
    const open = dialog();
    return open.kind === "credential" ? open : null;
  };

  return (
    <Workspace
      sidebar={<AccountsNav active="users" pendingRequests={props.pendingRequests} />}
      head={
        <Bar
          start={
            <RecordHead
              name={record().title}
              avatar={{ name: record().title, image: record().image }}
              kinds={record().kinds}
              ids={[{ label: "UID", value: uid(), copy: true }]}
            />
          }
          end={<Menu label={t().userActions} items={menu()} />}
        />
      }
    >
      <Pane
        label={r().record}
        scrollKey="accounts-user-record"
        head={
          <Tabs
            label={r().areas}
            items={[
              { label: r().overview, icon: "layout-grid", href: href("overview"), current: props.tab === "overview" },
              {
                label: t().groups,
                icon: "users-group",
                count: n(record().directCount),
                href: href("groups", props.recursive),
                current: props.tab === "groups",
              },
              { label: t().apiKeys, icon: "key", count: n(record().keysTotal), href: href("keys"), current: props.tab === "keys" },
              { label: r().devices, icon: "devices", href: href("devices"), current: props.tab === "devices" },
            ]}
          />
        }
      >
        {areas[props.tab]()}
      </Pane>
      {/* each dialog starts fresh: it exists only while it is open */}
      <Show when={dialog().kind === "edit"}>
        <EditUserDialog user={user()} localEmailOptional={record().localEmailOptional} open close={closed} />
      </Show>
      <Show when={dialog().kind === "notify"}>
        <NotifyDialog
          user={user()}
          open
          close={(sent) => {
            setDialog({ kind: "none" });
            if (sent) toast(sent, { status: "ok" });
          }}
        />
      </Show>
      <Show when={dialog().kind === "expiry"}>
        <ExpiryDialog user={user()} open close={closed} />
      </Show>
      <Show when={dialog().kind === "groups"}>
        <AddToGroupsDialog user={user()} exclude={record().memberGroupIds} open close={closed} />
      </Show>
      <Show when={credential()}>
        {(open) => (
          <CredentialDialog
            open
            title={open().title}
            intro={open().intro}
            fields={open().fields}
            close={() => setDialog({ kind: "none" })}
          />
        )}
      </Show>
      {pairing.dialog()}
    </Workspace>
  );
}
