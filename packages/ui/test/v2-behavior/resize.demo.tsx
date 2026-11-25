import { For } from "solid-js";
import { createColumnResize } from "../../src/v2/behavior/resize";

const names = ["Ordner", "Liste"];

/** Two resizable columns and a last one that fills the rest (min 400), as a mail workspace. */
export function Demo() {
  const resize = createColumnResize({
    columns: [
      { min: 160, default: 240 },
      { min: 280, default: 360 },
    ],
    rest: { min: 400 },
    label: (index) => `Breite: ${names[index]}`,
  });
  return (
    <resize.Root class="columns">
      <For each={names}>
        {(name, index) => (
          <>
            <resize.Panel index={index()} class="column" data-column={index()}>
              {name}
            </resize.Panel>
            <resize.Grip index={index()} class="grip" />
          </>
        )}
      </For>
      <resize.Panel index={names.length} class="column" data-column="rest">
        Leser
      </resize.Panel>
    </resize.Root>
  );
}
