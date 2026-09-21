import { PANES_LAYOUT_VERSION, type PanesLayout, parsePanesLayout, reconcilePanesLayout } from "@k2b/ui";

export const QUERY_EXPLORER_PANES_KEY = "pulse.query-explorer";
export const DASHBOARD_EDITOR_PANES_KEY = "pulse.dashboard-editor";

export const QUERY_EXPLORER_ITEM_IDS = ["result", "editor", "browse", "saved", "history"];
export const DASHBOARD_EDITOR_ITEM_IDS = ["preview", "editor", "inventory", "diagnostics"];

const cookieName = (storageKey: string) => `pulse_panes_${storageKey.replace(/[^A-Za-z0-9_-]/g, "_")}`;

export const createQueryExplorerPanesLayout = (): PanesLayout => ({
  version: PANES_LAYOUT_VERSION,
  root: {
    type: "split",
    direction: "vertical",
    ratio: 0.42,
    first: { type: "group", items: ["result"], active: "result" },
    second: {
      type: "split",
      direction: "horizontal",
      ratio: 0.68,
      first: { type: "group", items: ["editor"], active: "editor" },
      second: { type: "group", items: ["browse", "saved", "history"], active: "browse" },
    },
  },
});

export const createDashboardEditorPanesLayout = (): PanesLayout => ({
  version: PANES_LAYOUT_VERSION,
  root: {
    type: "split",
    direction: "vertical",
    ratio: 0.48,
    first: { type: "group", items: ["preview"], active: "preview" },
    second: {
      type: "split",
      direction: "horizontal",
      ratio: 0.68,
      first: { type: "group", items: ["editor"], active: "editor" },
      second: { type: "group", items: ["inventory", "diagnostics"], active: "inventory" },
    },
  },
});

export const readPulsePanesLayoutCookie = (cookieHeader: string | null | undefined, storageKey: string): PanesLayout | null => {
  if (!cookieHeader) return null;
  const name = cookieName(storageKey);
  const encoded = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!encoded) return null;
  try {
    return parsePanesLayout(JSON.parse(decodeURIComponent(encoded)) as unknown);
  } catch {
    return null;
  }
};

export const initialPulsePanesLayout = (
  persisted: PanesLayout | null | undefined,
  fallback: PanesLayout,
  itemIds: readonly string[],
): PanesLayout => reconcilePanesLayout(persisted ?? fallback, itemIds);

export const persistPulsePanesLayout = (storageKey: string, layout: PanesLayout) => {
  if (typeof document === "undefined") return;
  const encoded = encodeURIComponent(JSON.stringify(layout));
  document.cookie = `${cookieName(storageKey)}=${encoded}; Path=/; Max-Age=31536000; SameSite=Lax`;
};
