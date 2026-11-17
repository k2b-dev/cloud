import { importOnDemand } from "@k2b/cloud/browser/reload";
import { Button, NoticeCard, useLocale } from "@k2b/ui";
import { type ComponentProps, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { codeVersionCardMessages } from "./code-version-card-messages";

type CardProps = ComponentProps<typeof import("./AssistantCodeVersionCard").default>;
const loadCard = () => import("./AssistantCodeVersionCard").then((module) => module.default);

/**
 * The version card loads with its first use, so its code stays out of the workspace's first download. Until then it
 * holds the card's own room with the same placeholder the card shows while it reads its state, so nothing moves.
 */
export function AssistantCodeVersionCard(props: CardProps): JSX.Element {
  const locale = useLocale();
  const t = () => codeVersionCardMessages.resolve([locale()]).t;
  const [card, setCard] = createSignal<Awaited<ReturnType<typeof loadCard>>>();
  const [failed, setFailed] = createSignal(false);
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
  onMount(() => void load());
  return (
    <Show
      when={card()}
      fallback={
        <div class="assistant-code-version-host">
          <NoticeCard
            class="assistant-code-version"
            tone="neutral"
            icon="ti ti-shield-check"
            layout="card"
            data-k2b-primary="ai"
            data-chat-anchor={`code-version-${props.versionId}`}
            tabIndex={-1}
            aria-busy={failed() ? undefined : "true"}
            title={<span role={failed() ? "alert" : "status"}>{failed() ? t().lineNotLoaded : t().loading}</span>}
            actions={
              failed() ? (
                <div class="assistant-code-version__actions">
                  <div class="assistant-code-version__action">
                    <Button size="md" variant="secondary" data-code-version-primary onClick={() => void load()}>
                      {t().retry}
                    </Button>
                  </div>
                </div>
              ) : undefined
            }
          >
            <p class="assistant-code-version__quiet">{""}</p>
          </NoticeCard>
        </div>
      }
    >
      {(Card) => <Dynamic component={Card()} {...props} />}
    </Show>
  );
}
