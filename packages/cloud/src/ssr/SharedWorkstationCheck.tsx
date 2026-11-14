import { Show } from "solid-js";

/**
 * The on/off mark of the profile menu's "Shared workstation" entry where it is not a `Dropdown` choice: the hover
 * panel and the phone menu draw the same box and check as `@k2b/ui`'s checkbox choice in the touch menu. The box keeps
 * its size, so switching moves nothing; the row itself carries `role="switch"` and `aria-checked`.
 */
export function SharedWorkstationCheck(props: { checked: boolean }) {
  return (
    <span class="k2b-dropdown__checkbox cloud-shared-workstation-check" aria-hidden="true">
      <Show when={props.checked}>
        <i class="ti ti-check" />
      </Show>
    </span>
  );
}
