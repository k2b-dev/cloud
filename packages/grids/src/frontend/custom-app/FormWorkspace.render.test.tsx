import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../_components/ssr-test-plugin";

const { default: FormWorkspace } = await import("./FormWorkspace.island.tsx");
test("the complete form workspace renders through the real island serialization boundary", () => {
  const html = renderToString(() =>
    createComponent(FormWorkspace, {
      showTitle: true,
      dateConfig: { locale: "en", timeZone: "UTC" },
      data: {
        ok: true,
        submitUrl: "/save",
        form: { id: "FORM01", name: "Invoice draft", config: { fields: [], submitLabel: "Save draft" } },
        fields: [],
        inlineTargetFields: {},
        initialRecord: { version: 1, values: {}, inlineCreates: {} },
      },
      actions: [
        {
          id: "issue",
          kind: "workflow",
          launcherId: "ISSUE1",
          label: "Issue invoice",
          endpoint: "/issue",
          background: { acceptedMessage: "Requested", state: { status: "running" } },
        },
      ],
    }),
  );
  expect(html).toContain("Invoice draft");
  expect(html).toContain("Save draft");
  expect(html).toMatch(/<fieldset[^>]*disabled/);
});
