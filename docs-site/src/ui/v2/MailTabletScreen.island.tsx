import { onMount } from "solid-js";
import { MailScreen } from "./mail-screen";

// Mail on a tablet: in a window of 1024 px the sidebar does not fit beside the list and the reader, so it is a drawer.
// An island, so the drawer opens: once the screen is live it presses the drawer's button, as a person would (the
// screen's page holds this one workspace). In a wider window the sidebar is a column and the drawer closes again.

export default function MailTabletScreen() {
  onMount(() => document.querySelector<HTMLButtonElement>(".k2-ws-toggle")?.click());
  return <MailScreen />;
}
