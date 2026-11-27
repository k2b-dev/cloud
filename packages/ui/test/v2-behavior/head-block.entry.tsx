import { createComponent, type JSX } from "solid-js";
import FilteredOrders from "../../skills/k2b-ui/recipes/filtered-table";
import {
  ChatWithTabs,
  LongPath,
  NamedPlace,
  OpenItem,
  PaneWithTwoActions,
  SearchAndAction,
  SearchWithWords,
  ToolbarInHead,
  TwoCreates,
} from "../v2-head-block.fixture";
import { mount } from "./mount";

declare global {
  interface Window {
    /** Which head the page shows. */
    __head?:
      | "list"
      | "toolbar"
      | "creates"
      | "named"
      | "named-drawer"
      | "search"
      | "path"
      | "item"
      | "item-alone"
      | "hollow"
      | "hollow-words"
      | "named-bare"
      | "pane-actions"
      | "chat"
      | "chat-open"
      | "chat-tabs-first"
      | "named-bare-drawer";
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
  item: () => createComponent(OpenItem, {}),
  "item-alone": () => createComponent(OpenItem, { path: false }),
  hollow: () => createComponent(SearchAndAction, {}),
  "hollow-words": () => createComponent(SearchAndAction, { words: "Kunden" }),
  "named-bare": () => createComponent(NamedPlace, { bare: true }),
  "pane-actions": () => createComponent(PaneWithTwoActions, {}),
  chat: () => createComponent(ChatWithTabs, {}),
  "chat-open": () => createComponent(ChatWithTabs, { open: true }),
  "chat-tabs-first": () => createComponent(ChatWithTabs, { tabsFirst: true }),
  "named-bare-drawer": () => createComponent(NamedPlace, { bare: true, detail: 600 }),
};

// A head as its island renders it over the server's markup: a list with its toolbar rows, a toolbar in the head, or a
// head with two main actions.
mount(heads[window.__head ?? "list"] ?? heads.list!);
