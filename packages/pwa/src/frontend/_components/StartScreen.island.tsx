import { useLocale } from "@k2b/ui";
import { Empty, Notice, NoticeStack } from "@k2b/ui/v2";
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
 * The content of Start on v2, inside the app's frame: the parts with what waits in them, or why the app cannot open
 * now. The frame brings the head and the way to Settings.
 */
export default function StartScreen(props: { cloud: string; view: StartView }) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  const [problem, setProblem] = createSignal<string>();
  const [connected, setConnected] = createSignal(false);
  const [signingOut, setSigningOut] = createSignal(false);

  // A pairing link in the address of a page that does not pair: a connected app says why it does not pair again.
  onMount(() => {
    onCleanup(
      watchPairingLink(() => {
        if (props.view.kind === "parts") setConnected(true);
      }),
    );
  });

  // one question and one request at a time, however often the button is pressed
  const signOut = async () => {
    if (signingOut()) return;
    setSigningOut(true);
    const agreed = await confirmWithBack({
      title: t().signOut,
      description: t().signOutConfirm({ cloud: props.cloud }),
      confirm: t().signOut,
    });
    const failed = agreed ? await signOutOfApp(t()) : undefined;
    setProblem(failed);
    if (!agreed || failed) setSigningOut(false);
  };

  return (
    <>
      <Switch>
        <Match when={props.view.kind === "parts" && props.view}>
          {(view) => (
            <Show when={view().parts.length > 0} fallback={<Empty icon="apps" text={t().noApps} />}>
              <StartParts parts={view().parts} label={t().apps} endpoints={view().endpoints} />
            </Show>
          )}
        </Match>
        <Match when={props.view.kind === "blocked"}>
          <Empty
            icon="lock"
            tone="bad"
            text={t().blocked}
            action={{ label: t().signOut, icon: "logout", disabled: signingOut(), onClick: () => void signOut() }}
          />
        </Match>
        <Match when={props.view.kind === "unavailable"}>
          <Unavailable cloud={props.cloud} />
        </Match>
      </Switch>
      {/* what comes after the page has drawn floats over it, so nothing on the page moves */}
      <NoticeStack>
        <Show when={connected() && props.view.kind === "parts" && props.view}>
          {(view) => (
            <Notice tone="note" icon="info-circle" actions={[{ label: t().hide, onClick: () => setConnected(false) }]}>
              {t().alreadyConnected({ name: view().name })}
            </Notice>
          )}
        </Show>
        <Show when={problem()}>
          {(text) => (
            <Notice tone="bad" actions={[{ label: t().hide, onClick: () => setProblem(undefined) }]}>
              {text()}
            </Notice>
          )}
        </Show>
      </NoticeStack>
    </>
  );
}
