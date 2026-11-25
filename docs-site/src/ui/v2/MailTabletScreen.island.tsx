import { onMount } from "solid-js";
import { MailScreen } from "./mail-screen";

// Mail on a tablet: in a window of 1024 px the sidebar does not fit beside the list and the reader, so it is a drawer.
// An island, so the drawer opens: once the screen is live it presses the drawer's button, as a person would (the
// screen's page holds this one workspace). In a wider window the sidebar is a column, and nothing opens.

export default function MailTabletScreen() {
  onMount(() => {
    // only where the sidebar is a drawer: in a wide window its button is not shown and nothing opens
    const button = document.querySelector<HTMLButtonElement>(".k2-ws-toggle");
    if (button && button.getClientRects().length > 0) button.click();
  });
  return <MailScreen />;
}
