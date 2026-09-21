import { expect, test } from "bun:test";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";
import "../ssr-test-plugin";

const { default: ResourceInput } = await import("./ResourceInput");
const { default: ResourceValue } = await import("../table/ResourceValue");

test("resource input uses the shared field label and a discoverable chooser", () => {
  const html = renderToString(() =>
    createComponent(ResourceInput, {
      name: "attachment",
      label: "Attachment",
      required: true,
      value: { type: "filesv2.entry", id: "opaque-id", title: "Agreement.pdf" },
      onChange() {},
    }),
  );
  expect(html).toContain("Agreement.pdf");
  expect(html).toContain("Attachment");
  expect(html).toContain("Choose resource");
  expect(html).not.toContain("href=");
});
test("resource display never treats retained data as a trusted link", () => {
  const html = renderToString(() =>
    createComponent(ResourceValue, {
      value: { type: "filesv2.entry", id: "opaque-id", title: "<script>bad()</script>" },
    }),
  );
  expect(html).toContain("&lt;script>");
  expect(html).not.toContain("href=");
  expect(html).not.toContain("<script>bad");
});
