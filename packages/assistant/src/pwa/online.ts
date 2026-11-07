import { type Accessor, createSignal, onCleanup, onMount } from "solid-js";

/** Whether the device has a connection. The server and the first frame assume one, so both render the same. */
export const createOnline = (): Accessor<boolean> => {
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
};
