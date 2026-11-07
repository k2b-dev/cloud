import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";

/**
 * Whether the device has a connection, as the browser reports it. The server and the first frame assume one, so both
 * render the same controls; offline, changing and adding stay off and say why.
 */
export function createOnline(): Accessor<boolean> {
  const [online, setOnline] = createSignal(true);
  onMount(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    onCleanup(() => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    });
  });
  return online;
}
