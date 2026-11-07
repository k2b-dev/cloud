import { Skeleton } from "@k2b/ui";
import { Show } from "solid-js";
import { refreshed, retrying } from "./provider-state";

/**
 * A value that comes from `app-status` providers. While "Try again" runs, a placeholder of the same height takes its
 * place, so the row does not move; afterwards the new value or "Not available" stays at the same spot.
 */
export default function ProviderValue(props: {
  part: "traffic" | "errors";
  initial: string | null;
  unavailable: boolean;
  unavailableLabel: string;
  tone?: "danger";
}) {
  const value = () => refreshed()?.[props.part] ?? (refreshed() ? null : props.initial);
  const unavailable = () => (refreshed() ? refreshed()!.unavailable && !value() : props.unavailable);
  const tone = () => (props.part === "errors" ? (refreshed()?.errorsTone ?? (refreshed() ? undefined : props.tone)) : undefined);
  return (
    <Show when={!retrying()} fallback={<Skeleton class="inline-block h-3.5 w-24 align-middle" />}>
      <Show when={!unavailable()} fallback={<span class="text-dimmed">{props.unavailableLabel}</span>}>
        <span classList={{ "text-(--k2b-danger-text)": tone() === "danger" }}>{value() ?? "–"}</span>
      </Show>
    </Show>
  );
}
