export type PanelRequest = { action: "open"; provider: string; search?: string; accepted: boolean } | { action: "close" | "toggle" };

declare global {
  interface WindowEventMap {
    "cloud.panel.request": CustomEvent<PanelRequest>;
  }
}

/** Opens a visible provider. False leaves navigation with the caller when this page has no matching slot. */
export function openPanel(provider: string, options?: { search?: string }): boolean {
  const detail: PanelRequest = {
    action: "open",
    provider,
    search: typeof options?.search === "string" && options.search.length <= 2048 ? options.search : undefined,
    accepted: false,
  };
  window.dispatchEvent(new CustomEvent("cloud.panel.request", { detail }));
  return detail.accepted;
}

/** Closes the panel when it is open. */
export function closePanel(): void {
  window.dispatchEvent(new CustomEvent<PanelRequest>("cloud.panel.request", { detail: { action: "close" } }));
}
