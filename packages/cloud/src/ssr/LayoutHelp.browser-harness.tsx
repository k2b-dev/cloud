import { LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import type { HelpDocumentManifest, HelpDocumentPayload } from "../shared/help";
import { LayoutHelpPage } from "./LayoutHelp";

const documents: HelpDocumentManifest[] = Array.from({ length: 8 }, (_, index) => ({
  id: `topic-${index}`,
  title: `Topic ${index}`,
  description: "Help browser fixture",
  order: index,
  url: `/api/help/topic-${index}`,
  searchUrl: "/api/help/search",
}));
const html = Array.from(
  { length: 8 },
  (_, index) =>
    `<h2 id="section-${index}" class="help-section-title" data-help-icon="ti ti-point">Section ${index}</h2>${Array.from({ length: 18 }, () => "<p>Read this guidance to finish the task and understand how the app works.</p>").join("")}`,
).join("");
window.fetch = Object.assign(
  async (input: URL | RequestInfo) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const path = String(input);
    if (path.includes("/search")) return Response.json({ locale: "en", ids: ["topic-0", "topic-1"] });
    const id = path.split("/").at(-1) ?? "topic-0";
    const payload: HelpDocumentPayload = { id, locale: "en", title: id, markdown: "Help", html };
    return Response.json(payload);
  },
  { preconnect: () => {} },
);
const main = document.querySelector<HTMLElement>(".layout-content-main");
if (!main) throw new Error("Missing Layout main");
const embedded = new URL(location.href).searchParams.has("embedded");
const host = document.createElement("div");
if (embedded) host.style.cssText = "width:360px;height:700px";
main.append(host);
render(
  () => (
    <LocaleProvider locale="en">
      <LayoutHelpPage documents={documents} embedded={embedded} pageBase="/app/spaces/help" />
    </LocaleProvider>
  ),
  host,
);
