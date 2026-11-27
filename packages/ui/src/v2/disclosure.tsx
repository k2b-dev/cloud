import type { JSX } from "solid-js";
import { useDisclosure } from "./behavior/disclosure";
import { Icon } from "./marks";

export type DisclosureProps = {
  /** The question or the name of what is hidden; it is the button that opens and closes it. */
  title: string;
  /** Whether it is open. With `onOpenChange` the caller holds it; without, it starts so and keeps its own state. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** What opens: `Text`, `Prose`, `Facts`, a few rows. */
  children: JSX.Element;
};

/**
 * Something that opens in place, such as the answer to a question: a row of 44 px with the title and a chevron at the
 * end, the content under it on the text edge, made only while it is open (as a folded `Group`), so the server and
 * the first render show the same. Several stand one under the other in a `Section`, without lines.
 */
export const Disclosure = (props: DisclosureProps) => {
  const parts = useDisclosure(() => ({
    ...(props.onOpenChange ? { open: props.open === true } : { defaultOpen: props.open === true }),
    onOpenChange: (open: boolean) => props.onOpenChange?.(open),
  }));
  return (
    <parts.Root class="k2-disc" data-k2-part="Disclosure">
      <parts.Trigger class="k2-disc-head">
        <span class="k2-disc-title">{props.title}</span>
        <Icon name="chevron-down" />
      </parts.Trigger>
      <parts.Panel class="k2-disc-body">{props.children}</parts.Panel>
    </parts.Root>
  );
};
