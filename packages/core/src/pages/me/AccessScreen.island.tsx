import { Button, Empty, Notice, Pane, Row, Section, Tiles } from "@k2b/ui/v2";
import { type JSX, Show } from "solid-js";
import AccountWorkspace, { sideWidth, useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import { useFreeIpaRequest } from "./freeipa-request";
import { ACCOUNT_KINDS } from "./kinds";
import type { ProfileActionsUser } from "./profile-actions";

type Group = { name: string; label: string; inherited: boolean };

export type AccessScreenProps = {
  user: AccountUserView;
  actionsUser: ProfileActionsUser;
  appName: string;
  /** Links into the Accounts app's groups while it runs. */
  accountsUi: boolean;
  showInherited: boolean;
  groups: Group[];
  managed: { name: string; label: string }[];
  /** The FreeIPA request part, absent where it is not offered; `pendingSince` while a request waits. */
  freeIpa: { pendingSince: string | null } | null;
};

/**
 * `/me/access` on v2: the person's groups by their part in them — the ones they manage, the ones they belong to, and
 * (on request) the ones they belong to through another group — and the FreeIPA account request beside them.
 * Data gap: a membership's start and who granted it are not in the account service's answer yet; each row shows the
 * group's name and the name other apps and the command line use for it.
 */
export default function AccessScreen(props: AccessScreenProps) {
  const t = useAccountMessages();
  const request = useFreeIpaRequest({
    givenname: props.actionsUser.givenname,
    sn: props.actionsUser.sn,
    displayName: props.actionsUser.displayName,
    appName: props.appName,
  });
  const groupHref = (scope: "member" | "managed", name: string) =>
    props.accountsUi ? `/app/accounts/groups?scope=${scope}&search=${encodeURIComponent(name)}` : undefined;
  // Each group stands once, in the place of its strongest part: managed before member before inherited.
  const managed = () => new Set(props.managed.map((group) => group.name));
  const direct = () => props.groups.filter((group) => !group.inherited && !managed().has(group.name));
  const inherited = () => props.groups.filter((group) => group.inherited && !managed().has(group.name));

  // Groups as cards side by side, so many groups fill the width instead of one thin column of names.
  const groups = (): JSX.Element => (
    <>
      <Show when={props.managed.length > 0}>
        <Section icon="user-shield" title={t().groupsYouManage} count={props.managed.length}>
          <Tiles
            variant="card"
            label={t().groupsYouManage}
            items={props.managed.map((group) => ({
              ...ACCOUNT_KINDS.managedGroup,
              title: group.label,
              meta: group.name,
              href: groupHref("managed", group.name),
            }))}
          />
        </Section>
      </Show>
      <Section
        icon="users-group"
        title={t().groupsMember}
        count={direct().length}
        actions={[
          {
            label: props.showInherited ? t().directOnly : t().showInherited,
            icon: "git-branch",
            href: props.showInherited ? "/me/access" : "/me/access?groups=all",
          },
        ]}
      >
        <Show when={direct().length > 0} fallback={<Empty icon="users-group" text={t().noGroups} />}>
          <Tiles
            variant="card"
            label={t().groupsMember}
            items={direct().map((group) => ({
              ...ACCOUNT_KINDS.group,
              title: group.label,
              meta: group.name,
              href: groupHref("member", group.name),
            }))}
          />
        </Show>
      </Section>
      <Show when={props.showInherited}>
        <Section icon="git-branch" title={t().groupsInherited} count={inherited().length}>
          <Show when={inherited().length > 0} fallback={<Empty icon="git-branch" text={t().noGroups} />}>
            <Tiles
              variant="card"
              label={t().groupsInherited}
              items={inherited().map((group) => ({
                ...ACCOUNT_KINDS.inheritedGroup,
                title: group.label,
                meta: group.name,
                href: groupHref("member", group.name),
              }))}
            />
          </Show>
        </Section>
      </Show>
    </>
  );

  return (
    <AccountWorkspace
      user={props.user}
      place="access"
      actions={
        <Show when={props.accountsUi}>
          <Button icon="users-group" href="/app/accounts/groups">
            {t().browseGroups}
          </Button>
        </Show>
      }
    >
      <Pane label={t().accessAndGroups}>
        {/* a side column only while it has something to hold: the FreeIPA account request */}
        <Show when={props.freeIpa} fallback={groups()}>
          {(freeIpa) => (
            <Pane.Split>
              <Pane label={t().groupMemberships}>{groups()}</Pane>
              <Pane side label={t().freeIpaAccount} width={sideWidth}>
                <Section icon="building-fortress" title={t().freeIpaAccount}>
                  <Show
                    when={freeIpa().pendingSince}
                    fallback={
                      <Row
                        mark={ACCOUNT_KINDS.freeIpa}
                        lines={[t().requestFreeIpaAccount, t().freeIpaAccountDescription]}
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
              </Pane>
            </Pane.Split>
          )}
        </Show>
      </Pane>
      {request.dialogs()}
    </AccountWorkspace>
  );
}
