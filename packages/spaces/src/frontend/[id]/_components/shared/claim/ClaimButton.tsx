import { Button, IconButton } from "@k2b/ui";
import { Show } from "solid-js";
import type { SpaceItemClaim } from "@/contracts";
import { useSpaceMessages } from "../../../messages";
import { isOwnClaim } from "./claim";

type Action = "claim" | "release" | "take-over";

type Props = {
  claim: SpaceItemClaim | null | undefined;
  currentUserId: string;
  isAdmin: boolean;
  disabled?: boolean;
  loading?: boolean;
  /** Icon-only control for the board card. */
  compact?: boolean;
  class?: string;
  onClaim: () => void;
  onRelease: () => void;
  onTakeOver: () => void;
};

const ICONS: Record<Action, string> = { claim: "ti ti-player-play", release: "ti ti-hand-stop", "take-over": "ti ti-replace" };

/**
 * One control for the claim lifecycle: "I'm on it" claims, a second click releases, and Space admins
 * take over another account's claim. Somebody else's claim without admin rights renders nothing.
 */
export default function ClaimButton(props: Props) {
  const t = useSpaceMessages();
  const action = (): Action | null => {
    if (!props.claim) return "claim";
    if (isOwnClaim(props.claim, props.currentUserId)) return "release";
    return props.isAdmin ? "take-over" : null;
  };
  const label = () => {
    const current = action();
    return current === "claim" ? t.imOnIt : current === "release" ? t.releaseClaim : t.takeOverClaim;
  };
  const run = () => {
    const current = action();
    if (current === "claim") props.onClaim();
    else if (current === "release") props.onRelease();
    else if (current === "take-over") props.onTakeOver();
  };
  const icon = () => (props.loading ? "ti ti-loader-2 animate-spin" : ICONS[action() ?? "claim"]);

  return (
    <Show when={action()}>
      {(current) => (
        <Show
          when={props.compact}
          fallback={
            <Button
              type="button"
              data-spaces-claim-action={current()}
              variant="secondary"
              size="sm"
              class={props.class}
              onClick={run}
              disabled={props.disabled || props.loading}
              aria-busy={props.loading ? "true" : undefined}
            >
              <i class={icon()} aria-hidden="true" />
              {label()}
            </Button>
          }
        >
          <IconButton
            data-spaces-claim-action={current()}
            label={label()}
            tooltip={label()}
            size="sm"
            class={props.class}
            onClick={run}
            disabled={props.disabled || props.loading}
            aria-busy={props.loading ? "true" : undefined}
          >
            <i class={icon()} aria-hidden="true" />
          </IconButton>
        </Show>
      )}
    </Show>
  );
}
