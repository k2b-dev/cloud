import { PageTitle, usePageTrail } from "@k2b/ui";
import { type JSX, Show } from "solid-js";

export type PageTrailProps = {
  /** Quiet text after the title, for example a count. */
  subtitle?: JSX.Element;
  /** Defaults to `"h1"`. */
  as?: "h1" | "h2" | "p";
  class?: string;
};

/**
 * The page's title with its way up, for an app that draws its own header.
 * It shows what the shell would show, from the same title array (`Layout`'s
 * `title`, kept current by `layout.update()`), and takes the shell's place:
 * workspace heads and the shell's row step back while it is on the page.
 */
export default function PageTrail(props: PageTrailProps) {
  const trail = usePageTrail();
  return (
    <Show when={trail()}>{(current) => <PageTitle trail={current()} subtitle={props.subtitle} as={props.as} class={props.class} />}</Show>
  );
}
