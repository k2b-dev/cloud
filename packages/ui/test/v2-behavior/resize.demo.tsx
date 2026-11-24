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
    <div class="columns" ref={resize.container}>
      <For each={names}>
        {(name, index) => (
          <>
            <section class="column" data-column={index()} style={{ width: `${resize.widths()[index()]}px` }}>
              {name}
            </section>
            <div class="grip" data-grip={index()} {...resize.grip(index())} />
          </>
        )}
      </For>
      <section class="column" data-column="rest">
        Leser
      </section>
    </div>
  );
}
