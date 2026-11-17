import { importOnDemand } from "@k2b/cloud/browser/reload";
import { useLocale } from "@k2b/ui";
import { type ComponentProps, createMemo, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { useAssistantLive } from "./assistant-live";
import { type CodeVersionCardAction, describeCodeVersionCard } from "./code-version-card-state";
import { createCodeVersionCardStore } from "./code-version-card-store";
import { CodeVersionCardView } from "./code-version-card-view";

type CardProps = ComponentProps<typeof import("./AssistantCodeVersionCard").default>;
const loadCard = () => import("./AssistantCodeVersionCard").then((module) => module.default);

/** SSR and the first browser render use the same authorized snapshot; only the interaction controller is deferred. */
export function AssistantCodeVersionCard(props: CardProps): JSX.Element {
  const locale = useLocale();
  const store = props.store ?? createCodeVersionCardStore(useAssistantLive());
  const ref = { codeId: props.codeId, versionId: props.versionId };
  const release = store.retain(ref);
  onCleanup(release);
  const [card, setCard] = createSignal<Awaited<ReturnType<typeof loadCard>>>();
  const [failed, setFailed] = createSignal(false);
  const [initialAction, setInitialAction] = createSignal<CodeVersionCardAction["id"]>();
  let active = true;
  onCleanup(() => {
    active = false;
  });
  const load = async () => {
    setFailed(false);
    const loaded = await importOnDemand(loadCard);
    if (!active) return;
    if (loaded) setCard(() => loaded);
    else setFailed(true);
  };
  const model = createMemo(() =>
    describeCodeVersionCard({
      value: failed() ? "failed" : store.read(ref),
      version: props.number,
      versionId: props.versionId,
      locale: locale(),
      timeZone: props.timeZone,
      activation: { kind: "idle" },
      nextRun: null,
      canAsk: Boolean(props.onAsk),
    }),
  );
  onMount(() => void load());
  return (
    <Show
      when={card()}
      fallback={
        <CodeVersionCardView
          model={model()}
          anchorId={`code-version-${props.versionId}`}
          onAction={(action) => {
            setInitialAction(action);
            void load();
          }}
        />
      }
    >
      {(Card) => <Dynamic component={Card()} {...props} store={store} initialAction={initialAction()} />}
    </Show>
  );
}
