import { readShellData } from "../ssr/shell-data";
import type { PanelRequest } from "./panel";

/** The initial slot bridge; the full lifecycle controller extends this module. */
export function handlePanelRequest(request: PanelRequest): void {
  const canvas = document.querySelector<HTMLElement>(".cloud-app-canvas");
  const slot = document.getElementById("cloud-panel");
  const panel = readShellData()?.panel;
  if (!canvas || !slot || !panel) return;
  const attribute = window.matchMedia("(max-width: 47.999rem)").matches ? "data-panel-sheet" : "data-panel";
  const open = request.action === "open" || (request.action === "toggle" && canvas.getAttribute(attribute) !== "open");
  const provider = panel.providers.find(
    (provider) => provider.id === (request.action === "open" ? request.provider : (slot.dataset.provider ?? panel.provider)),
  );
  if (open && !provider) return;
  slot.querySelector("iframe")?.remove();
  if (!open) {
    canvas.removeAttribute(attribute);
    slot.dataset.state = "closed";
    return;
  }
  if (!provider) return;
  canvas.setAttribute(attribute, "open");
  slot.dataset.provider = provider.id;
  slot.dataset.state = "loading";
  const frame = document.createElement("iframe");
  const url = new URL(provider.href, location.origin);
  if (request.action === "open" && typeof request.search === "string" && request.search.length <= 2048) url.search = request.search;
  frame.src = `${url.pathname}${url.search}${url.hash}`;
  frame.title = provider.label;
  frame.className = "cloud-panel__frame";
  frame.dataset.cloudPanelFrame = provider.id;
  slot.querySelector(".cloud-panel__body")?.append(frame);
}

let dispose: (() => void) | undefined;
export function installPanelSlot(): () => void {
  if (dispose) return dispose;
  const slot = document.getElementById("cloud-panel");
  const click = (event: MouseEvent) => {
    if (event.target instanceof Element && event.target.closest("[data-cloud-panel-close]")) handlePanelRequest({ action: "close" });
  };
  slot?.addEventListener("click", click);
  dispose = () => {
    slot?.removeEventListener("click", click);
    dispose = undefined;
  };
  return dispose;
}
