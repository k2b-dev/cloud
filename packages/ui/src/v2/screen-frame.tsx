import { For, type JSX } from "solid-js";

/** The app a pictured screen belongs to: its one colour and its symbol, as an app declares them in its host. */
export type ScreenApp = {
  /** The app colour (`--k2-app`), such as `#047857`. */
  color: string;
  /** The app's Tabler icon without `ti-`; it stands marked in the rail. */
  icon: string;
};

export type ScreenFrameProps = {
  /** The app of the screen; without it the rail marks nothing and v2 uses its blue. */
  app?: ScreenApp;
  /** One v2 screen: a `Workspace`. */
  children: JSX.Element;
};

// The apps of a host's rail, as the approved mockup draws it: home, mail, boards, files, tables, notes, chat, contacts.
const railApps = ["home", "mail", "layout-kanban", "files", "table", "notebook", "messages", "address-book"];

// The frame's own look. It is a picture of a host, not a v2 primitive, so it ships in no stylesheet: it travels with
// the frame into every place that draws one (v2-preview, the recipe tests, Fibel). Its colours are v2 tokens, so it
// follows light and dark.
const css = `
.k2-sf{position:relative;flex:1;display:flex;min-width:0;min-height:0;box-sizing:border-box;padding:8px 8px 8px 56px;
background:linear-gradient(135deg,color-mix(in srgb,var(--k2-app,var(--k2-blue)) 10%,var(--k2-surface)),color-mix(in srgb,#4f46e5 7%,var(--k2-surface)))}
.k2-sf-card{flex:1;display:flex;min-width:0;min-height:0}
.k2-sf-rail{position:absolute;inset:0 auto 0 0;width:56px;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 0}
.k2-sf-logo{width:32px;height:32px;margin-bottom:12px;display:grid;place-items:center;border-radius:8px;background:var(--k2-text);color:var(--k2-surface);font:600 14px/1 var(--k2-font)}
.k2-sf-app{width:36px;height:36px;display:grid;place-items:center;border-radius:10px;color:var(--k2-n600);font-size:18px}
.k2-sf-app[data-current]{background:var(--k2-surface);color:var(--k2-app,var(--k2-blue));outline:1px solid var(--k2-card-edge)}
.k2-sf-fill{flex:1}
.k2-sf-me{width:28px;height:28px;margin-top:4px;display:grid;place-items:center;border-radius:50%;background:#0f766e;color:#fff;font:600 10px/1 var(--k2-font)}
@media not all and (min-width:768px){.k2-sf{padding:0;background:var(--k2-surface)}.k2-sf-rail{display:none}}
`;

/**
 * A v2 screen as it stands in a host such as Cloud: a tinted page, a rail of app symbols at the start with the screen's
 * app marked, and the screen beside it as the card; on a phone (below 768 px) the screen alone, as the host shows it.
 *
 * Only for pictures of screens: the recipes of the k2b-ui skill, `v2-preview`, the recipe tests and Fibel draw every
 * screen in it, so no picture is a bare white page. An app never draws it; its host gives it the real shell. The rail
 * is a picture and hidden from assistive technology; the screen keeps its own names.
 */
export const ScreenFrame = (props: ScreenFrameProps) => (
  <div class="k2-sf" data-k2-frame="" style={props.app ? { "--k2-app": props.app.color } : undefined}>
    <style>{css}</style>
    <div class="k2-sf-rail" aria-hidden="true">
      <span class="k2-sf-logo" data-k2-glyph="">
        C
      </span>
      <For each={railApps.includes(props.app?.icon ?? "") || !props.app ? railApps : [...railApps, props.app.icon]}>
        {(icon) => (
          <span class="k2-sf-app" data-current={icon === props.app?.icon ? "" : undefined}>
            <i class={`ti ti-${icon}`} />
          </span>
        )}
      </For>
      <span class="k2-sf-fill" />
      <span class="k2-sf-app">
        <i class="ti ti-help" />
      </span>
      <span class="k2-sf-me" data-k2-glyph="">
        MS
      </span>
    </div>
    <div class="k2-sf-card">{props.children}</div>
  </div>
);
