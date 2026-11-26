import type { PrivacyTimerSeconds } from "@k2b/cloud/contracts/privacy-timer";
import type { KeyboardPlatform } from "@k2b/ui";
import { Button, Cells, Chip, Facts, Notice, Pane, Section } from "@k2b/ui/v2";
import { Show } from "solid-js";
import AccountWorkspace, { sideWidth, twoActions, useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import { ACCOUNT_KINDS } from "./kinds";
import { type ProfileActionsUser, useProfileActions } from "./profile-actions";
import ScreenSection from "./ScreenSection";

type Fact = { label: string; value: string };
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
  /** The pending FreeIPA request's sentence, or null. */
  pendingRequest: string | null;
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
        <Show when={props.pendingRequest}>
          {(sentence) => (
            <Notice
              tone="note"
              icon="hourglass"
              title={t().requestPending}
              actions={[{ label: t().access, href: "/me/access", forward: true }]}
            >
              {sentence()}
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
            href="/me/access"
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
        <Pane.Split>
          <Pane label={t().profileTitle}>
            <Section icon="user" title={t().profileTitle} actions={profileActions()}>
              <Facts items={props.profileFacts} />
            </Section>
            <Section icon="id" title={t().accountFacts} actions={urgentExpiry() ? undefined : extendAction()}>
              <Facts items={props.accountFacts} />
            </Section>
          </Pane>
          <Pane side label={t().screenTitle} width={sideWidth}>
            <ScreenSection
              timerSeconds={props.screen.timerSeconds}
              platform={props.screen.platform}
              sharedWorkstation={props.screen.sharedWorkstation}
            />
          </Pane>
        </Pane.Split>
      </Pane>
      {actions.dialogs()}
    </AccountWorkspace>
  );
}
