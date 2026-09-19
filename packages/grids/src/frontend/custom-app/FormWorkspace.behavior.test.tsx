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
            launcherId: "ISSUE1",
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
            launcherId: "ISSUE1",
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

domTest("workspace focuses missing fields, calculates the same draft and never enables issuance before save", async () => {
  const dom = createDomTestHarness();
  const { default: FormWorkspace } = await import("./FormWorkspace.island");
  const dispose = render(
    () => (
      <FormWorkspace
        showTitle
        dateConfig={{ locale: "en", timeZone: "UTC" }}
        workspace={{
          summaryTitle: "Impact",
          summaryDescription: "Current draft",
          helpTitle: "Inherited details",
          helpText: "Shared settings",
        }}
        data={{
          ok: true,
          submitUrl: "/save",
          form: {
            id: "FORM01",
            name: "Draft",
            config: {
              fields: [{ kind: "user_input", fieldId: field.id, section: { title: "Details", collapsible: true } }],
              computedFields: [{ fieldId: "TOTAL1" }],
            },
          },
          fields: [
            field,
            { ...field, id: "TOTAL1", name: "Total", type: "formula", required: false, config: { expression: "LEN({FIELD1})" } },
          ],
          inlineTargetFields: {},
          initialRecord: { version: 1, values: { FIELD1: "" }, inlineCreates: {} },
        }}
        actions={[
          {
            id: "issue",
            kind: "workflow",
            label: "Issue",
            variant: "primary",
            endpoint: "/issue",
            launcherId: "ISSUE1",
            background: { acceptedMessage: "Requested", state: { status: "draft" } },
          },
          { id: "discard", kind: "workflow", label: "Discard draft", variant: "secondary", endpoint: "/discard", launcherId: "DELETE1" },
        ]}
      />
    ),
    dom.root,
  );
  try {
    const button = (text: string) =>
      Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === text)!;
    expect(button("Issue").disabled).toBe(true);
    expect(button("Discard draft").disabled).toBe(false);
    const missing = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("aside button")).find((item) =>
      item.textContent?.includes("required"),
    )!;
    expect(missing).toBeTruthy();
    missing.click();
    const input = dom.root.querySelector("input")!;
    expect(document.activeElement).toBe(input);
    input.value = "Edited";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(dom.root.querySelector("aside")!.textContent).toContain("Save your changes");
    expect(dom.root.querySelector("aside dd")!.textContent).toBe("6");
    expect(button("Issue").disabled).toBe(true);
    expect(dom.root.querySelectorAll("form")).toHaveLength(1);
    expect(dom.root.querySelectorAll("aside")).toHaveLength(1);
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("an unreadable successful save receipt leaves workflow actions locked", async () => {
  const dom = createDomTestHarness();
  const { default: FormWorkspace } = await import("./FormWorkspace.island");
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response("truncated", { status: 200 });
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
          form: { id: "FORM01", name: "Draft", config: { fields: [{ kind: "user_input", fieldId: field.id }] } },
          fields: [field],
          inlineTargetFields: {},
          initialRecord: { version: 1, values: { FIELD1: "Original" }, inlineCreates: {} },
        }}
        actions={[{ id: "issue", kind: "workflow", label: "Issue", variant: "primary", endpoint: "/issue", launcherId: "ISSUE1" }]}
      />
    ),
    dom.root,
  );
  try {
    const input = dom.root.querySelector("input")!;
    input.value = "Changed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(10);
    const issue = Array.from(dom.root.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === "Issue")!;
    expect(issue.disabled).toBe(true);
    issue.click();
    expect(requests).toEqual(["/save"]);
    expect(dom.root.querySelector("fieldset")!.disabled).toBe(true);
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    dom.cleanup();
  }
});

domTest("a finalized record can recover its document even when editable-form requirements no longer match", async () => {
  const dom = createDomTestHarness();
  const { default: FormWorkspace } = await import("./FormWorkspace.island");
  const dispose = render(
    () => (
      <FormWorkspace
        showTitle
        dateConfig={{ locale: "en", timeZone: "UTC" }}
        data={{
          ok: true,
          submitUrl: "/save",
          form: { id: "FORM01", name: "Draft", config: { fields: [{ kind: "user_input", fieldId: field.id }] } },
          fields: [field],
          inlineTargetFields: {},
          initialRecord: { version: 1, values: { FIELD1: "" }, inlineCreates: {} },
        }}
        actions={[
          {
            id: "issue",
            kind: "workflow",
            label: "Issue",
            variant: "primary",
            endpoint: "/issue",
            launcherId: "ISSUE1",
            background: { acceptedMessage: "Requested", state: { status: "missing", finalized: true } },
          },
        ]}
      />
    ),
    dom.root,
  );
  try {
    expect(dom.root.querySelector("fieldset")!.disabled).toBe(true);
    const action = dom.root.querySelector<HTMLButtonElement>("aside button")!;
    expect(action).toBeTruthy();
    expect(action.disabled).toBe(false);
  } finally {
    dispose();
    dom.cleanup();
  }
});
