import { useLocale } from "@k2b/ui";
import { Empty, Notice, NoticeStack } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { shellMessages } from "../../messages";
import { watchPairingLink } from "../phone";
import StartParts, { type StartPart } from "./StartParts";

export type StartScreenProps = {
  /** The app's parts for this person. */
  parts: StartPart[];
  /** The summary and badge routes the parts read. */
  endpoints: string[];
  /** The signed-in person, which explains why a pairing link does not pair again. */
  name: string;
};

/**
 * The content of Start on v2, inside the app's frame: the parts with what waits in them. The frame brings the head and
 * the way to Settings; a blocked or unreachable app has islands of its own, so Start loads none of their code.
 */
export default function StartScreen(props: StartScreenProps) {
  const locale = useLocale();
  const t = () => shellMessages.resolve([locale()]).t;
  const [connected, setConnected] = createSignal(false);

  // A pairing link in the address of a connected app: it says why it does not pair again.
  onMount(() => onCleanup(watchPairingLink(() => setConnected(true))));

  return (
    <>
      <Show when={props.parts.length > 0} fallback={<Empty icon="apps" text={t().noApps} />}>
        <StartParts parts={props.parts} label={t().apps} endpoints={props.endpoints} />
      </Show>
      {/* what comes after the page has drawn floats over it, so nothing on the page moves */}
      <NoticeStack>
        <Show when={connected()}>
          <Notice tone="note" icon="info-circle" actions={[{ label: t().hide, onClick: () => setConnected(false) }]}>
            {t().alreadyConnected({ name: props.name })}
          </Notice>
        </Show>
      </NoticeStack>
    </>
  );
}
