import { onMount } from "solid-js";
import PairingDialog from "./Pairing";

export default function Pairing(props: {
  userId: string;
  actorId: string;
  name: string;
  appOrigin: string;
  returnTo: string;
  install: boolean;
}) {
  // The page has already continued after identity confirmation; a reload or back
  // navigation starts over with the install step.
  onMount(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("pairDevice")) return;
    url.searchParams.delete("pairDevice");
    url.searchParams.delete("reauthenticate");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  });
  return (
    <PairingDialog
      {...props}
      returnTo={`/me/security/pair?${new URLSearchParams({ userId: props.userId })}`}
      onClose={() => window.location.assign(props.returnTo)}
    />
  );
}
