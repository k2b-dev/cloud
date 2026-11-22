import { createComponent, createUniqueId, Errored, Hydration } from "solid-js";
import { escape, type JSX, ssr } from "@solidjs/web";

// Spike (Solid 2 hydration): html() renders the page inside <NoHydration>; each island re-enters hydration under its
// own id, which the client passes to hydrate({ renderId }). The id comes from the owner tree, so it is deterministic and
// survives Solid re-running a template group (a counter in an attribute expression ran twice per island).

/**
 * Server island wrapper: renders <solid-island data-id data-props data-rid> around the same Hydration > Errored >
 * component tree that mount.ts builds on the client, so both sides allocate the same hydration keys.
 * A server error leaves the island empty; the client then renders it.
 */
export const IslandRoot = (props: { id: string; props: string; file?: string; children: JSX.Element }): JSX.Element => {
  const rid = `i${createUniqueId()}-`;
  const file = props.file ? ` data-file="${escape(props.file, true)}"` : "";
  // data-id stays the first attribute: html() finds rendered islands by it.
  const open = `<solid-island data-id="${escape(props.id, true)}" data-props="${escape(props.props, true)}" data-rid="${rid}"${file}>`;
  return ssr(
    [open, "</solid-island>"],
    escape(
      createComponent(Hydration, {
        id: rid,
        get children() {
          return createComponent(Errored, {
            fallback: () => "",
            get children() {
              return props.children;
            },
          });
        },
      }),
    ),
  ) as unknown as JSX.Element;
};
