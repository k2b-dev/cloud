import { Button, Empty, Notice, Pane, Row, Section } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import AccountWorkspace, { AccountTabs, sideWidth, useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import { useFreeIpaRequest } from "./freeipa-request";
import { type ProfileActionsUser, useProfileActions } from "./profile-actions";

type Group = { name: string; label: string; inherited: boolean };

export type AccessScreenProps = {
  user: AccountUserView;
  actionsUser: ProfileActionsUser;
  appName: string;
  freeIpaEnabled: boolean;
  /** Links into the Accounts app's groups while it runs. */
  accountsUi: boolean;
  showInherited: boolean;
  groups: Group[];
  managed: { name: string; label: string }[];
  /** The FreeIPA request part, absent where it is not offered; `pendingSince` while a request waits. */
  freeIpa: { pendingSince: string | null } | null;
};

/** `/me/access` on v2: the groups the person belongs to and manages, and the FreeIPA account request. */
export default function AccessScreen(props: AccessScreenProps) {
  const t = useAccountMessages();
  const actions = useProfileActions({
    user: props.actionsUser,
    appName: props.appName,
    freeIpaEnabled: props.freeIpaEnabled,
    details: false,
  });
  const request = useFreeIpaRequest({
    givenname: props.actionsUser.givenname,
    sn: props.actionsUser.sn,
    displayName: props.actionsUser.displayName,
    appName: props.appName,
  });
  const groupHref = (scope: "member" | "managed", name: string) =>
    props.accountsUi ? `/app/accounts/groups?scope=${scope}&search=${encodeURIComponent(name)}` : undefined;
  return (
    <AccountWorkspace
      user={props.user}
      place="account"
      actions={
        <>
          <Show when={props.accountsUi}>
            <Button icon="users-group" href="/app/accounts/groups">
              {t().browseGroups}
            </Button>
          </Show>
          <Show when={actions.extend}>
            {(extend) => (
              <Button icon="calendar-plus" busy={actions.extending()} onClick={extend()}>
                {t().extendAccount}
              </Button>
            )}
          </Show>
        </>
      }
    >
      <Pane label={t().accessAndGroups} head={<AccountTabs active="access" />}>
        <Pane.Split>
          <Pane label={t().groupMemberships}>
        <Section
          icon="users-group"
          title={t().groupMemberships}
          count={props.groups.length}
          summary={t().groupMembershipsDescription}
          actions={[
            {
              label: props.showInherited ? t().directOnly : t().showInherited,
              icon: "git-branch",
              href: props.showInherited ? "/me/access" : "/me/access?groups=all",
            },
          ]}
        >
          <Show when={props.groups.length > 0} fallback={<Empty icon="users-group" text={t().noGroups} />}>
            <For each={props.groups}>
              {(group) => (
                <Row
                  icon={group.inherited ? "git-branch" : "users"}
                  lines={[group.label]}
                  meta={group.inherited ? t().inheritedMembership : undefined}
                  href={groupHref("member", group.name)}
                />
              )}
            </For>
          </Show>
        </Section>
          </Pane>
          <Pane side label={t().delegatedManagement} width={sideWidth}>
        <Section
          icon="user-shield"
          title={t().delegatedManagement}
          count={props.managed.length}
          summary={t().delegatedManagementDescription}
        >
          <Show when={props.managed.length > 0} fallback={<Empty icon="user-shield" text={t().noManagedGroups} />}>
            <For each={props.managed}>{(group) => <Row icon="users" lines={[group.label]} href={groupHref("managed", group.name)} />}</For>
          </Show>
        </Section>
        <Show when={props.freeIpa}>
          {(freeIpa) => (
            <Section icon="building-fortress" title={t().freeIpaAccount} summary={t().freeIpaAccountDescription}>
              <Show
                when={freeIpa().pendingSince}
                fallback={
                  <Row
                    icon="building-fortress"
                    lines={[t().requestFreeIpaAccount]}
                    action={{ label: t().requestFreeIpaAccount, onClick: request.request }}
                  />
                }
              >
                {(since) => (
                  <Notice
                    tone="note"
                    icon="hourglass"
                    actions={[
                      {
                        label: request.withdrawing() ? t().withdrawing : t().withdrawRequest,
                        icon: "x",
                        disabled: request.withdrawing(),
                        onClick: request.withdraw,
                      },
                    ]}
                  >
                    {t().requestPendingSince({ date: since() })}
                  </Notice>
                )}
              </Show>
            </Section>
          )}
        </Show>
          </Pane>
        </Pane.Split>
      </Pane>
      {actions.dialogs()}
      {request.dialogs()}
    </AccountWorkspace>
  );
}
