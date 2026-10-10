import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import type { DashboardTiles } from "./widget-board";

/**
 * The board's widget answers on this page, for the edit dialog in the page header, which is a separate island. Only
 * the browser writes it; on the server it stays empty, so no request ever sees another one's answers.
 */
const [tiles, setTiles] = createSignal<DashboardTiles>({});

export const dashboardTilesOnPage = tiles;

export const publishDashboardTiles = (next: DashboardTiles): void => {
  if (!isServer) setTiles(next);
};
