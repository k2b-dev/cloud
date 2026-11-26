import { PWA_SCOPE } from "@k2b/cloud/contracts";
import { useLocale } from "@k2b/ui";
import { Bar, Button, Empty, Notice, Pane, Text, Workspace } from "@k2b/ui/v2";
import { createSignal, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { shellMessages } from "../../messages";
import { watchPairingLink } from "../phone";
import { confirmWithBack } from "./confirm-with-back";
import StartParts, { type StartPart } from "./StartParts";
import { signOutOfApp } from "./sign-out";
import Unavailable from "./Unavailable";

export type StartView =
  /** The app's parts for this person; `name` explains why a pairing link does not pair again. */
  | { kind: "parts"; parts: StartPart[]; endpoints: string[]; name: string }
  /** This account may not use the app now. */
  | { kind: "blocked" }
  /** The launch could not renew the app session. */
  | { kind: "unavailable" };

/**
 * Start of the installable app on v2: the parts of the app with what waits in them, or why the app cannot open now.
 * The page is bare: its own workspace with the installation's name in the head and Settings at its end.
 */
export default function StartScreen(props: { cloud: string; view: StartView }) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  const [problem, setProblem] = createSignal<string>();
  const [connected, setConnected] = createSignal(false);

  // A pairing link in the address of a page that does not pair: a connected app says why it does not pair again.
  onMount(() => {
    onCleanup(
      watchPairingLink(() => {
        if (props.view.kind === "parts") setConnected(true);
      }),
    );
  });

  const signOut = async () => {
    const agreed = await confirmWithBack({
      title: t().signOut,
      description: t().signOutConfirm({ cloud: props.cloud }),
      confirm: t().signOut,
    });
    if (!agreed) return;
    setProblem(await signOutOfApp(t()));
  };

  return (
    <Workspace
      head={
        <Bar
          start={<Text type="lead">{props.cloud}</Text>}
          end={
            <Show when={props.view.kind === "parts"}>
              <Button variant="ghost" icon="settings" label={t().settings} href={`${PWA_SCOPE}settings`} keep />
            </Show>
          }
        />
      }
    >
      <Pane label={props.cloud}>
        <Show when={connected() && props.view.kind === "parts" && props.view}>
          {(view) => (
            <Notice tone="note" icon="info-circle">
              {t().alreadyConnected({ name: view().name })}
            </Notice>
          )}
        </Show>
        <Show when={problem()}>{(text) => <Notice tone="bad">{text()}</Notice>}</Show>
        <Switch>
          <Match when={props.view.kind === "parts" && props.view}>
            {(view) => (
              <Show when={view().parts.length > 0} fallback={<Empty icon="apps" text={`${t().noApps} ${t().noAppsDescription}`} />}>
                <StartParts parts={view().parts} label={t().apps} endpoints={view().endpoints} />
              </Show>
            )}
          </Match>
          <Match when={props.view.kind === "blocked"}>
            <Empty
              icon="lock"
              text={`${t().blocked} ${t().blockedDetail}`}
              action={{ label: t().signOut, icon: "logout", onClick: () => void signOut() }}
            />
          </Match>
          <Match when={props.view.kind === "unavailable"}>
            <Unavailable cloud={props.cloud} />
          </Match>
        </Switch>
      </Pane>
    </Workspace>
  );
}
