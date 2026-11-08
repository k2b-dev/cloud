import { For } from "solid-js";
import { render } from "solid-js/web";
import { FeatCodeMark } from "./FeatCodeMark";

// Every size and tone once in light and once in dark, plus a container narrower than the wordmark to prove it
// never wraps.
const Scene = (props: { theme: "light" | "dark" }) => (
  <section
    class={props.theme}
    data-theme={props.theme}
    // The page has no theme of its own; each scene sets the surface and ink of its theme.
    style={props.theme === "dark" ? { padding: "16px", background: "#11151b", color: "#f4f4f5" } : { padding: "16px", background: "#ffffff", color: "#18181b" }}
  >
    <h1 style={{ "font-size": "20px", margin: "0 0 12px" }} data-probe={`title-${props.theme}`}>
      <FeatCodeMark size="title" decorative />
    </h1>
    <p data-probe={`head-${props.theme}`} style={{ margin: "0 0 12px" }}>
      <FeatCodeMark size={30} />
    </p>
    <p style={{ "font-size": "12.5px", margin: "0 0 12px", color: "color-mix(in srgb, currentColor 65%, transparent)" }} data-probe={`row-${props.theme}`}>
      Nach ‚Buchhaltung‘ verschoben von <FeatCodeMark /> ‚Rechnungen ablegen‘
    </p>
    <div style={{ width: "40px", "font-size": "16px", margin: "0 0 12px" }} data-probe={`narrow-${props.theme}`}>
      <FeatCodeMark />
    </div>
    <div style={{ display: "flex", gap: "16px", "align-items": "end" }}>
      <For each={[32, 16] as const}>
        {(size) => (
          <span data-probe={`glyph-${size}-${props.theme}`} style={{ display: "inline-flex" }}>
            <FeatCodeMark variant="glyph" size={size} />
          </span>
        )}
      </For>
      <span style={{ "font-size": "16px", color: "color-mix(in srgb, currentColor 65%, transparent)" }} data-probe={`current-${props.theme}`}>
        <FeatCodeMark variant="glyph" tone="current" decorative />
      </span>
    </div>
  </section>
);

render(
  () => (
    <>
      <Scene theme="light" />
      <Scene theme="dark" />
    </>
  ),
  document.getElementById("root")!,
);
