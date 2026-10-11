import { AppWorkspace } from "@k2b/ui";
import { Hono } from "hono";
import type { JSX } from "solid-js";
import { defineApp } from "../_internal/define-app";
import { person } from "../_internal/define-app.test-fixture";
import Layout from "./Layout";
import PageTrail from "./PageTrail";

// Pages for `page-trail.browser.test.ts`: Accounts-like list and detail pages
// in a workspace, a Files-like folder at any depth, a page without a
// workspace, and a third-party app that draws its own header. All names are
// invented.

const probe = defineApp({
  id: "page-trail-probe",
  name: "Page trail probe",
  icon: "ti ti-route",
  description: "Page trail probe",
  baseUrl: "http://page-trail-probe:3000",
  routes: ["/app/accounts"],
});
const apps = [
  {
    id: "accounts",
    name: "Accounts",
    icon: "ti ti-users",
    description: "People",
    routes: ["/app/accounts"],
    nav: { href: "/app/accounts", section: "primary" },
  },
  {
    id: "files",
    name: "Files",
    icon: "ti ti-files",
    description: "Files",
    routes: ["/app/files"],
    nav: { href: "/app/files", section: "primary" },
  },
  // A third-party app: it draws its own header and places the trail there.
  {
    id: "timetrack",
    name: "Time",
    icon: "ti ti-clock",
    description: "Time tracking",
    routes: ["/app/timetrack"],
    nav: { href: "/app/timetrack", section: "primary" },
  },
  { id: "core", name: "Account", icon: "ti ti-user", description: "Account", routes: ["/me"], nav: { href: "/me", section: "hidden" } },
];
type LayoutContext = Parameters<typeof Layout>[0]["c"];
type Title = { title: string; href?: string }[];

const start = { title: "Start", href: "/" };
const accountsRoot = { title: "Accounts", href: "/app/accounts" };
export const users = Array.from({ length: 60 }, (_, index) => `user${String(index + 1).padStart(2, "0")}`);
export const folders = [
  "Projects for the new community centre",
  "2026 budget year with the second construction phase",
  "Quotes from all invited suppliers",
  "Supplier A, Hartmann and Sons, Bremen branch",
  "Questions about the foundation",
];

const Page = (props: { c: unknown; title: Title; children: JSX.Element }) => (
  <Layout c={props.c as LayoutContext} fullWidth fullPage title={props.title}>
    {props.children}
  </Layout>
);
const AccountsWorkspace = (props: { children: JSX.Element; active?: boolean }) => (
  <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
    <AppWorkspace.Sidebar id="accounts-navigation" label="Accounts">
      <AppWorkspace.SidebarDesktop>
        <AppWorkspace.SidebarItem href="/app/accounts/users" icon="ti ti-user" active={props.active ?? true}>
          Users
        </AppWorkspace.SidebarItem>
      </AppWorkspace.SidebarDesktop>
    </AppWorkspace.Sidebar>
    <AppWorkspace.Content>
      <AppWorkspace.Main scrollPreserveKey="accounts-users">{props.children}</AppWorkspace.Main>
    </AppWorkspace.Content>
  </AppWorkspace>
);
const folderHref = (depth: number) => `/app/files?path=${encodeURIComponent(folders.slice(0, depth).join("/"))}`;
const filesTitle = (depth: number): Title => [
  { title: "Files", href: "/app/files" },
  ...folders.slice(0, depth - 1).map((name, index) => ({ title: name, href: folderHref(index + 1) })),
  { title: folders[depth - 1]! },
];
/** A document in the editor, as Files names it: its way up is its folder with the document's row selected. */
const editorTitle = (depth: number, file: string): Title => [
  ...filesTitle(depth).slice(0, -1),
  { title: folders[depth - 1]!, href: `${folderHref(depth)}&file=${encodeURIComponent(file)}` },
  { title: file.split("/").at(-1)! },
];

export const server = new Hono()
  .use(async (c, next) => {
    c.set("runtime" as never, { apps } as never);
    c.set("user" as never, person as never);
    await next();
  })
  .get(
    "/app/accounts/users",
    ...probe.ssr((c) => {
      const group = c.req.query("group");
      const shown = group ? users.filter((_, index) => index % 2 === 0) : users;
      return () => (
        <Page c={c} title={[start, accountsRoot, { title: "Users" }]}>
          <AccountsWorkspace>
            <h1 class="p-3 font-semibold">{group ? `Users in ${group}` : "Users"}</h1>
            {/* A region that scrolls sideways once its content arrives, as a wide table that renders late does. */}
            <div data-scroll-preserve="accounts-wide" class="accounts-wide" style="width:300px;overflow:auto">
              <div class="accounts-wide-content" style="width:300px;height:8px" />
            </div>
            <table class="w-full">
              <tbody>
                {shown.map((uid) => (
                  <tr style="height:48px">
                    <td>
                      <a href={`/app/accounts/users/${uid}${group ? `?group=${group}` : ""}`}>{uid}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </AccountsWorkspace>
        </Page>
      );
    }),
  )
  .get(
    "/app/accounts/users/:uid",
    ...probe.ssr((c) => {
      const uid = c.req.param("uid") ?? "";
      return () => (
        <Page c={c} title={[start, accountsRoot, { title: "Users", href: "/app/accounts/users" }, { title: uid }]}>
          <AccountsWorkspace active={false}>
            <p class="p-3">Profile of {uid}</p>
            <input aria-label="Note" class="m-3" />
          </AccountsWorkspace>
        </Page>
      );
    }),
  )
  .get(
    "/app/accounts/teams",
    ...probe.ssr((c) => () => (
      <Page c={c} title={[start, accountsRoot, { title: "Directory", href: "/app/accounts/directory" }, { title: "Teams" }]}>
        <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
          <AppWorkspace.Sidebar label="Directory">
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarItem href="/app/accounts/teams" active>
                Teams
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <input aria-label="Search teams" placeholder="Search Teams…" />
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </Page>
    )),
  )
  .get(
    "/app/accounts/teams/engineering",
    ...probe.ssr((c) => () => (
      <Page c={c} title={[start, accountsRoot, { title: "Teams", href: "/app/accounts/teams" }, { title: "Engineering" }]}>
        <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
          <AppWorkspace.Sidebar label="Directory">
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarItem href="/app/accounts/teams">Teams</AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <AppWorkspace.Main>Team members</AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </Page>
    )),
  )
  .get(
    "/app/accounts/directory",
    ...probe.ssr((c) => () => (
      <Page c={c} title={[{ title: "Directory" }]}>
        <h1>Directory</h1>
      </Page>
    )),
  )
  .get(
    "/app/files",
    ...probe.ssr((c) => {
      const depth = (c.req.query("path") ?? "").split("/").filter(Boolean).length || 1;
      const file = c.req.query("view") === "edit" ? c.req.query("file") : undefined;
      return () => (
        <Page c={c} title={file ? editorTitle(depth, file) : filesTitle(depth)}>
          <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
            <AppWorkspace.Sidebar id="files-navigation" label="Storage">
              <AppWorkspace.SidebarDesktop>
                <AppWorkspace.SidebarItem href="/app/files" icon="ti ti-folder">
                  My files
                </AppWorkspace.SidebarItem>
              </AppWorkspace.SidebarDesktop>
            </AppWorkspace.Sidebar>
            <AppWorkspace.Content>
              <AppWorkspace.Main>Folder contents</AppWorkspace.Main>
              <AppWorkspace.Detail id="file-detail" open={c.req.query("detail") === "1"} width="lg">
                Details
              </AppWorkspace.Detail>
            </AppWorkspace.Content>
          </AppWorkspace>
        </Page>
      );
    }),
  )
  .get(
    "/me/notifications/history",
    ...probe.ssr((c) => () => (
      <Page
        c={c}
        title={[
          start,
          { title: "Account", href: "/me" },
          { title: "Notifications", href: "/me/notifications" },
          { title: "Delivery history" },
        ]}
      >
        <div class="p-3">
          <h1 class="text-xl font-semibold">Delivery history</h1>
          <p>Every message sent to you.</p>
        </div>
      </Page>
    )),
  )
  .get(
    "/app/timetrack/entries/:id",
    ...probe.ssr((c) => () => (
      <Page
        c={c}
        title={[
          start,
          { title: "Time", href: "/app/timetrack" },
          { title: "Website relaunch", href: "/app/timetrack/projects/web" },
          { title: "Homepage: agree on drafts" },
        ]}
      >
        <div class="flex min-h-0 flex-1 flex-col">
          <header class="timetrack-head flex min-h-14 items-center gap-2 px-3">
            <PageTrail subtitle="2:15 h" />
            <button type="button" class="ml-auto">
              Start timer
            </button>
          </header>
          <dl class="p-3">
            <dt>Project</dt>
            <dd>Website relaunch</dd>
          </dl>
        </div>
      </Page>
    )),
  );
