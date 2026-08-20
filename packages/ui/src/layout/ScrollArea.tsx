import { type JSX, splitProps } from "solid-js";

export type ScrollAreaProps = Omit<JSX.HTMLAttributes<HTMLDivElement>, "children" | "class"> & {
  children: JSX.Element;
  scrollPreserveKey?: string | false;
  class?: string;
};

export function ScrollArea(props: ScrollAreaProps): JSX.Element {
  const [local, elementProps] = splitProps(props, ["children", "scrollPreserveKey", "class"]);
  const className = () => local.class?.trim();

  return (
    <div
      {...elementProps}
      class={className() ? `k2b-scroll-area ${className()}` : "k2b-scroll-area"}
      data-scroll-preserve={local.scrollPreserveKey || undefined}
    >
      {local.children}
    </div>
  );
}

export default ScrollArea;
