import { expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import { registerSsrTestPlugin } from "../../../ui/test/ssr-test-plugin";
import type { ApprovalPage } from "../contracts/approvals";
import { approvalsPage, worstCasePage } from "./approvals.v2.fixture";

registerSsrTestPlugin({ dev: true, rootDir: mkdtempSync(join(tmpdir(), "approvals-v2-render-")) });
const { Approvals } = await import("./v2");
const { LocaleProvider } = await import("@k2b/ui");

const render = (props: { initial?: ApprovalPage; app?: string; link?: string }, locale = "en") => {
  setSystemTime(new Date("2026-10-11T09:00:00.000Z"));
  try {
    return renderToString(() =>
      createComponent(LocaleProvider, {
        locale,
        get children() {
          return createComponent(Approvals, props);
        },
      }),
    );
  } finally {
    setSystemTime();
  }
};
const parts = (html: string, name: string) => html.match(new RegExp(`data-k2-part="${name}"`, "g"))?.length ?? 0;

for (const locale of ["en", "de"])
  test(`${locale}: the server renders the first page as v2 rows grouped by app, without a loading sign or a v1 card`, () => {
    const html = render({ initial: approvalsPage }, locale);
    expect(parts(html, "Section")).toBe(2);
    expect(parts(html, "Row")).toBe(3);
    expect(parts(html, "Loading")).toBe(0);
    expect(html).not.toContain("cloud-approval-frame");
    expect(html).not.toContain("k2b-notice-card");
    expect(html).toContain(locale === "de" ? "3 offen" : "3 open");
    // The full proposal stays behind the row until someone opens it.
    expect(html).not.toContain("customer@example.com");
  });

test("one app's list is one list, and one request shows no count", () => {
  const html = render({ initial: { ...approvalsPage, items: approvalsPage.items.slice(0, 1), count: 1 }, app: "mail" });
  expect(parts(html, "Section")).toBe(0);
  expect(parts(html, "List")).toBe(1);
  expect(html).not.toContain("1 open");
});

test("without a first page the place holds a loading shape, and a resource list stays empty", () => {
  expect(parts(render({}), "Loading")).toBe(1);
  expect(render({ link: "/app/mail/draft" })).toBe("");
});

test("the worst case renders its count, the next page and the way to the other apps", () => {
  const html = render({ initial: worstCasePage }, "de");
  expect(html).toContain("12.345 offen");
  expect(html).toContain("Mehr anzeigen");
  expect(html).toContain("/me/approvals");
  expect(parts(html, "Row")).toBe(4);
});
