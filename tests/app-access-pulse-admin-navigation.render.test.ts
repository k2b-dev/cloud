import { afterAll, expect, setSystemTime, test } from "bun:test";
import { renderAdminNavigation } from "./app-access-pulse-admin-navigation.fixture";

setSystemTime(new Date("2026-10-21T12:00:00Z"));
afterAll(() => setSystemTime());

test("Pulse is one active entry under App administration in both SSR navigation surfaces", async () => {
  for (const [locale, group, tab] of [
    ["en", "App administration", "Data store"],
    ["de", "App-Administration", "Datenspeicher"],
  ] as const) {
    const result = await renderAdminNavigation(locale);
    expect(result.status).toBe(200);
    expect(result.reads).toBe(1);
    const sections: string[] = [];
    let mobile = "";
    const links: { href: string | null; current: string | null }[] = [];
    new HTMLRewriter()
      .on(".k2b-app-workspace__sidebar-section-header h2", { text: (text) => void sections.push(text.text) })
      .on("script[data-cloud-workspace-navigation]", {
        text: (text) => {
          mobile += text.text;
        },
      })
      .on('a[href="/admin/pulse"]', {
        element: (element) => void links.push({ href: element.getAttribute("href"), current: element.getAttribute("aria-current") }),
      })
      .transform(result.html);
    expect(sections).toContain(group);
    expect(sections).not.toContain("Pulse");
    expect(links).toEqual([{ href: "/admin/pulse", current: "page" }]);
    // The serialized public WorkspaceNavigation snapshot supplies the phone menu.
    expect(JSON.parse(mobile)).toMatchObject({
      items: expect.arrayContaining([
        {
          id: group,
          label: group,
          children: [{ id: "/admin/pulse", label: "Pulse", href: "/admin/pulse", icon: "ti ti-activity-heartbeat", active: true }],
        },
      ]),
    });
    expect(result.html).toContain(`Pulse: ${tab}`);
    expect(result.html).toContain('href="?view=store"');
  }
});

test("the existing admin route still rejects ordinary people and anonymous visitors before data reads", async () => {
  for (const role of ["user", "anonymous"] as const) {
    const result = await renderAdminNavigation("de", role);
    expect(result.status).toBe(role === "user" ? 403 : 302);
    expect(result.reads).toBe(0);
    expect(result.html).not.toContain('href="/admin/pulse"');
    if (role === "anonymous") expect(result.location).toContain("/auth");
  }
});
