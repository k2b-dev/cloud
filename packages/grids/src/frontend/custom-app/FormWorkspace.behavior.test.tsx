import { expect, test } from "bun:test";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../ui/test/dom";
import type { PublicField } from "../../api/public-dto";

const domTest = isServer ? test.skip : test;
const field: PublicField = {
  id: "FIELD1",
  tableId: "TABLE1",
  name: "Customer reference",
  type: "text",
  config: {},
  required: true,
  description: null,
  deletedAt: null,
  createdAt: "2026-09-17T00:00:00Z",
  updatedAt: "2026-09-17T00:00:00Z",
  position: 0,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
};

domTest("an edited form cannot issue its previously saved record, including after an ambiguous save", async () => {
  const dom = createDomTestHarness();
  const { default: FormWorkspace } = await import("./FormWorkspace.island");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      throw new TypeError("Connection interrupted");
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(
    () => (
      <FormWorkspace
        showTitle
        dateConfig={{ locale: "en", timeZone: "UTC" }}
        data={{
          ok: true,
          submitUrl: "/save",
          form: {
            id: "FORM01",
            name: "Draft",
            config: {
              fields: [{ kind: "user_input", fieldId: field.id }],
              submitLabel: "Save draft",
            },
          },
          fields: [field],
          inlineTargetFields: {},
          initialRecord: { version: 1, values: { FIELD1: "Original" }, inlineCreates: {} },
        }}
        actions={[
          {
            id: "issue",
            kind: "workflow",
            label: "Issue invoice",
            endpoint: "/issue",
            variant: "primary",
            background: { acceptedMessage: "Requested", state: { status: "draft" } },
          },
        ]}
      />
    ),
    dom.root,
  );
  try {
    const issue = () =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Issue invoice"))!;
    expect(issue().disabled).toBe(false);
    const input = dom.root.querySelector("input")!;
    input.value = "Changed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(issue().disabled).toBe(true);
    expect(dom.root.textContent).toContain("Save your changes before continuing");
    issue().click();
    expect(requests).toEqual([]);
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Save draft"))!
      .click();
    await Bun.sleep(5);
    expect(requests).toEqual(["/save"]);
    expect(issue().disabled).toBe(true);
    issue().click();
    expect(requests).toEqual(["/save"]);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("accepted issuance locks editing while its saved record is being processed", async () => {
  const dom = createDomTestHarness();
  const { default: FormWorkspace } = await import("./FormWorkspace.island");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Response.json({ status: "running" });
    },
    { preconnect: originalFetch.preconnect },
  );
  const dispose = render(
    () => (
      <FormWorkspace
        showTitle
        dateConfig={{ locale: "en", timeZone: "UTC" }}
        data={{
          ok: true,
          submitUrl: "/save",
          form: {
            id: "FORM01",
            name: "Draft",
            config: {
              fields: [{ kind: "user_input", fieldId: field.id }],
              submitLabel: "Save draft",
            },
          },
          fields: [field],
          inlineTargetFields: {},
          initialRecord: { version: 1, values: { FIELD1: "Original" }, inlineCreates: {} },
        }}
        actions={[
          {
            id: "issue",
            kind: "workflow",
            label: "Issue invoice",
            endpoint: "/issue",
            background: { acceptedMessage: "Requested", state: { status: "draft" } },
          },
        ]}
      />
    ),
    dom.root,
  );
  try {
    Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("Issue invoice"))!
      .click();
    await Bun.sleep(10);
    expect(dom.root.querySelector("fieldset")!.disabled).toBe(true);
    dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(5);
    expect(requests).toEqual(["/issue"]);
    expect(dom.root.textContent).toContain("Requested");
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});
