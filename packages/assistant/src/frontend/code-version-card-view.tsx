import { ApprovalFrame } from "@k2b/cloud/approvals/frame";
import { documentNavigate } from "@k2b/ssr/nav";
import { Button, ButtonLink, type ButtonVariant, SplitButton, useLocale } from "@k2b/ui";
import { type JSX, Show } from "solid-js";
import { codeVersionCardCopy } from "./code-version-card-copy";
import { type CodeVersionCardAction, type CodeVersionCardModel, isCodeVersionReceipt } from "./code-version-card-state";

/** The one v10 surface. Buttons keep their public appearance, loading, focus and menu contracts. */
export function CodeVersionCardView(props: {
  model: CodeVersionCardModel;
  ref?: (element: HTMLDivElement) => void;
  anchorId: string;
  onAction: (action: CodeVersionCardAction["id"]) => void;
  /** Already final in the initial snapshot; a card that becomes final in view keeps its reserve. */
  receipt?: boolean;
}) {
  const locale = useLocale();
  const receipt = () => props.receipt && isCodeVersionReceipt(props.model);
  const c = () => codeVersionCardCopy.resolve([locale()]).t;
  const control = (action: CodeVersionCardAction, primary: boolean, narrow: boolean): JSX.Element => {
    const common = {
      get size(): "sm" | "md" {
        return narrow ? "md" : "sm";
      },
      get variant(): ButtonVariant {
        return primary ? (action.filled ? "ai" : "secondary") : narrow ? "secondary" : "link";
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
              sectionLabel: narrow ? c().morePages : undefined,
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
          {narrow && action.id === "rework" ? c().reworkShort : action.label}
        </ButtonLink>
      );
    return (
      <Button {...common} disabled={action.disabled} loading={action.busy} onClick={() => props.onAction(action.id)}>
        {narrow && action.id === "rework" ? c().reworkShort : action.label}
      </Button>
    );
  };
  return (
    <div class="assistant-code-version-host" ref={props.ref} data-state={props.model.kind} data-receipt={receipt() ? "" : undefined}>
      <ApprovalFrame
        locale={locale()}
        state={props.model.kind === "loading" ? "loading" : props.model.busy ? "sending" : "decided"}
        source={{ name: "Code", icon: "ti ti-code" }}
        anchorId={props.anchorId}
        sentence={props.model.main}
        reason={{ text: props.model.quiet }}
        alert={props.model.alert}
        quietAlert={props.model.quietAlert}
        reserve={
          !receipt() && !(["denied", "replaced", "withdrawn"].includes(props.model.kind) && !props.model.primary && !props.model.secondary)
        }
        actions={({ narrow }) => (
          <>
            <Show keyed when={props.model.secondary}>
              {(action) => control(action, false, narrow)}
            </Show>
            <Show keyed when={props.model.primary}>
              {(action) => control(action, true, narrow)}
            </Show>
          </>
        )}
      />
    </div>
  );
}
