import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createConfig } from "@k2b/ssr";
import { createComponent } from "solid-js";
import { renderToString } from "solid-js/web";

const root = mkdtempSync(resolve(tmpdir(), "k2b-ui-signature-input-"));
const { plugin } = createConfig({ dev: true, rootDir: root });
Bun.plugin(plugin());
process.once("exit", () => rmSync(root, { recursive: true, force: true }));

const { LocaleProvider, SignatureInput } = await import("../index");
const { checkSignatureMessages } = await import("./signature-messages");

test("the English and German strings cover the same keys", () => {
  expect(checkSignatureMessages()).toEqual([]);
});

const drawn = {
  kind: "drawn" as const,
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120" width="300" height="120"><g fill="currentColor"><path d="M1 1Z"/></g></svg>',
};

test("server rendering shows a stored drawing, the field contract, and the form value", () => {
  const html = renderToString(() =>
    createComponent(SignatureInput, {
      label: "Signature",
      description: "Confirms the handover.",
      error: "Please sign.",
      required: true,
      name: "signature",
      value: drawn,
    }),
  );
  expect(html).toContain('role="group"');
  expect(html).toMatch(/aria-labelledby="k2b-field-[^"]+-label"/);
  // A group cannot carry aria-required, so its description says the field is required.
  expect(html).toMatch(/aria-describedby="(k2b-field-[^"]+)-required \1-description \1-error"/);
  expect(html).toMatch(/<span id="k2b-field-[^"]+-required" hidden[^>]*>Required<\/span>/);
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain('class="k2b-field__required"');
  expect(html).toContain('viewBox="0 0 300 120"');
  expect(html).toContain('<path d="M1 1Z"');
  expect(html).toContain('aria-label="Drawn signature"');
  expect(html).toContain('type="hidden" name="signature"');
  expect(html).toContain("&quot;kind&quot;:&quot;drawn&quot;");
  expect(html).toContain('role="radiogroup" aria-label="Signature method"');
});

test("a typed value opens the typing mode in the render locale, also read-only without the Type option", () => {
  const typed = renderToString(() =>
    createComponent(LocaleProvider, {
      locale: "de",
      get children() {
        return createComponent(SignatureInput, { label: "Unterschrift", value: { kind: "typed", name: "Ada", svg: "" } });
      },
    }),
  );
  expect(typed).toContain('data-mode="type"');
  expect(typed).toContain('aria-label="Namen eintippen"');
  expect(typed).toContain('value="Ada"');

  const drawOnly = renderToString(() =>
    createComponent(SignatureInput, { label: "Signature", allowTyped: false, value: { kind: "typed", name: "Ada", svg: "" } }),
  );
  expect(drawOnly).toContain('data-mode="type"');
  expect(drawOnly).not.toContain("radiogroup");
  expect(drawOnly).toMatch(/<input[^>]*value="Ada"[^>]*readonly/);
  expect(drawOnly).not.toContain("data-empty");
});

test("disabled and read-only fields render without active controls", () => {
  for (const props of [{ disabled: true }, { readOnly: true }]) {
    const html = renderToString(() => createComponent(SignatureInput, { "aria-label": "Signature", value: drawn, ...props }));
    expect(html).toContain('aria-label="Signature"');
    expect(html.match(/<button[^>]*disabled/g)?.length).toBe(4);
  }
});
