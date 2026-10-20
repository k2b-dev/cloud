import { AppWorkspace, LocaleProvider } from "@k2b/ui";
import { render } from "solid-js/web";
import { registerContextAwareCommand } from "../browser/command-bridge";
import type { HelpDocumentManifest, HelpDocumentPayload } from "../shared/help";
import { LayoutHelpPage, openLayoutHelpDialog } from "./LayoutHelp";
import { registry } from "./layout-help-registry";

const params = new URL(location.href).searchParams;
const fixture = (id: string, title: string, order: number, kind?: HelpDocumentManifest["kind"], icon?: string): HelpDocumentManifest => ({
  id,
  title,
  description: "Help browser fixture",
  order,
  ...(kind ? { kind } : {}),
  ...(icon ? { icon } : {}),
  url: `/api/help/${id}`,
  searchUrl: "/api/help/search",
});
// `?start`: an app with every kind and more tasks than the start shows as tiles.
const startDocuments: HelpDocumentManifest[] = [
  fixture("share-space", "Share a Space", 10, "task", "ti ti-share"),
  fixture("claim-task", "Claim a task", 20, "task", "ti ti-hand-grab"),
  fixture("statuses", "Create and order statuses", 30, "task", "ti ti-arrows-sort"),
  fixture("calendar-feed", "See dates in your own calendar", 40, "task", "ti ti-calendar-share"),
  fixture("templates", "Start from a template", 50, undefined, "ti ti-template"),
  fixture("filters", "Filter and find items", 60, "task", "ti ti-filter"),
  fixture("handoffs", "Hand work over", 70, "task", "ti ti-arrows-exchange"),
  fixture("archive", "Archive a Space", 80, "task", "ti ti-archive"),
  fixture("import", "Import tasks from a spreadsheet with a very long title that wraps", 90, "task", "ti ti-table-import"),
  fixture("recurring", "Repeat a task", 100, "task", "ti ti-repeat"),
  fixture("start", "Start with Spaces", 5, "start", "ti ti-rocket"),
  fixture("access-levels", "Access levels", 110, "reference", "ti ti-key"),
  fixture("troubleshoot", "Fix problems in Spaces", 120, "troubleshoot", "ti ti-lifebuoy"),
];
const documents: HelpDocumentManifest[] = params.has("start")
  ? startDocuments
  : Array.from({ length: 8 }, (_, index) => fixture(`topic-${index}`, `Topic ${index}`, index));
// `?commands`: what the shell and an app register on a real page.
if (params.has("commands")) {
  for (const command of [
    { id: "cloud.shell.focus", title: "Hide sidebar", description: "", shortcut: "mod+\\" },
    { id: "cloud.search", title: "Open global search", description: "", shortcut: "mod+k" },
    { id: "cloud.help", title: "Open shortcut help", description: "", shortcut: "shift+/" },
    { id: "spaces.new", title: "New task", description: "", shortcut: "n" },
    { id: "spaces.filter", title: "Filter tasks", description: "", shortcut: "f" },
    { id: "spaces.complete", title: "Complete selected", description: "", shortcut: "x", scope: "selection" as const },
  ])
    registerContextAwareCommand({ ...command, action: () => {} });
}
const lead = "<p>Share a Space so that other people can see and change its tasks.</p>";
const longHtml =
  lead +
  Array.from(
    { length: 8 },
    (_, index) =>
      `<h2 id="section-${index}" class="help-section-title">Section ${index}</h2>${Array.from({ length: 18 }, () => "<p>Read this guidance to finish the task and understand how the app works.</p>").join("")}`,
  ).join("");
// A short task article: the short answer, one section, four steps.
const taskHtml = `${lead}<h2 id="invite-people" class="help-section-title">Invite people</h2><div class="help-steps"><ol class="k2b-steps"><li>Open <span class="k2b-label-chip">Space settings</span>.</li><li>Choose <span class="k2b-label-chip">Add person</span>.</li><li>Enter a name or a group.</li><li>Choose the access level.</li></ol></div><p>Spaces saves the change at once.</p><div class="help-compare"><ul><li><strong>Add a person</strong> Gives one named person access to every task in this Space.</li><li><strong>Add a group</strong> Gives everyone in the group access, including people who join later.</li></ul></div>`;
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
    if (path.includes("/search")) {
      const query = new URL(path, location.href).searchParams.get("q") ?? "";
      const ids = params.has("start")
        ? documents.filter((document) => document.title.toLocaleLowerCase().includes(query)).map((document) => document.id)
        : ["topic-0", "topic-1"];
      // Tests wait for an answered search by this count, not for a spinner that can come and go between two polls (#1403).
      document.documentElement.dataset.helpSearches = String(Number(document.documentElement.dataset.helpSearches ?? 0) + 1);
      return Response.json({ locale: "en", ids });
    }
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
const embedded = params.has("embedded");
const referenceHost = params.get("host");
if (referenceHost === "grids" || referenceHost === "pulse") {
  // The Grids and Pulse query reference windows: one article beside the reference sidebar, without the Cloud shell.
  const host = document.createElement("div");
  host.className = "h-dvh";
  document.body.replaceChildren(host);
  const reader = () => <LayoutHelpPage documents={documents.slice(0, 1)} initialTopic="topic-0" includeShortcuts={false} embedded />;
  render(
    () => (
      <LocaleProvider locale="en">
        <AppWorkspace>
          <AppWorkspace.Sidebar>
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarBody>Reference</AppWorkspace.SidebarBody>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            {referenceHost === "grids" ? (
              <AppWorkspace.Main class="p-[var(--ui-space-shell)]" scroll={false}>
                <div class="flex min-h-0 flex-1 flex-col overflow-auto">{reader()}</div>
              </AppWorkspace.Main>
            ) : (
              <AppWorkspace.Main class="overflow-y-auto">{reader()}</AppWorkspace.Main>
            )}
          </AppWorkspace.Content>
        </AppWorkspace>
      </LocaleProvider>
    ),
    host,
  );
} else if (params.has("modal")) {
  // The dialog reads the topics the page registered, as Layout.HelpDocuments does.
  for (const manifest of documents) registry()?.set(manifest.id, manifest);
  window.__cloudLayoutHelpPageBase = "/app/spaces/help";
  openLayoutHelpDialog();
} else {
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
}
