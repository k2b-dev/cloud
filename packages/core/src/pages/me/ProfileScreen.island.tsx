import type { PrivacyTimerSeconds } from "@k2b/cloud/contracts/privacy-timer";
import type { KeyboardPlatform } from "@k2b/ui";
import { Button, Cells, Chip, Empty, Facts, Notice, Pane, Row, Section, Tiles } from "@k2b/ui/v2";
import { Show } from "solid-js";
import AccountWorkspace, { twoActions, useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import { useFreeIpaRequest } from "./freeipa-request";
import { ACCOUNT_KINDS } from "./kinds";
import { type ProfileActionsUser, useProfileActions } from "./profile-actions";
import ScreenSection from "./ScreenSection";

type Fact = { label: string; value: string };
type Group = { name: string; label: string; part: "managed" | "member" | "inherited" };
/** A key figure of the first row: its value, a line under it, and a state when it asks for something. */
type Figure = { value: string; meta: string; status?: "warn" | "bad" };

export type ProfileScreenProps = {
  user: AccountUserView;
  actionsUser: ProfileActionsUser;
  appName: string;
  freeIpaEnabled: boolean;
  /** `?action=extend`: the expiry notice's deed is what the person came for. */
  extendHint: boolean;
  /** The account's expiry as the server read it, with its date formatted; null without an expiry. */
  expiry: { title: string; tone: "bad" | "warn" | "note"; before: string } | null;
  /**
   * The person's groups, each once in the place of its strongest part (managed, member, inherited): the first six, or
   * every one with the inherited ones on "All groups" (`?groups=all`). Links into the Accounts app while it runs.
   */
  groups: { items: Group[]; all: boolean; accountsUi: boolean };
  /** The FreeIPA account request, absent where it is not offered; `pendingSince` while a request waits. */
  freeIpa: { pendingSince: string | null } | null;
  limitedAccess: boolean;
  profileFacts: Fact[];
  accountFacts: Fact[];
  screen: {
    timerSeconds: PrivacyTimerSeconds;
    platform: KeyboardPlatform;
    sharedWorkstation?: { userId: string; minutes: number };
  };
  /** The first row: how long the account lasts, how the person signs in, their groups and their keys. */
  figures: Record<"validity" | "passkeys" | "groups" | "apiKeys", Figure>;
};

/** `/me` on v2: the person's identity, what to know about the account, the screen settings and the other sections. */
export default function ProfileScreen(props: ProfileScreenProps) {
  const t = useAccountMessages();
  const actions = useProfileActions({ user: props.actionsUser, appName: props.appName, freeIpaEnabled: props.freeIpaEnabled });
  const profileActions = () => {
    const edit = actions.editProfile;
    const details = actions.editDetails;
    return twoActions([
      ...(edit ? [{ label: t().editProfile, icon: "pencil", onClick: edit }] : []),
      ...(details ? [{ label: t().contactAndSshDetails, icon: "address-book", onClick: details }] : []),
    ]);
  };
  const extendAction = () => {
    const extend = actions.extend;
    return extend
      ? ([{ label: actions.extending() ? t().extending : t().extendAccount, icon: "calendar-plus", onClick: extend }] as const)
      : undefined;
  };
  // An expiry far away is a fact of the first row; only a near or passed one becomes a notice with its deed.
  const urgentExpiry = () => {
    const expiry = props.expiry;
    return expiry && expiry.tone !== "note" ? expiry : null;
  };
  const request = useFreeIpaRequest({
    givenname: props.actionsUser.givenname,
    sn: props.actionsUser.sn,
    displayName: props.actionsUser.displayName,
    appName: props.appName,
  });
  const groupHref = (group: Group) =>
    props.groups.accountsUi
      ? `/app/accounts/groups?scope=${group.part === "managed" ? "managed" : "member"}&search=${encodeURIComponent(group.name)}`
      : undefined;
  const groupKind = { managed: ACCOUNT_KINDS.managedGroup, member: ACCOUNT_KINDS.group, inherited: ACCOUNT_KINDS.inheritedGroup };
  const groupMeta = (group: Group) =>
    group.part === "managed" ? t().groupsYouManage : group.part === "inherited" ? t().groupsInherited : t().groupsMember;
  const value = (figure: Figure) => (figure.status ? <Chip status={figure.status}>{figure.value}</Chip> : figure.value);

  return (
    <AccountWorkspace
      user={props.user}
      place="profile"
      actions={
        <Button icon="camera" onClick={actions.changeAvatar}>
          {t().changeAvatar}
        </Button>
      }
    >
      <Pane label={t().profile}>
        <Show when={props.extendHint}>
          <Notice tone="note" icon="info-circle">
            {t().extendHint}
          </Notice>
        </Show>
        <Show when={urgentExpiry()}>
          {(expiry) => (
            <Notice tone={expiry().tone} icon="calendar-time" title={expiry().title} actions={extendAction()}>
              {expiry().before}
            </Notice>
          )}
        </Show>
        <Show when={props.limitedAccess}>
          <Notice tone="note" icon="info-circle">
            {t().limitedAccess}
          </Notice>
        </Show>
        <Cells>
          <Cells.Cell
            icon="calendar-time"
            label={t().validUntil}
            value={value(props.figures.validity)}
            meta={props.figures.validity.meta}
          />
          <Cells.Cell
            icon="fingerprint"
            color={ACCOUNT_KINDS.passkey.color}
            label={t().passkeys}
            value={value(props.figures.passkeys)}
            meta={props.figures.passkeys.meta}
            href="/me/security"
          />
          <Cells.Cell
            icon="users-group"
            color={ACCOUNT_KINDS.group.color}
            label={t().groups}
            value={value(props.figures.groups)}
            meta={props.figures.groups.meta}
            href="#groups"
          />
          <Cells.Cell
            icon="key"
            color={ACCOUNT_KINDS.apiKey.color}
            label={t().apiKeys}
            value={value(props.figures.apiKeys)}
            meta={props.figures.apiKeys.meta}
            href="/me/security"
          />
        </Cells>
        {/* one column: what the person is, what the account is, how the screen behaves; no half-empty side column */}
        <Section icon="user" title={t().profileTitle} actions={profileActions()}>
          <Facts items={props.profileFacts} />
        </Section>
        <Section icon="id" title={t().accountFacts} actions={urgentExpiry() ? undefined : extendAction()}>
          <Facts items={props.accountFacts} />
        </Section>
        {/* groups as cards side by side, so many groups fill the width instead of one thin column of names */}
        <Section
          id="groups"
          icon="users-group"
          title={t().groups}
          actions={props.groups.accountsUi ? [{ label: t().browseGroups, icon: "users-group", href: "/app/accounts/groups" }] : undefined}
          more={
            props.groups.all
              ? { label: t().firstGroups, icon: "chevron-up", href: "/me#groups" }
              : { label: t().allGroups, href: "/me?groups=all#groups" }
          }
        >
          <Show when={props.groups.items.length > 0} fallback={<Empty icon="users-group" text={t().noGroups} />}>
            <Tiles
              variant="card"
              label={t().groups}
              items={props.groups.items.map((group) => ({
                ...groupKind[group.part],
                title: group.label,
                meta: groupMeta(group),
                href: groupHref(group),
              }))}
            />
          </Show>
        </Section>
        <Show when={props.freeIpa}>
          {(freeIpa) => (
            <Section id="freeipa" icon="building-fortress" title={t().freeIpaAccount}>
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
          )}
        </Show>
        <ScreenSection
          timerSeconds={props.screen.timerSeconds}
          platform={props.screen.platform}
          sharedWorkstation={props.screen.sharedWorkstation}
        />
      </Pane>
      {actions.dialogs()}
      {request.dialogs()}
    </AccountWorkspace>
  );
}
