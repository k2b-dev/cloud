import { onMount } from "solid-js";
import Pairing from "./Pairing";

/**
 * The pairing as `/me/security/pair` runs it (`PairScreen`), without the page's frame: it returns to the pairing page
 * after identity confirmation, goes to `returnTo` when closed, and clears the continue marker from the address.
 */
export default function PairingPage(props: {
  userId: string;
  actorId: string;
  name: string;
  appOrigin: string;
  returnTo: string;
  install: boolean;
}) {
  onMount(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("pairDevice")) return;
    url.searchParams.delete("pairDevice");
    url.searchParams.delete("reauthenticate");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  });
  return (
    <Pairing
      {...props}
      returnTo={`/me/security/pair?${new URLSearchParams({ userId: props.userId })}`}
      onClose={() => window.location.assign(props.returnTo)}
    />
  );
}
