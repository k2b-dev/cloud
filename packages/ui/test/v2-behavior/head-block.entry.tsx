import { createComponent, type JSX } from "solid-js";
import FilteredOrders from "../../skills/k2b-ui/recipes/filtered-table";
import { LongPath, NamedPlace, SearchWithWords, ToolbarInHead, TwoCreates } from "../v2-head-block.fixture";
import { mount } from "./mount";

declare global {
  interface Window {
    /** Which head the page shows. */
    __head?: "list" | "toolbar" | "creates" | "named" | "named-drawer" | "search" | "path";
  }
}

const heads: Record<string, () => JSX.Element> = {
  list: () => createComponent(FilteredOrders, {}),
  toolbar: () => createComponent(ToolbarInHead, {}),
  creates: () => createComponent(TwoCreates, {}),
  named: () => createComponent(NamedPlace, {}),
  "named-drawer": () => createComponent(NamedPlace, { detail: 600 }),
  search: () => createComponent(SearchWithWords, {}),
  path: () => createComponent(LongPath, {}),
};

// A head as its island renders it over the server's markup: a list with its toolbar rows, a toolbar in the head, or a
// head with two main actions.
mount(heads[window.__head ?? "list"] ?? heads.list!);
