import { onCleanup, onMount } from "solid-js";
import { getContext, onContextChange } from "../../browser/panel";

export default function ProviderProbe() {
  onMount(() => {
    const show = () => {
      const output = document.getElementById("provider-context");
      if (output) output.textContent = JSON.stringify(getContext());
    };
    show();
    onCleanup(onContextChange(show));
    // This token belongs to the provider window, independently of the host DOM.
    Reflect.set(window, "fixtureProviderToken", crypto.randomUUID());
    document.documentElement.dataset.providerMounted = "true";
    const abort = new AbortController();
    void fetch("/fixture/pending", { signal: abort.signal })
      .then((response) => response.text())
      .then((text) => {
        const output = document.getElementById("pending-result");
        if (output) output.textContent = text;
      })
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          const output = document.getElementById("pending-result");
          if (output) output.textContent = String(error);
        }
      });
    onCleanup(() => abort.abort());
  });
  return <output data-provider-probe />;
}
