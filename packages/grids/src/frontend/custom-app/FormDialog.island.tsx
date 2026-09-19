import type { DateContext } from "@k2b/stdlib";
import { Button, dialogCore, toast } from "@k2b/ui";
import { createSignal, onCleanup } from "solid-js";
import type { FormBlockData } from "../../api/custom-app-published-page";
import type { CustomAppFormBlock } from "../../custom-apps/contracts";
import { useCustomAppRuntimeMessages } from "./runtime-messages";

/** A contextual entry point; the shared Form only mounts when activated. */
export default function FormDialog(props: {
  presentation: NonNullable<CustomAppFormBlock["presentation"]>;
  data: Extract<FormBlockData, { ok: true }>;
  dateConfig: DateContext;
}) {
  const messages = useCustomAppRuntimeMessages();
  const [opening, setOpening] = createSignal(false);
  let trigger: HTMLButtonElement | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const open = async () => {
    if (opening() || disposed) return;
    setOpening(true);
    try {
      const { openCustomAppFormDialog } = await import("./sidebar-form");
      if (disposed) return;
      setOpening(false);
      // Disabled loading buttons lose focus in browsers; capture the real opener.
      trigger?.focus({ preventScroll: true });
      await openCustomAppFormDialog({ ...props.presentation, data: props.data, dateConfig: props.dateConfig });
    } catch {
      if (!disposed) toast.error(messages().formUnavailable);
    } finally {
      if (!disposed) {
        setOpening(false);
        if (trigger?.isConnected && !dialogCore.isOpen()) trigger.focus({ preventScroll: true });
      }
    }
  };
  return (
    <Button
      ref={(element) => {
        trigger = element;
      }}
      variant={props.presentation.variant ?? "secondary"}
      size="sm"
      class="self-start w-fit max-w-full"
      wrap
      loading={opening()}
      loadingLabel={messages().openingForm}
      onClick={() => void open()}
    >
      <i class={`ti ti-${props.presentation.icon ?? "forms"}`} aria-hidden="true" />
      {props.presentation.label}
    </Button>
  );
}
