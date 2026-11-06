import { expect, test } from "bun:test";
import type { CodePageData } from "@k2b/cloud/ssr/code-page";
import { LocaleProvider } from "@k2b/ui";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { default: BaseCode } = await import("./BaseCode.island");

test.each(["en", "de"])("the Base page renders the shared Code surface in %s", (locale) => {
  const code: CodePageData = {
    owner: { kind: "resource", ref: { type: "grids.base", id: "BASE01" }, title: "Inventory", typeTitle: "Grids base" },
    href: "/app/grids/BASE01/code",
    tab: "overview",
    canManageOwner: true,
    activation: { allowed: true },
    editor: null,
    dates: { timeZone: "UTC", locale, firstDayOfWeek: 1, now: "2026-11-06T00:00:00.000Z" },
    activatedNotice: null,
    cloudAdmin: false,
    state: { kind: "none" },
  };
  const html = renderToString(() =>
    createComponent(LocaleProvider, {
      locale,
      get children() {
        return createComponent(BaseCode, { code });
      },
    }),
  );
  expect(html).toContain("Inventory");
  expect(html).toContain("cloud-code");
  expect(html).toContain("cld code pull grids/BASE01");
});
