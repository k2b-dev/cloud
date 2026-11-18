import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { CodeDecisionPages } from "./code-decision-pages";

registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(join(tmpdir(), "cloud-gl-render-")) });
const [{ default: DecisionLine }, { LocaleProvider }] = await Promise.all([import("./AssistantCodeDecisionLine"), import("@k2b/ui")]);
beforeAll(() => setSystemTime(new Date("2026-11-17T10:00:00Z")));
afterAll(() => setSystemTime());
const page = (path: string, title: string | null = null) => ({
  entrypoint: `GET:${path}`,
  path,
  title,
  isRoot: path === "/",
  href: `/code/c_opaque123${path}`,
});
const handoff = (pages = [page("/", "Lieferscheine")]): CodeDecisionPages => ({
  title: "Lieferungen",
  codePageHref: "/app/assistant/code/c_opaque123",
  pages: { versionId: "v_test", homeUrl: pages[0]?.href ?? null, pages },
});
const render = (pages: CodeDecisionPages | null, locale = "de", outcome: "activated" | "approved" = "activated") =>
  renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(DecisionLine, {
          decision: {
            codeId: "c_opaque123",
            versionId: "v_test",
            number: 3,
            outcome,
            person: { id: null, name: null },
            anchor: "version-card",
          },
          at: "2026-11-17T09:30:00Z",
          timeZone: "UTC",
          pages,
        });
      },
    }),
  );

test("Cloud appends one quiet link card with name, readable path and Open to its activation fact", () => {
  const html = render(handoff());
  expect(html).toContain("Du hast Version 3 eingeschaltet");
  expect(html).toContain("Lieferscheine");
  expect(html).toContain("Startseite");
  expect(html).toContain("Öffnen");
  expect(html).toContain('href="/code/c_opaque123/"');
  const text = html.replace(/<[^>]*>/g, "");
  expect(text).not.toContain("c_opaque123");
  expect(html.match(/k2b-link-card__chevron/g)).toHaveLength(1);
});
test("multiple pages keep the home card and quiet additional text links", () => {
  const html = render(handoff([page("/", "Lieferscheine"), page("/month", "Monatsübersicht"), page("/settings", "Einstellungen")]));
  expect(html.match(/k2b-link-card__title/g)).toHaveLength(1);
  expect(html).toContain("Weitere Seiten:");
  expect(html).toContain('href="/code/c_opaque123/month"');
  expect(html).toContain("+1 weitere");
  expect(html).toContain('href="/app/assistant/code/c_opaque123"');
});
test("no page or no current management access shows no card, and approval alone never opens a page", () => {
  expect(render(null)).not.toContain("k2b-link-card");
  expect(render(handoff([]))).not.toContain("k2b-link-card");
  expect(render(handoff(), "de", "approved")).not.toContain("k2b-link-card");
});
test("unnamed home uses the app name; other unnamed pages use their readable path; English is complete", () => {
  const html = render(handoff([page("/"), page("/archive")]), "en");
  expect(html).toContain("Lieferungen");
  expect(html).toContain("/archive");
  expect(html).toContain("More pages:");
  expect(html).toContain("Home page");
  expect(html).toContain("Open");
  expect(html.replace(/<[^>]*>/g, "")).not.toContain("c_opaque123");
});

test("a home without a root route shows its readable path", () => {
  const html = render(handoff([page("/month", "Monat")]));
  expect(html).toContain("/month");
  expect(html).not.toContain("Startseite");
});
