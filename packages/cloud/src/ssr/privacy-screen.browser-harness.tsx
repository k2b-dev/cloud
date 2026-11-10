import { AppWorkspace } from "@k2b/ui";
import { Hono } from "hono";
import { defineApp } from "../_internal/define-app";
import { person } from "../_internal/define-app.test-fixture";
import type { User } from "../contracts/shared";
import Layout from "./Layout";
import type { RuntimeContext } from "./runtime";

const probe = defineApp({
  id: "privacy-probe",
  name: "Privacy probe",
  icon: "ti ti-mail",
  description: "Privacy screen browser fixture",
  baseUrl: "http://privacy-probe:3000",
  routes: ["/app/privacy"],
});
type Environment = { Variables: { runtime: RuntimeContext; user: User } };

/** A Mail-like page with fictional data: a list, a reader with an editor, a counter button, and two islands. */
export const server = new Hono<Environment>()
  .use(async (c, next) => {
    c.set("runtime", {
      apps: [
        {
          id: "privacy-probe",
          name: "Mail",
          description: "Privacy screen browser fixture",
          icon: "ti ti-mail",
          routes: ["/app/privacy"],
          nav: { href: "/app/privacy", section: "primary" },
        },
      ],
    });
    c.set("user", person);
    await next();
  })
  .get(
    "/app/privacy",
    ...probe.ssr<Environment>((c) => () => (
      <Layout c={c} fullWidth fullPage title={[{ title: "Mail", href: "/app/privacy" }, { title: "Inbox" }]}>
        <AppWorkspace mobileSurface="flush" class="min-h-0 flex-1">
          <AppWorkspace.Sidebar id="privacy-navigation" label="Mailboxes">
            <AppWorkspace.SidebarDesktop>
              <AppWorkspace.SidebarItem href="/app/privacy" active>
                Inbox
              </AppWorkspace.SidebarItem>
            </AppWorkspace.SidebarDesktop>
          </AppWorkspace.Sidebar>
          <AppWorkspace.Content>
            <AppWorkspace.Main>
              <h2 id="subject">Angebot Umbau 2. OG – bitte prüfen</h2>
              <p>Lea Brandt · heute 09:42</p>
              <p>
                Hallo Valentin, anbei das überarbeitete Angebot für den Umbau im 2. OG. Gegenüber der ersten Fassung sind die
                Trockenbauarbeiten um 8.400 € günstiger, dafür kommen zwei Positionen für die Elektrik dazu.
              </p>
              <button type="button" id="counter">
                Archivieren
              </button>
              <textarea id="reply" aria-label="Antwort" />
              <div id="upload" data-cloud-privacy="keep">
                <b>42 %</b> 3 Dateien · noch etwa 1 min
                <button type="button" id="upload-cancel">
                  Abbrechen
                </button>
                <span id="upload-names" data-cloud-privacy="blur">
                  Gehaltsübersicht 2026.xlsx
                </span>
              </div>
            </AppWorkspace.Main>
          </AppWorkspace.Content>
        </AppWorkspace>
      </Layout>
    )),
  );
