import { createSignal, Show } from "solid-js";

/** The only browser code on the page: share or copy the canonical address. */
export default function ShareButton(props: { url: string; label: string; copied: string }) {
  const [done, setDone] = createSignal(false);
  const share = async () => {
    if (navigator.share) return navigator.share({ url: props.url }).catch(() => undefined);
    await navigator.clipboard.writeText(props.url);
    setDone(true);
  };
  return (
    <button type="button" class="share" onClick={() => void share()}>
      <Show when={done()} fallback={props.label}>
        {props.copied}
      </Show>
    </button>
  );
}
