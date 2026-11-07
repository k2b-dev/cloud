import { currentUiSource } from "./portal-scope";

const PORTAL_ATTRIBUTE = "data-k2b-ui-portal";
const PRIMARY_ATTRIBUTE = "data-k2b-primary";

export const getK2bPortalRoot = (scope?: HTMLElement | null, trigger?: Element | null): HTMLElement => {
  const source = trigger ?? scope ?? currentUiSource();
  const owner = scope ?? source?.closest<HTMLElement>(".k2b-ui") ?? document.querySelector<HTMLElement>(".k2b-ui") ?? document.body;
  const primary = source?.closest(`[${PRIMARY_ATTRIBUTE}]`)?.getAttribute(PRIMARY_ATTRIBUTE) ?? null;
  const existing = Array.from(owner.children).find(
    (child) => child instanceof HTMLElement && child.hasAttribute(PORTAL_ATTRIBUTE) && child.getAttribute(PRIMARY_ATTRIBUTE) === primary,
  );
  if (existing instanceof HTMLElement) return existing;

  const root = document.createElement("div");
  root.setAttribute(PORTAL_ATTRIBUTE, "");
  if (primary !== null) root.setAttribute(PRIMARY_ATTRIBUTE, primary);
  root.classList.add("k2b-ui-portal");
  if (owner === document.body && !owner.classList.contains("k2b-ui")) root.classList.add("k2b-ui");
  owner.appendChild(root);
  return root;
};
