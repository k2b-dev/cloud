import { currentUiSource, readUiScope } from "./portal-scope";

const PORTAL_ATTRIBUTE = "data-k2b-ui-portal";
const PRIMARY_ATTRIBUTE = "data-k2b-primary";

export const getK2bPortalRoot = (
  scope?: HTMLElement | null,
  trigger?: Element | null,
  doc = trigger?.ownerDocument ?? scope?.ownerDocument ?? document,
): HTMLElement => {
  const source = trigger ?? currentUiSource();
  const owner = scope ?? source?.closest<HTMLElement>(".k2b-ui") ?? doc.querySelector<HTMLElement>(".k2b-ui") ?? doc.body;
  const primary = readUiScope(trigger ?? undefined).primary;
  const existing = Array.from(owner.querySelectorAll<HTMLElement>(`:scope > [${PORTAL_ATTRIBUTE}]`)).find(
    (child) => child.getAttribute(PRIMARY_ATTRIBUTE) === primary,
  );
  if (existing) return existing;

  const root = doc.createElement("div");
  root.setAttribute(PORTAL_ATTRIBUTE, "");
  if (primary !== null) root.setAttribute(PRIMARY_ATTRIBUTE, primary);
  root.classList.add("k2b-ui-portal");
  if (owner === doc.body && !owner.classList.contains("k2b-ui")) root.classList.add("k2b-ui");
  owner.appendChild(root);
  return root;
};
