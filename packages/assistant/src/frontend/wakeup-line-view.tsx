import type { AiWakeupInput } from "@k2b/cloud/ai/browser";
import { Button, IconButton } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import type { AssistantWakeupLineText } from "./wakeup-line";

/** What the chat lends its alarm lines: one way to act on an alarm by its ID, and setting a failed one again. */
export type AssistantWakeupLineHost = {
  act: (action: "edit" | "delete" | "renew" | "catch-up", id: string) => Promise<unknown> | undefined;
  retry: (input: AiWakeupInput) => Promise<unknown>;
};

/**
 * One alarm line without a box, on the edge of Gustav's work line (Gustav alarms v1, 6): sign in plum, "Alarm · time ·
 * note", 13 px; pencil and cross on the newest line of an alarm the chat still has; a missed or expired alarm says why
 * with one way out. Draws the words it gets; until they come, it keeps the line's place.
 */
export function AssistantWakeupLine(props: { line: AssistantWakeupLineText | undefined; host: AssistantWakeupLineHost }) {
  // A way out runs once at a time: a second press while Cloud answers never sets or catches up twice.
  const [busy, setBusy] = createSignal(false);
  const run = (link: NonNullable<AssistantWakeupLineText["link"]>) => {
    if (busy()) return;
    setBusy(true);
    void Promise.resolve(
      link.input
        ? props.host.retry(link.input)
        : link.id
          ? props.host.act(link.action === "retry" ? "edit" : link.action, link.id)
          : undefined,
    ).finally(() => setBusy(false));
  };
  return (
    <span class="assistant-wakeup-line k2b-progressive-row" data-kind={props.line?.kind} data-struck={props.line?.struck ? "" : undefined}>
      <Show when={props.line}>
        {(line) => (
          <>
            <i class={`assistant-wakeup-line__sign ti ${line().sign}`} aria-hidden="true" />
            <span class="assistant-wakeup-line__text">
              <b>{line().verb}</b>
              {line().body}
              <span class="assistant-wakeup-line__aside">{line().aside}</span>
            </span>
            <Show when={line().state}>
              <span class="assistant-wakeup-line__state">{line().state}</span>
            </Show>
            <Show when={line().link}>
              {(link) => (
                <Button
                  variant="link"
                  size="sm"
                  class="assistant-wakeup-line__link"
                  disabled={busy()}
                  aria-busy={busy() ? "true" : undefined}
                  onClick={() => run(link())}
                >
                  {link().label}
                </Button>
              )}
            </Show>
            <Show when={line().acts}>
              {(acts) => (
                <span class="assistant-wakeup-line__acts k2b-progressive-action">
                  <IconButton size="xs" variant="ghost" label={acts().edit} onClick={() => props.host.act("edit", acts().id)}>
                    <i class="ti ti-pencil" aria-hidden="true" />
                  </IconButton>
                  <IconButton size="xs" variant="ghost" label={acts().remove} onClick={() => props.host.act("delete", acts().id)}>
                    <i class="ti ti-x" aria-hidden="true" />
                  </IconButton>
                </span>
              )}
            </Show>
          </>
        )}
      </Show>
    </span>
  );
}
