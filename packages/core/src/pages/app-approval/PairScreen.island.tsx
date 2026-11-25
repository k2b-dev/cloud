import { useLocale } from "@k2b/ui";
import { Bar, Button, Pane, Text, Workspace } from "@k2b/ui/v2";
import { type JSX, onMount, Show } from "solid-js";
import AccountWorkspace, { AccountTabs } from "../me/AccountWorkspace";
import type { AccountUserView } from "../me/account-view";
import ApprovalNotice from "./ApprovalNotice";
import type { ApprovalAvailability } from "./availability";
import { appApprovalMessages } from "./messages";
import Pairing from "./Pairing";

export type PairScreenProps = {
  /** The signed-in person pairs their own device: the account frame stands around it. Absent for an administrator. */
  self: { user: AccountUserView } | null;
  userId: string;
  actorId: string;
  name: string;
  /** Set while the sign-in app is configured; otherwise the page says why pairing is not possible. */
  pairing: { appOrigin: string; install: boolean } | null;
  availability: ApprovalAvailability;
  admin: boolean;
  returnTo: string;
};

/**
 * `/me/security/pair` on v2: the pairing dialog over the page it returns to. Closing it goes back to `returnTo`; the
 * page has continued after identity confirmation, so a reload or going back starts over with the install step.
 */
export default function PairScreen(props: PairScreenProps) {
  const locale = useLocale();
  const t = () => appApprovalMessages.resolve([locale()]).t;
  onMount(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("pairDevice")) return;
    url.searchParams.delete("pairDevice");
    url.searchParams.delete("reauthenticate");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  });
  const content = (): JSX.Element => (
    <Show
      when={props.pairing}
      fallback={
        <>
          <ApprovalNotice state={props.availability} admin={props.admin} settingsLink={props.admin} />
          <Bar end={<Button href={props.returnTo}>{t().back}</Button>} />
        </>
      }
    >
      {(pairing) => (
        <>
          <Text muted>{t().description}</Text>
          <Pairing
            userId={props.userId}
            actorId={props.actorId}
            name={props.name}
            appOrigin={pairing().appOrigin}
            install={pairing().install}
            returnTo={`/me/security/pair?${new URLSearchParams({ userId: props.userId })}`}
            onClose={() => window.location.assign(props.returnTo)}
          />
        </>
      )}
    </Show>
  );
  return (
    <Show
      when={props.self}
      fallback={
        <Workspace head={<Bar start={<Text type="body">{t().pairFor({ name: props.name })}</Text>} />}>
          <Pane label={t().pair}>{content()}</Pane>
        </Workspace>
      }
    >
      {(self) => (
        <AccountWorkspace user={self().user} place="account">
          <Pane label={t().pair} head={<AccountTabs active="security" />}>
            {content()}
          </Pane>
        </AccountWorkspace>
      )}
    </Show>
  );
}
