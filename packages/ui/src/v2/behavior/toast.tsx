/**
 * Toasts for v2 on core's toaster and toast region: timers, pause while hovered or focused (and while the window is
 * away), swipe to dismiss, Escape, `maxVisible`, the F6 jump into the region and the announcements are core's.
 *
 * One toaster per `useToaster` call, which v2 makes once per Workspace: never a toaster at module level, which a
 * server would share between requests (core's exported `toast` is such a module-level toaster, so it is not used).
 */
import { createOverlays } from "@ui-sdk/core/overlays";
import { createToaster, toastRegion } from "@ui-sdk/core/toast";
import { createContext, createUniqueId, For, type JSX, mergeProps, splitProps, useContext } from "solid-js";
import { type PartProps, type Props, part, usePrimitive } from "./adapter";
import { useBehaviorMessages } from "./messages";

export type ToastKind = "default" | "success" | "error" | "info" | "warning" | "loading";

/** What a toast says and offers. */
export type ToastInput = {
  /** Reuses a toast: one with this id that is still showing is updated instead of added again. */
  id?: string;
  title?: string;
  description?: string;
  type?: ToastKind;
  /** How long it shows, in ms; `Infinity` until dismissed. */
  duration?: number;
  priority?: "polite" | "assertive";
  /** A button that does something, like Undo. */
  action?: { label: string; onAction?: () => unknown; dismiss?: boolean };
  /** A button that dismisses it, like Cancel. */
  cancel?: { label: string; onCancel?: () => void };
  dismissible?: boolean;
  onDismiss?: () => void;
};

/** A toast as the region renders it. */
export type ToastView = {
  id: string;
  type: ToastKind;
  title?: string;
  description?: string;
  actionLabel?: string;
  cancelLabel?: string;
  /** Its place from the front, 0 for the newest. */
  index: number;
};

export type Toaster = {
  /** Shows a toast; returns its id. */
  show: (toast: ToastInput) => string;
  success: (toast: ToastInput) => string;
  error: (toast: ToastInput) => string;
  info: (toast: ToastInput) => string;
  warning: (toast: ToastInput) => string;
  loading: (toast: ToastInput) => string;
  update: (id: string, toast: ToastInput) => boolean;
  /** Closes one toast, or every toast without an id. */
  dismiss: (id?: string) => void;
};

export type ToastRegionProps = PartProps & {
  side?: "top" | "bottom";
  align?: "start" | "center" | "end";
  /** How many toasts show before the rest wait behind them. */
  maxVisible?: number;
  /** Keeps the stack open instead of opening on hover and focus. */
  expanded?: boolean;
  /** Renders one toast with `Toast` (root), `Title`, `Description`, `Action` and `Close`. */
  toast: (toast: () => ToastView) => JSX.Element;
};

export type ToasterParts = {
  toaster: Toaster;
  /** The landmark the toasts show in; place it once per Workspace. */
  Region: (props: ToastRegionProps) => JSX.Element;
  /** One toast; pass its `id`. */
  Toast: (props: PartProps & { id: string }) => JSX.Element;
  Title: (props: PartProps & { id: string }) => JSX.Element;
  Description: (props: PartProps & { id: string }) => JSX.Element;
  /** The toast's action button; it runs `action.onAction`. */
  Action: (props: PartProps & { id: string }) => JSX.Element;
  /** Closes the toast. */
  Close: (props: PartProps & { id: string }) => JSX.Element;
};

const kinds: readonly ToastKind[] = ["default", "success", "error", "info", "warning", "loading"];
const kindOf = (type: unknown): ToastKind => kinds.find((kind) => kind === type) ?? "default";
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const labelOf = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "label" in value ? text(value.label) : undefined;

/** The region's items (core's `{ toast, index }`) as views, by id. */
const viewsOf = (items: unknown): ToastView[] => {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null || !("toast" in item)) return [];
    const toast: unknown = item.toast;
    if (typeof toast !== "object" || toast === null || !("id" in toast) || typeof toast.id !== "string") return [];
    const index = "index" in item && typeof item.index === "number" ? item.index : 0;
    return [
      {
        id: toast.id,
        type: kindOf("type" in toast ? toast.type : undefined),
        title: text("title" in toast ? toast.title : undefined),
        description: text("description" in toast ? toast.description : undefined),
        actionLabel: labelOf("action" in toast ? toast.action : undefined),
        cancelLabel: labelOf("cancel" in toast ? toast.cancel : undefined),
        index,
      },
    ];
  });
};

/** A toaster and its region for one owner (a Workspace), with German and English region texts. */
export function useToaster(options: { duration?: number } = {}): ToasterParts {
  const t = useBehaviorMessages();
  // The toaster keeps its own overlay registry, so nothing it shows outlives its owner (or reaches another request).
  const core = createToaster<string>({ duration: options.duration, overlays: createOverlays() });
  const toaster: Toaster = {
    show: (toast) => core(toast),
    success: (toast) => core.success(toast),
    error: (toast) => core.error(toast),
    info: (toast) => core.info(toast),
    warning: (toast) => core.warning(toast),
    loading: (toast) => core.loading(toast),
    update: (id, toast) => core.update(id, toast),
    dismiss: (id) => core.dismiss(id),
  };
  const useRegion = (props: () => Props) =>
    usePrimitive(toastRegion, () => ({ ...props(), toaster: core, placed: true, label: t().toasts, pendingAnnouncement: t().loading }));
  const RegionContext = createContext<ReturnType<typeof useRegion>>();
  const handle = () => {
    const region = useContext(RegionContext);
    if (!region) throw new Error("Toast parts must be rendered inside the toaster's Region.");
    return region;
  };
  return {
    toaster,
    Region: (props) => {
      const [own, rest] = splitProps(props, ["side", "align", "maxVisible", "expanded", "toast"]);
      const current = useRegion(() => ({ side: own.side, align: own.align, maxVisible: own.maxVisible, expanded: own.expanded }));
      const list = (state: Props) => {
        const views = () => viewsOf(state.toasts);
        // Rows keyed by id, so an update or a new toast in front keeps the others' elements (and focus).
        return part(
          current,
          "list",
          undefined,
          {
            children: (
              <For each={views().map((view) => view.id)}>
                {(id) => own.toast(() => views().find((view) => view.id === id) ?? { id, type: "default", index: 0 })}
              </For>
            ),
          },
          "ol",
        );
      };
      return (
        <RegionContext.Provider value={current}>
          {part(current, "region", undefined, mergeProps(rest, { children: list }), "section")}
        </RegionContext.Provider>
      );
    },
    Toast: (props) => {
      const [own, rest] = splitProps(props, ["id"]);
      return part(handle(), "root", () => ({ id: own.id }), rest, "li");
    },
    Title: (props) => {
      const [own, rest] = splitProps(props, ["id"]);
      return part(handle(), "title", () => ({ id: own.id }), rest, "div");
    },
    Description: (props) => {
      const [own, rest] = splitProps(props, ["id"]);
      return part(handle(), "description", () => ({ id: own.id }), rest, "div");
    },
    Action: (props) => {
      const [own, rest] = splitProps(props, ["id"]);
      const id = createUniqueId();
      return part(handle(), "action", () => ({ id, toast: own.id }), mergeProps({ type: "button" }, rest), "button");
    },
    Close: (props) => {
      const [own, rest] = splitProps(props, ["id"]);
      const id = createUniqueId();
      return part(handle(), "close", () => ({ id, toast: own.id }), mergeProps({ type: "button" }, rest), "button");
    },
  };
}
