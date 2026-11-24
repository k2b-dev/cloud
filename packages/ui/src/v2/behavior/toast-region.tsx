/**
 * Toast behaviour for v2: the queue, timers that pause on hover, focus and a hidden page, swipe and Escape to dismiss,
 * F6 to reach the region, announcements and pending actions are core's (`createToaster`, `toastRegion`).
 *
 * k2b-ui gap: a local seam until lane B's `useToaster` (feat/ui-v2-list-tree-toast) lands; the v2 `toast` surface then
 * builds on that and this file goes.
 */
import { createToaster, toastRegion } from "@ui-sdk/core/toast";
import { For, type JSX, splitProps } from "solid-js";
import { type PartProps, part, slotComponent, usePrimitive } from "./adapter";
import { useBehaviorMessages } from "./messages";

/** What a v2 toast carries: one sentence, an optional deed, and whether it reports something that went wrong. */
export type ToastEntry = {
  message: string;
  status?: "ok" | "bad";
  action?: { label: string; onAction: () => unknown };
};

export type ToastQueue = {
  show: (entry: ToastEntry) => string;
  dismiss: (id?: string) => void;
};

type Queue = ReturnType<typeof createToaster>;

/**
 * One queue per page. Each island bundles its own copy of `@k2b/ui` (and of core), so the queue lives on the page,
 * not in a module: every copy finds the same one, and one region shows its toasts.
 */
const pageQueue = (): Queue => {
  const page = globalThis as { [key: symbol]: Queue | undefined };
  const key = Symbol.for("k2b.ui.v2.toasts");
  page[key] ??= createToaster();
  return page[key];
};

export const toastQueue = (): ToastQueue => ({
  show: (entry) =>
    pageQueue()({
      title: entry.message,
      type: entry.status === "bad" ? "error" : entry.status === "ok" ? "success" : "default",
      data: entry,
      action: entry.action && { label: entry.action.label, onAction: entry.action.onAction },
    }),
  dismiss: (id) => pageQueue().dismiss(id),
});

/** One toast as the region renders it. */
export type ToastView = { id: string; entry: ToastEntry; front: boolean; leaving: boolean };

type Item = { toast: { id: string; data?: unknown; title?: unknown }; index: number; leaving: boolean };

const entryOf = (item: Item): ToastEntry =>
  typeof item.toast.data === "object" && item.toast.data !== null && "message" in item.toast.data
    ? (item.toast.data as ToastEntry)
    : { message: String(item.toast.title ?? "") };

export type ToastRegionParts = {
  /** The region: a landmark while it holds toasts; `render` draws each one with the parts below. */
  Region: (props: PartProps & { render: (toast: ToastView) => JSX.Element }) => JSX.Element;
  /** One toast; `id` names it. */
  Toast: (props: PartProps & { id: string }) => JSX.Element;
  Title: (props: PartProps & { id: string }) => JSX.Element;
  /** The toast's deed (Undo); `toast` names the toast. */
  Action: (props: PartProps & { toast: string }) => JSX.Element;
};

/** The region that shows the page's toasts, at the bottom in the middle. */
export function useToastRegion(label: () => string): ToastRegionParts {
  const t = useBehaviorMessages();
  const handle = usePrimitive(toastRegion, () => ({
    toaster: pageQueue(),
    side: "bottom",
    align: "center",
    label: label(),
    pendingAnnouncement: t().loading,
  }));
  const Action = slotComponent(handle, "action", "button");
  return {
    Region: (props) => {
      const [own, rest] = splitProps(props, ["render"]);
      return part(
        handle,
        "region",
        () => ({}),
        {
          ...rest,
          // Core hands over new item records on every change; the toasts are keyed by id, so a toast's element
          // stays while it lives (no remount, no flicker) and reads its record through getters.
          children: (state: { toasts?: unknown }) => {
            const items = () => (Array.isArray(state.toasts) ? (state.toasts as Item[]) : []);
            return (
              <For each={items().map((item) => item.toast.id)}>
                {(id) => {
                  const item = () => items().find((each) => each.toast.id === id);
                  return own.render({
                    id,
                    get entry() {
                      const found = item();
                      return found ? entryOf(found) : { message: "" };
                    },
                    get front() {
                      return item()?.index === 0;
                    },
                    get leaving() {
                      return item()?.leaving ?? true;
                    },
                  });
                }}
              </For>
            );
          },
        },
        "section",
      );
    },
    Toast: (props) => {
      const [own, rest] = splitProps(props, ["id"]);
      return part(handle, "root", () => ({ id: own.id }), rest, "div");
    },
    Title: (props) => {
      const [own, rest] = splitProps(props, ["id"]);
      return part(handle, "title", () => ({ id: own.id }), rest, "span");
    },
    Action,
  };
}
