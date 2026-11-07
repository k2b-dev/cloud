/** Focused save fixture: real controls and persistence without starting the map renderer. */
import { Button, LocaleProvider, useLocale } from "@k2b/ui";
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import type { AiMap } from "../map-contracts";
import { mapMessages } from "./map-messages";
import { MapNotebookSave } from "./map-notebook";

const snapshot: { map: AiMap } = JSON.parse(document.getElementById("snapshot")!.textContent!);
function SaveFixture() {
  const [saving, setSaving] = createSignal(false);
  const locale = useLocale();
  return (
    <section class="ai-map">
      <Show when={saving()} fallback={<Button onClick={() => setSaving(true)}>{mapMessages(locale()).save}</Button>}>
        <MapNotebookSave map={snapshot.map} onCancel={() => setSaving(false)} />
      </Show>
    </section>
  );
}
render(
  () => (
    <LocaleProvider locale={document.documentElement.lang}>
      <SaveFixture />
    </LocaleProvider>
  ),
  document.getElementById("fixture-mount")!,
);
