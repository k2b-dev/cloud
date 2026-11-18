import { documentNavigate } from "@k2b/ssr/nav";
import { Button, ButtonLink, type ButtonVariant, NoticeCard, SplitButton, useLocale } from "@k2b/ui";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import { codeVersionCardCopy } from "./code-version-card-copy";
import type { CodeVersionCardAction, CodeVersionCardModel } from "./code-version-card-state";

/** The one v10 surface. Buttons keep their public appearance, loading, focus and menu contracts. */
export function CodeVersionCardView(props: {
  model: CodeVersionCardModel;
  ref?: (element: HTMLDivElement) => void;
  anchorId: string;
  onAction: (action: CodeVersionCardAction["id"]) => void;
}) {
  const locale = useLocale();
  let host: HTMLDivElement | undefined;
  const [phone, setPhone] = createSignal(false);
  onMount(() => {
    const observer = new ResizeObserver(([entry]) => setPhone((entry?.contentRect.width ?? 0) <= 560));
    if (host) observer.observe(host);
    onCleanup(() => observer.disconnect());
  });
  const c = () => codeVersionCardCopy.resolve([locale()]).t;
  const control = (action: CodeVersionCardAction, primary: boolean): JSX.Element => {
    const common = {
      get size(): "sm" | "md" {
        return phone() ? "md" : "sm";
      },
      get variant(): ButtonVariant {
        return primary ? (action.filled ? "ai" : "secondary") : phone() ? "secondary" : "link";
      },
      wrap: true,
      "data-code-version-primary": primary ? "" : undefined,
    };
    if (action.id === "open" && (props.model.pages?.length ?? 0) > 1)
      return (
        <SplitButton
          {...common}
          onClick={() => action.href && documentNavigate(action.href)}
          items={[
            {
              sectionLabel: phone() ? c().morePages : undefined,
              items: props.model
                .pages!.filter((page) => page.href !== action.href)
                .map((page, index) => ({
                  label: page.title ?? (page.isRoot ? c().home : c().page({ number: index + 2 })),
                  href: page.href,
                })),
            },
          ]}
          menuLabel={c().morePages}
          phone="sheet"
        >
          {action.label}
        </SplitButton>
      );
    if (action.href)
      return (
        <ButtonLink {...common} href={action.href}>
          {action.label}
        </ButtonLink>
      );
    return (
      <Button {...common} disabled={action.disabled} loading={action.busy} onClick={() => props.onAction(action.id)}>
        {action.label}
      </Button>
    );
  };
  const actions = () => (
    <div class="assistant-code-version__actions">
      <Show when={props.model.secondary}>{(action) => <div class="assistant-code-version__action">{control(action(), false)}</div>}</Show>
      <Show when={props.model.primary}>{(action) => <div class="assistant-code-version__action">{control(action(), true)}</div>}</Show>
    </div>
  );
  return (
    <div
      class="assistant-code-version-host"
      ref={(element) => {
        host = element;
        props.ref?.(element);
      }}
    >
      <NoticeCard
        class="assistant-code-version"
        tone="neutral"
        icon="ti ti-shield-check"
        layout="card"
        aria-label={c().label}
        data-k2b-primary="ai"
        data-chat-anchor={props.anchorId}
        data-state={props.model.kind}
        data-has-actions={props.model.primary || props.model.secondary ? "" : undefined}
        aria-busy={props.model.busy || undefined}
        tabIndex={-1}
        title={
          <span class="assistant-code-version__main" title={props.model.main}>
            <span role="status" aria-atomic="true">
              {props.model.alert ? "" : props.model.main}
            </span>
            <span role="alert" aria-atomic="true">
              {props.model.alert ? props.model.main : ""}
            </span>
          </span>
        }
        actions={props.model.primary || props.model.secondary ? actions() : undefined}
      >
        <p class="assistant-code-version__quiet" title={props.model.quiet}>
          <span>{props.model.quietAlert ? "" : props.model.quiet}</span>
          <span role="alert">{props.model.quietAlert ? props.model.quiet : ""}</span>
        </p>
      </NoticeCard>
    </div>
  );
}
