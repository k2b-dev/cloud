import { getContext, onContextChange } from "@k2b/cloud/browser/panel";
import type { CloudResourceRef } from "@k2b/cloud/contracts";
import { Button, useLocale } from "@k2b/ui";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { assistantMessages } from "./messages";

/** Sharing a place is not sending it: only this action adds its authorized reference to a particular draft. */
export default function AssistantPanelContext(props: {
  initial: ReturnType<typeof getContext>;
  disabled: boolean;
  attach: (ref: CloudResourceRef, current: () => boolean) => Promise<void>;
}) {
  const locale = useLocale();
  const t = () => assistantMessages.resolve([locale()]).t;
  const [context, setContext] = createSignal(props.initial);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal(false);
  let generation = 0;
  onMount(() => {
    const update = (next: ReturnType<typeof getContext>) => {
      generation++;
      setContext(next);
      setError(false);
    };
    update(getContext());
    onCleanup(onContextChange(update));
    onCleanup(() => generation++);
  });
  const attach = async () => {
    const ref = context()?.scope;
    if (!ref || busy() || props.disabled) return;
    const request = generation;
    setBusy(true);
    setError(false);
    try {
      await props.attach({ ...ref }, () => generation === request);
    } catch {
      if (generation === request) setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Show when={context()?.scope}>
      <div class="flex flex-wrap items-center gap-2 px-3 py-1">
        <Button size="sm" variant="ghost" disabled={props.disabled || busy()} onClick={() => void attach()}>
          <i class="ti ti-paperclip" aria-hidden="true" />
          {busy() ? t().panelAttaching : t().panelAttach}
        </Button>
        <Show when={error()}>
          <span role="alert" class="text-sm text-danger">
            {t().panelAttachFailed}
          </span>
        </Show>
      </div>
    </Show>
  );
}
