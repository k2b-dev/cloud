import type { JSX } from "solid-js";

export type DemoRenderProps = {
  markdownHtml: string;
  search?: string;
};

export type DemoSection = Record<string, (props: DemoRenderProps) => JSX.Element>;

/**
 * Showcase-owned scaffolding. Portable catalog pages load only
 * `@k2b/ui/styles.css`, which ships no Tailwind utilities, so every class here
 * must be a `ui-*` class defined in `docs-site/assets/ui-catalog.css`.
 */
export function DemoGrid(props: { children: JSX.Element; columns?: "one" | "two" }) {
  return (
    <div class="ui-demo-stack" data-columns={props.columns === "two" ? "two" : "one"}>
      {props.children}
    </div>
  );
}
