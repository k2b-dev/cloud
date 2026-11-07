import { IconButton, NoticeCard } from "@k2b/ui";
import { createSignal, Show } from "solid-js";

/**
 * Shown once where an old link lands: says where the old page's content lives now. Closing it also drops `moved` from
 * the address, so a reload or a shared link does not bring it back.
 */
export default function MovedNotice(props: { text: string; closeLabel: string }) {
  const [open, setOpen] = createSignal(true);
  const close = () => {
    setOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("moved");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  };
  return (
    <Show when={open()}>
      <NoticeCard tone="info" icon="ti ti-info-circle" role="status" data-moved-notice>
        <span class="flex items-start gap-2">
          <span class="min-w-0 flex-1">{props.text}</span>
          <IconButton label={props.closeLabel} size="xs" variant="text" onClick={close}>
            <i class="ti ti-x" aria-hidden="true" />
          </IconButton>
        </span>
      </NoticeCard>
    </Show>
  );
}
