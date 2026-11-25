import { DocCode, SegmentedControl } from "@k2b/ui";
import { Tabs } from "@k2b/ui/v2";
import { createSignal, onCleanup, onMount, Show } from "solid-js";

/** The widths an Example offers: a desktop, a tablet and a phone. Below 768 px the screen stands 1:1 as a phone. */
export const exampleWidths = [1440, 1024, 390] as const;
export type ExampleWidth = (typeof exampleWidths)[number];
const PHONE_BELOW = 768;

export type ExampleProps = {
  /** The recipe's file name without `.tsx`. */
  recipe: string;
  /** What the screen is, for the frame's name and the tab list. */
  title: string;
  /** The recipe's path in the repository, named in the foot. */
  path: string;
  /** The whole recipe file. */
  source: string;
  /** The recipe's states beside its default, as value and label; the first is the default. */
  states: readonly { value: string; label: string }[];
  /** The height of the screen at a desktop width, in px; a phone shows it 15 % higher. */
  height: number;
  /** A fixed width; without it the page's own width picks 1440 (desktop) or 390 (phone). */
  width?: ExampleWidth;
};

/**
 * Fibel's view of one recipe: a toolbar line without a box (v2 `Tabs` Preview | Code at the start, since they switch
 * views; segmented controls for the values state and width at the end), the live screen in an iframe with one thin frame,
 * scaled to the column, or the whole file as code in the same place and size, and the path as plain meta text. The
 * view's height comes from CSS (`--w`, `--h`), so the page never moves while the frame loads, scales or the tab
 * switches; light and dark follow the Fibel switch of the page.
 */
export default function Example(props: ExampleProps) {
  const [tab, setTab] = createSignal<"preview" | "code">("preview");
  const [state, setState] = createSignal(props.states[0]?.value ?? "");
  const [width, setWidth] = createSignal<ExampleWidth | undefined>(props.width);
  const [shown, setShown] = createSignal<ExampleWidth>(props.width ?? 1440);
  const [scale, setScale] = createSignal(1);
  let figure: HTMLElement | undefined;
  let stage: HTMLDivElement | undefined;
  let frame: HTMLIFrameElement | undefined;

  const src = () => {
    const base = `/en/ui/v2/recipe/${props.recipe}`;
    return state() && state() !== props.states[0]?.value ? `${base}?state=${encodeURIComponent(state())}` : base;
  };
  const phoneHeight = () => Math.round(props.height * 1.15);

  /** Reads the width CSS chose (or the one picked) and scales the frame into the stage. */
  const layout = () => {
    // a hidden stage (the code shows) has no width; it scales again when it shows
    if (!figure || !stage || stage.clientWidth === 0) return;
    const chosen = Number(getComputedStyle(figure).getPropertyValue("--w")) as ExampleWidth;
    if (exampleWidths.includes(chosen)) setShown(chosen);
    setScale(Math.min(1, stage.clientWidth / shown()));
    figure.dataset.measured = "";
  };

  /** The page's theme (Fibel's switch) carried into the same-origin frame. */
  const syncTheme = () => {
    const root = frame?.contentDocument?.documentElement;
    if (!root) return;
    const page = document.documentElement;
    const theme = page.classList.contains("dark") ? "dark" : "light";
    root.classList.remove("dark", "light");
    root.classList.add(theme);
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
  };

  onMount(() => {
    layout();
    const resize = new ResizeObserver(layout);
    if (stage) resize.observe(stage);
    const theme = new MutationObserver(syncTheme);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
    onCleanup(() => {
      resize.disconnect();
      theme.disconnect();
    });
  });

  const pickWidth = (value: string) => {
    const next = Number(value) as ExampleWidth;
    setWidth(next);
    setShown(next);
    queueMicrotask(layout);
  };

  const lines = () => props.source.split("\n").length;
  return (
    <figure
      ref={figure}
      id={props.recipe}
      class="k2b-ui ui-example"
      data-tab={tab()}
      data-width={width() ?? "auto"}
      data-phone={shown() < PHONE_BELOW ? "" : undefined}
      style={{ "--h": String(props.height), "--phone-h": String(phoneHeight()), ...(width() ? { "--w": String(width()) } : {}) }}
    >
      <div class="ui-example__bar">
        <div class="k2-ui ui-example__tabs">
          <Tabs
            label={`${props.title}: preview or code`}
            items={[
              { label: "Preview", icon: "eye", current: tab() === "preview", onClick: () => setTab("preview") },
              { label: "Code", icon: "code", current: tab() === "code", onClick: () => setTab("code") },
            ]}
          />
        </div>
        {/* the switches of the preview keep their place while the code shows, so the line never changes its height */}
        <div class="ui-example__tools" data-idle={tab() === "code" ? "" : undefined} inert={tab() === "code"}>
          <Show when={props.states.length > 1}>
            <SegmentedControl size="sm" ariaLabel="State" options={props.states} value={state} onValueChange={setState} />
          </Show>
          <SegmentedControl
            size="sm"
            ariaLabel="Width"
            options={exampleWidths.map((value) => ({ value: String(value), label: String(value) }))}
            value={() => String(shown())}
            onValueChange={pickWidth}
          />
          <a class="ui-example__open" href={src()} target="_blank" rel="noopener" title="Open the screen on its own">
            <i class="ti ti-external-link" aria-hidden="true" />
            <span class="ui-example__name">Open the screen on its own</span>
          </a>
        </div>
      </div>
      <div ref={stage} class="ui-example__view ui-example__stage" hidden={tab() !== "preview"}>
        <iframe
          ref={frame}
          src={src()}
          title={`${props.title}, live`}
          loading="lazy"
          onLoad={syncTheme}
          style={{ transform: scale() < 1 ? `scale(${scale()})` : undefined }}
        />
        <span class="ui-example__scale">{`${shown()} px${scale() < 1 ? ` · ${Math.round(scale() * 100)} %` : ""}`}</span>
      </div>
      <Show when={tab() === "code"}>
        <div class="ui-example__view ui-example__code">
          <DocCode title={props.path} code={props.source} language="tsx" copy lineNumbers />
        </div>
      </Show>
      <figcaption class="ui-example__foot">
        <i class="ti ti-file-code" aria-hidden="true" />
        <code>{props.path}</code>
        <span>· {lines()} lines</span>
        <span class="ui-example__fill" />
        <span>
          the same file is a recipe of the skill <code>k2b-ui</code>
        </span>
      </figcaption>
    </figure>
  );
}
