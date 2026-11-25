import type { PrivacyTimerSeconds } from "@k2b/cloud/contracts/privacy-timer";
import type { KeyboardPlatform } from "@k2b/ui";
import { Button, Cells, Empty, Facts, Notice, Pane, Row, Section } from "@k2b/ui/v2";
import { For, Show } from "solid-js";
import AccountWorkspace, { twoActions, useAccountMessages } from "./AccountWorkspace";
import type { AccountUserView } from "./account-view";
import { type ProfileActionsUser, useProfileActions } from "./profile-actions";
import ScreenSection from "./ScreenSection";

type Fact = { label: string; value: string };

export type ProfileScreenProps = {
  user: AccountUserView;
  appTab: boolean;
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
  /** One line per other account section, as the server counted it. */
  summaries: Record<"security" | "access" | "notifications" | "developer", { value: string; meta: string }>;
  /** The newest few entries of the account's activity, with their time formatted relative to the page's time. */
  activity: { label: string; context: string; when: string }[];
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

  return (
    <AccountWorkspace
      user={props.user}
      active="profile"
      appTab={props.appTab}
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
        <Show when={props.expiry}>
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
            icon="shield-lock"
            label={t().security}
            value={props.summaries.security.value}
            meta={props.summaries.security.meta}
            href="/me/security"
          />
          <Cells.Cell
            icon="users-group"
            label={t().accessAndGroups}
            value={props.summaries.access.value}
            meta={props.summaries.access.meta}
            href="/me/access"
          />
          <Cells.Cell
            icon="bell"
            label={t().notifications}
            value={props.summaries.notifications.value}
            meta={props.summaries.notifications.meta}
            href="/me/notifications"
          />
          <Cells.Cell
            icon="terminal-2"
            label={t().developer}
            value={props.summaries.developer.value}
            meta={props.summaries.developer.meta}
            href="/me/developer"
          />
        </Cells>
        <Section icon="user" title={t().profileTitle} summary={t().profileDescription} actions={profileActions()}>
          <Facts items={props.profileFacts} />
        </Section>
        <Section icon="id" title={t().accountFacts} summary={t().accountFactsDescription}>
          <Facts items={props.accountFacts} />
        </Section>
        <ScreenSection
          timerSeconds={props.screen.timerSeconds}
          platform={props.screen.platform}
          sharedWorkstation={props.screen.sharedWorkstation}
        />
        <Section
          icon="activity"
          title={t().recentSecurityActivity}
          summary={t().recentSecurityActivityDescription}
          more={{ label: t().viewAll, href: "/me/security", forward: true }}
        >
          <Show when={props.activity.length > 0} fallback={<Empty icon="clipboard-list" text={t().noRecentAccountActivity} />}>
            <For each={props.activity}>{(entry) => <Row icon="shield-check" lines={[entry.label, entry.context]} time={entry.when} />}</For>
          </Show>
        </Section>
      </Pane>
      {actions.dialogs()}
    </AccountWorkspace>
  );
}
