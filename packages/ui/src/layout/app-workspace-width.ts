/** A width that follows the workspace's own border-box width: clamp(min, share × workspace width + offset, max), in px. */
export type AppWorkspaceWidthShare = { share: number; offset?: number; min: number; max: number };

export const isAppWorkspaceWidthShare = (value: unknown): value is AppWorkspaceWidthShare => {
  if (!value || typeof value !== "object" || !("share" in value) || !("min" in value) || !("max" in value)) return false;
  return (
    typeof value.share === "number" &&
    value.share > 0 &&
    value.share < 1 &&
    Number.isFinite(value.min) &&
    Number.isFinite(value.max) &&
    typeof value.min === "number" &&
    typeof value.max === "number" &&
    value.min <= value.max &&
    (!("offset" in value) || value.offset === undefined || (typeof value.offset === "number" && Number.isFinite(value.offset)))
  );
};

export const appWorkspaceWidthToken = (value: number | AppWorkspaceWidthShare): string =>
  typeof value === "number" ? String(value) : `share:${value.share},${value.offset ?? 0},${value.min},${value.max}`;

export const readAppWorkspaceWidth = (token: string | undefined): number | AppWorkspaceWidthShare | undefined => {
  if (!token) return undefined;
  if (!token.startsWith("share:")) {
    const value = Number(token);
    return Number.isFinite(value) ? value : undefined;
  }
  const [share, offset, min, max] = token.slice(6).split(",").map(Number);
  const value = { share, offset, min, max };
  return isAppWorkspaceWidthShare(value) ? value : undefined;
};

export const resolveAppWorkspaceWidth = (value: number | AppWorkspaceWidthShare, workspaceWidth: number): number =>
  typeof value === "number" ? value : Math.min(value.max, Math.max(value.min, value.share * workspaceWidth + (value.offset ?? 0)));

export const appWorkspaceWidthCss = (value: number | AppWorkspaceWidthShare, width: string): string =>
  typeof value === "number" ? `${value}px` : `clamp(${value.min}px, ${value.share} * ${width} + ${value.offset ?? 0}px, ${value.max}px)`;

export const appWorkspaceInverseWidthCss = (value: AppWorkspaceWidthShare, width: string): string =>
  `clamp(${value.min}px, (${value.share} * (${width} + var(--k2b-workspace-sidebar-space) + 2px - 20rem) + ${value.offset ?? 0}px) / ${1 - value.share}, ${value.max}px)`;
