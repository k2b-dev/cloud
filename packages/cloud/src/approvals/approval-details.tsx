import { Button, ButtonLink, Checkbox, dialogCore, InlineGuidance, LocaleProvider, PanelDialog, panelDialogOptions } from "@k2b/ui";
import { createEffect, For, on, Show } from "solid-js";
import { actionMessages } from "../ai/chat/action-messages";
import type { ApprovalFrameProps } from "./ApprovalFrame";

/** Loaded only when a person opens the complete proposal. Its data and decisions remain the caller's. */
export function openApprovalDetails(input: {
  props: ApprovalFrameProps;
  invoke: (answer: NonNullable<ApprovalFrameProps["decline"]>, confirming?: boolean) => Promise<void>;
  remembered: () => boolean;
  setRemembered: (value: boolean) => void;
  pending: () => boolean;
  failed: () => boolean;
  signal: AbortSignal;
}) {
  const p = input.props;
  const t = () => actionMessages(p.locale);
  return dialogCore.open(
    (close, context) => {
      const leave = () => {
        if (!input.pending()) close();
      };
      context.setDismissHandler(leave);
      createEffect(
        on(
          () => p.state,
          (state, previous) => {
            if (previous === "open" && state !== "open") close();
          },
        ),
      );
      return (
        <LocaleProvider locale={p.locale}>
          <PanelDialog>
            <PanelDialog.Header
              title={p.details?.label ?? t().seeEverything}
              subtitle={p.details?.context}
              close={leave}
              closeDisabled={input.pending()}
            />
            <PanelDialog.Body>
              <div class="cloud-approval-details">
                <p>{p.reason.text}</p>
                {typeof p.details?.content === "function" ? p.details.content() : p.details?.content}
                <Show when={p.details?.note}>{(note) => <p>{note().text}</p>}</Show>
                <For each={p.notes}>{(note) => <p>{note.text}</p>}</For>
                <For each={p.meta}>{(fact) => <p>{fact.text}</p>}</For>
                <Show when={p.unavailable || p.waiting}>{(reason) => <p role="status">{reason().text}</p>}</Show>
                <InlineGuidance class="cloud-approval-details__error" tone="danger" role="alert">
                  {input.failed() ? t().frameAnswerFailed : ""}
                </InlineGuidance>
                <Show when={p.state === "open" && p.mode !== "edit" ? p.remember : undefined}>
                  {(remember) => (
                    <Checkbox
                      label={remember().label}
                      value={input.remembered()}
                      onValueChange={input.setRemembered}
                      disabled={Boolean(p.unavailable || p.waiting || input.pending())}
                    />
                  )}
                </Show>
              </div>
            </PanelDialog.Body>
            <PanelDialog.Footer>
              <Show when={p.link}>
                {(link) => (
                  <ButtonLink variant="secondary" href={link().href}>
                    {link().label}
                  </ButtonLink>
                )}
              </Show>
              <Show when={p.state === "open"}>
                <Show when={p.back}>
                  {(answer) => (
                    <Button
                      variant="secondary"
                      disabled={Boolean(p.waiting || input.pending())}
                      onClick={() => void input.invoke(answer())}
                    >
                      {answer().label}
                    </Button>
                  )}
                </Show>
                <For each={p.more}>
                  {(answer) => (
                    <Button variant="secondary" disabled={Boolean(p.waiting || input.pending())} onClick={() => void input.invoke(answer)}>
                      {answer.label}
                    </Button>
                  )}
                </For>
                <Show when={p.decline}>
                  {(answer) => (
                    <Button
                      variant="secondary"
                      disabled={Boolean(p.waiting || input.pending())}
                      onClick={() => void input.invoke(answer())}
                    >
                      {answer().label}
                    </Button>
                  )}
                </Show>
                <Show when={p.confirm?.onSelect && p.confirm}>
                  {(answer) => (
                    <Button
                      variant={p.mode === "edit" ? "secondary" : "ai"}
                      loading={input.pending() || answer().busy}
                      disabled={Boolean(p.waiting || p.unavailable || answer().disabled)}
                      onClick={() => void input.invoke({ label: answer().label, onSelect: answer().onSelect! }, true)}
                    >
                      {answer().label}
                    </Button>
                  )}
                </Show>
              </Show>
            </PanelDialog.Footer>
          </PanelDialog>
        </LocaleProvider>
      );
    },
    { ...panelDialogOptions, ariaLabel: p.details?.label ?? t().seeEverything, signal: input.signal },
  );
}
