import { Button, InlineGuidance } from "@k2b/ui";
import { Show } from "solid-js";
import type { AreaMessages } from "./area-messages";

/** What became of the last save when it did not succeed: not saved with a reason, or an unclear outcome to check. */
export function SaveOutcome(props: {
  t: AreaMessages;
  outcome: { kind: "failed" | "unknown"; message: string } | null;
  onRetry: () => void;
}) {
  return (
    <Show when={props.outcome}>
      {(outcome) =>
        outcome().kind === "failed" ? (
          <InlineGuidance tone="danger" icon="ti ti-alert-triangle">
            <b>{props.t.notSaved}</b> {outcome().message} {props.t.notSavedKeep}{" "}
            <Button type="button" variant="ghost" size="xs" onClick={props.onRetry}>
              {props.t.retry}
            </Button>
          </InlineGuidance>
        ) : (
          <InlineGuidance tone="warning" icon="ti ti-help-circle">
            <b>{props.t.unknownOutcome}</b> {props.t.unknownOutcomeKeep}{" "}
            <Button type="button" variant="ghost" size="xs" onClick={() => window.location.reload()}>
              {props.t.checkNow}
            </Button>
          </InlineGuidance>
        )
      }
    </Show>
  );
}
