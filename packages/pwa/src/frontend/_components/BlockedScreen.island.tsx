import { useLocale } from "@k2b/ui";
import { Empty, Notice, NoticeStack } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { shellMessages } from "../../messages";
import { watchPairingLink } from "../phone";
import { askToSignOut, signOutOfApp } from "./sign-out";

/** This account may not use the app now: why, in one sentence, and signing out of the app. */
export default function BlockedScreen(props: { cloud: string }) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  const [problem, setProblem] = createSignal<string>();
  const [signingOut, setSigningOut] = createSignal(false);

  // a pairing link is dropped here: a blocked account pairs nothing
  onMount(() => onCleanup(watchPairingLink(() => undefined)));

  // one question and one request at a time, however often the button is pressed; the question loads when asked
  const signOut = async () => {
    if (signingOut()) return;
    setSigningOut(true);
    // a question that cannot load says so; the button works again
    const agreed = await askToSignOut(t(), props.cloud).catch(() => null);
    const failed = agreed === null ? t().failed : agreed ? await signOutOfApp(t()) : undefined;
    setProblem(failed);
    if (!agreed || failed) setSigningOut(false);
  };

  return (
    <>
      <Empty
        icon="lock"
        tone="bad"
        text={t().blocked}
        action={{ label: t().signOut, icon: "logout", disabled: signingOut(), onClick: () => void signOut() }}
      />
      <NoticeStack>
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
