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
const lead = "<p>Share a Space so that other people can see and change its tasks.</p>";
const longHtml =
  lead +
  Array.from(
    { length: 8 },
    (_, index) =>
      `<h2 id="section-${index}" class="help-section-title">Section ${index}</h2>${Array.from({ length: 18 }, () => "<p>Read this guidance to finish the task and understand how the app works.</p>").join("")}`,
  ).join("");
// A short task article: the short answer, one section, four steps.
const taskHtml = `${lead}<h2 id="invite-people" class="help-section-title">Invite people</h2><div class="help-steps"><ol class="k2b-steps"><li>Open <span class="k2b-label-chip">Space settings</span>.</li><li>Choose <span class="k2b-label-chip">Add person</span>.</li><li>Enter a name or a group.</li><li>Choose the access level.</li></ol></div><p>Spaces saves the change at once.</p>`;
const link = (id: string, title: string, appId = "spaces", appName = "Spaces") => ({
  appId,
  appName,
  accent: appId === "spaces" ? "#16a34a" : "#2563eb",
  documentId: id,
  title,
  description: "Help browser fixture",
  url: `/help/apps/${appId}/${id}`,
});
window.fetch = Object.assign(
  async (input: URL | RequestInfo) => {
    await new Promise((resolve) => setTimeout(resolve, 80));
    const path = String(input);
    if (path.includes("/search")) return Response.json({ locale: "en", ids: ["topic-0", "topic-1"] });
    const id = path.split("/").at(-1) ?? "topic-0";
    const payload: HelpDocumentPayload = {
      id,
      locale: "en",
      title: id,
      markdown: "Help",
      html: id === "topic-1" ? taskHtml : longHtml,
      kind: "task",
      needs: "manage",
      next: link("topic-2", "Topic 2"),
      related: [link("topic-3", "Topic 3"), link("mail-share", "Share a mailbox", "mail", "Mail")],
    };
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
