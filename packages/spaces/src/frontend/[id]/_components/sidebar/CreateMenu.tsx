import { Dropdown, useLocale } from "@k2b/ui";
import { createMemo, type JSX } from "solid-js";
import type { SpaceItemTemplate } from "@/contracts";
import { useSpaceMessages } from "../../messages";
import { type CreateMenuChoice, type CreateMenuKind, createMenuModel } from "../shared/create-menu";

/**
 * The "+" menu: blank first, then the Space's templates, then "Create template…". A phone opens it as a sheet with its
 * title on top. Without `children` it adopts the element `attach` returns, such as the head's server-rendered link.
 */
export function CreateMenu(props: {
  kind: CreateMenuKind;
  templates: readonly SpaceItemTemplate[];
  choose: (choice: CreateMenuChoice) => void;
  /** The phone sheet's title, such as "New task in “Review”"; defaults to the menu's name. */
  title?: string;
  /** Shows N and Shift+N beside the blank entries, where those keys create directly. */
  shortcuts?: boolean;
  attach?: () => HTMLElement | null | undefined;
  disabled?: boolean;
  align?: "start" | "end";
  class?: string;
  children?: JSX.Element;
}) {
  const t = useSpaceMessages();
  const locale = useLocale();
  const model = createMemo(() =>
    createMenuModel({
      kind: props.kind,
      templates: props.templates,
      shortcuts: props.shortcuts,
      t,
      locale: locale(),
      choose: props.choose,
    }),
  );
  return (
    <Dropdown.Root
      items={model().items}
      search={model().search}
      label={model().label}
      icons="tile"
      phone="sheet"
      width="18.75rem"
      align={props.align}
      class={props.class}
      disabled={props.disabled}
      attach={props.attach}
      sheetTop={() => <p class="px-3 pb-1 text-[0.9375rem] font-semibold">{props.title ?? model().label}</p>}
    >
      {props.children}
    </Dropdown.Root>
  );
}
