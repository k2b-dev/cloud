const PORTAL_ATTRIBUTE = "data-k2b-ui-portal";

const activeScope = (): HTMLElement | undefined => {
  const active = document.activeElement;
  return active instanceof Element ? ((active.closest(".k2b-ui") as HTMLElement | null) ?? undefined) : undefined;
};

export const getK2bPortalRoot = (scope?: HTMLElement | null): HTMLElement => {
  const owner = scope ?? activeScope() ?? document.querySelector<HTMLElement>(".k2b-ui") ?? document.body;
  const existing = Array.from(owner.children).find((child) => child instanceof HTMLElement && child.hasAttribute(PORTAL_ATTRIBUTE));
  if (existing instanceof HTMLElement) return existing;

  const root = document.createElement("div");
  root.setAttribute(PORTAL_ATTRIBUTE, "");
  root.classList.add("k2b-ui-portal");
  if (owner === document.body && !owner.classList.contains("k2b-ui")) root.classList.add("k2b-ui");
  owner.appendChild(root);
  return root;
};
