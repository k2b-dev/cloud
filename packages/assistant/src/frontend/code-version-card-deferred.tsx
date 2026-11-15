import { importOnDemand } from "@k2b/cloud/browser/reload";
import { Button, Skeleton, useLocale } from "@k2b/ui";
import { type ComponentProps, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import { codeVersionCardAnchor } from "./code-version-anchor";
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
        <div
          class="assistant-code-version__placeholder"
          data-chat-anchor={codeVersionCardAnchor(props.versionId)}
          role="status"
          aria-busy={failed() ? undefined : "true"}
          aria-label={t().loading}
        >
          <Show
            when={failed()}
            fallback={
              <div class="assistant-code-version__loading">
                <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--label" />
                <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--sentence" />
                <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--reason" />
                <div class="assistant-code-version__skeleton-details">
                  <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--label" />
                  <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--row" />
                  <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--row" />
                  <Skeleton class="assistant-code-version__skeleton assistant-code-version__skeleton--short" />
                </div>
              </div>
            }
          >
            <p class="assistant-code-version__placeholder-failed">
              {t().lineNotLoaded}{" "}
              <Button size="sm" variant="secondary" onClick={() => void load()}>
                {t().retry}
              </Button>
            </p>
          </Show>
        </div>
      }
    >
      {(Card) => <Dynamic component={Card()} {...props} />}
    </Show>
  );
}
