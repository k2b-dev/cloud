import { Menu } from "./menu";
import { useOverlayMessages } from "./overlay-messages";
import type { Action } from "./types";

export type HeadCreatesProps = {
  /** The main actions, such as "Hochladen" and "Neuer Ordner": each an entry with its words and its deed or address. */
  actions: readonly Action[];
  /** The words of the "+" menu; "Neu" in the language of the page when not set. */
  label?: string;
};

/**
 * Several main actions at the end of a workspace's head, as its one "+" menu ("Neu") that lists them by their words: a
 * head has one create action. Pass the same actions as `Workspace primary`: on the phone the round button is that menu,
 * and this one leaves the head (it `floats`). A head of one main action keeps its `Button variant="primary" floats`.
 * It is a module of its own, so a page without several main actions loads none of it.
 */
export const HeadCreates = (props: HeadCreatesProps) => {
  const t = useOverlayMessages();
  return (
    <Menu
      variant="primary"
      icon="plus"
      floats
      items={props.actions.map((action) => ({
        label: action.label,
        icon: action.icon,
        href: action.href,
        onNavigate: action.onNavigate,
        onClick: action.onClick,
        disabled: action.disabled,
      }))}
    >
      {props.label ?? t().create}
    </Menu>
  );
};
