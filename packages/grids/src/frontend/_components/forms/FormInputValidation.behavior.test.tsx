import { expect, test } from "bun:test";
import { createComponent, createSignal } from "solid-js";
import { isServer, render } from "solid-js/web";
import { createDomTestHarness } from "../../../../../ui/test/dom";
import type { PublicField } from "../../../api/public-dto";

const domTest = isServer ? test.skip : test;
const field = (type: string, config: Record<string, unknown> = {}): PublicField => ({
  id: "FIELD1",
  tableId: "TABLE1",
  name: "Input",
  type,
  config,
  required: false,
  description: null,
  deletedAt: null,
  createdAt: "2026-09-14T12:00:00Z",
  updatedAt: "2026-09-14T12:00:00Z",
  position: 0,
  presentable: false,
  hideInTable: false,
  defaultValue: null,
  indexed: false,
  uniqueConstraint: false,
});

domTest("required date is rejected locally, displayed at the field and focused", async () => {
  const dom = createDomTestHarness();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({});
    },
    { preconnect: original.preconnect },
  );
  const { default: Form } = await import("./PublicFormSubmit.island");
  const dispose = render(
    () =>
      createComponent(Form, {
        submitUrl: "/save",
        form: { id: "FORM01", name: "Invoice", config: { fields: [{ kind: "user_input", fieldId: "FIELD1", required: true }] } },
        fields: [field("date")],
      }),
    dom.root,
  );
  try {
    expect(dom.root.querySelector('[aria-invalid="true"]')).toBeNull();
    dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(5);
    expect(calls).toBe(0);
    expect(dom.root.textContent).toContain("required");
    expect(dom.root.querySelector('[data-grids-form-field="FIELD1"]')!.contains(dom.document.activeElement)).toBe(true);
    expect(dom.root.querySelector("fieldset")!.disabled).toBe(false);
  } finally {
    dispose();
    globalThis.fetch = original;
    dom.cleanup();
  }
});

domTest("range errors clear after correction and ambiguous retries reuse the original body", async () => {
  const dom = createDomTestHarness();
  const original = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1) throw new TypeError("Connection lost");
      return Response.json({});
    },
    { preconnect: original.preconnect },
  );
  const { default: Form } = await import("./PublicFormSubmit.island");
  const dispose = render(
    () =>
      createComponent(Form, {
        submitUrl: "/save",
        form: { id: "FORM01", name: "Invoice", config: { fields: [{ kind: "user_input", fieldId: "FIELD1" }] } },
        fields: [field("number", { min: "1", decimalPlaces: 4 })],
      }),
    dom.root,
  );
  const submit = () => dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  try {
    const input = dom.root.querySelector("input")!;
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    submit();
    await Bun.sleep(5);
    expect(bodies).toHaveLength(0);
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(dom.document.activeElement).toBe(input);
    input.value = "1.5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
    submit();
    await Bun.sleep(5);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).data.FIELD1).toBe("1.5");
    submit();
    await Bun.sleep(5);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toBe(bodies[0]);
  } finally {
    dispose();
    globalThis.fetch = original;
    dom.cleanup();
  }
});

domTest("decimal input hides stored padding without rounding or disrupting typing", async () => {
  const dom = createDomTestHarness();
  const { FieldInput } = await import("./form-fields");
  const [value, setValue] = createSignal<unknown>("1.0000");
  const dispose = render(
    () =>
      createComponent(FieldInput, {
        field: field("number", { decimalPlaces: 4 }),
        entry: { kind: "user_input", fieldId: "FIELD1" },
        get value() {
          return value();
        },
        onChange: setValue,
      }),
    dom.root,
  );
  try {
    const input = dom.root.querySelector("input")!;
    expect(input.value).toBe("1");
    expect(value()).toBe("1.0000");
    input.focus();
    input.value = "1.50";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.value).toBe("1.50");
    expect(value()).toBe("1.50");
    input.blur();
    expect(input.value).toBe("1.5");
    setValue("9007199254740993.123400");
    expect(input.value).toBe("9007199254740993.1234");
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("inline required fields are validated before saving their parent", async () => {
  const dom = createDomTestHarness();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({});
    },
    { preconnect: original.preconnect },
  );
  const { default: Form } = await import("./PublicFormSubmit.island");
  const child = { ...field("text"), id: "CHILD1", name: "Partner name", required: true };
  const dispose = render(
    () =>
      createComponent(Form, {
        submitUrl: "/save",
        form: {
          id: "FORM01",
          name: "Invoice",
          config: { fields: [{ kind: "user_input", fieldId: "FIELD1", inlineCreate: { enabled: true, fields: [{ fieldId: "CHILD1" }] } }] },
        },
        fields: [field("relation", { targetTableId: "TABLE2", cardinality: "single" })],
        inlineTargetFields: { TABLE2: [child] },
        initialRecord: {
          version: 1,
          values: { FIELD1: ["tmp_new"] },
          inlineCreates: { FIELD1: [{ tempId: "tmp_new", data: { CHILD1: "" } }] },
        },
      }),
    dom.root,
  );
  try {
    dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(5);
    expect(calls).toBe(0);
    expect(dom.root.textContent).toContain("Partner name: required");
    expect(dom.root.querySelector('input[name="CHILD1"]')?.getAttribute("aria-invalid")).toBe("true");
  } finally {
    dispose();
    globalThis.fetch = original;
    dom.cleanup();
  }
});

domTest("a collapsed section keeps inputs mounted, preserves values and opens for invalid input", async () => {
  const dom = createDomTestHarness();
  const original = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({});
    },
    { preconnect: original.preconnect },
  );
  const { default: Form } = await import("./PublicFormSubmit.island");
  const dispose = render(
    () =>
      createComponent(Form, {
        submitUrl: "/save",
        form: {
          id: "FORM01",
          name: "Invoice",
          config: {
            fields: [
              { kind: "user_input", fieldId: "FIELD1", required: true, section: { title: "Optional settings", collapsible: true } },
              { kind: "user_input", fieldId: "FIELD2" },
            ],
          },
        },
        fields: [field("text"), { ...field("text"), id: "FIELD2", name: "Note" }],
      }),
    dom.root,
  );
  try {
    const input = dom.root.querySelector<HTMLInputElement>('[name="FIELD1"]')!;
    const note = dom.root.querySelector<HTMLInputElement>('[name="FIELD2"]')!;
    expect(input).not.toBeNull();
    expect(input.closest("[hidden]")).not.toBeNull();
    const submit = () => dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    submit();
    await Bun.sleep(5);
    expect(bodies).toHaveLength(0);
    expect(input.closest("[hidden]")).toBeNull();
    expect(dom.document.activeElement).toBe(input);
    input.value = "Corrected";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    note.value = "Keep this note";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    dom.root.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!.click();
    expect(input.closest("[hidden]")).not.toBeNull();
    expect(dom.root.querySelector('[name="FIELD1"]')).toBe(input);
    submit();
    await Bun.sleep(5);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).data).toEqual({ FIELD1: "Corrected", FIELD2: "Keep this note" });
  } finally {
    dispose();
    globalThis.fetch = original;
    dom.cleanup();
  }
});

domTest("an external action lock disables the form and prevents programmatic submission without losing its values", async () => {
  const dom = createDomTestHarness();
  const original = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({});
    },
    { preconnect: original.preconnect },
  );
  const { default: Form } = await import("./PublicFormSubmit.island");
  const [disabled, setDisabled] = createSignal(true);
  const dispose = render(
    () =>
      createComponent(Form, {
        submitUrl: "/save",
        get disabled() {
          return disabled();
        },
        form: {
          id: "FORM01",
          name: "Invoice",
          config: { fields: [{ kind: "user_input", fieldId: "FIELD1", defaultValue: "Saved input" }] },
        },
        fields: [field("text")],
      }),
    dom.root,
  );
  try {
    const submit = () => dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(dom.root.querySelector("fieldset")!.disabled).toBe(true);
    expect(dom.root.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
    submit();
    await Bun.sleep(5);
    expect(bodies).toHaveLength(0);
    setDisabled(false);
    expect(dom.root.querySelector("fieldset")!.disabled).toBe(false);
    expect(dom.root.querySelector<HTMLInputElement>('input[name="FIELD1"]')!.value).toBe("Saved input");
    submit();
    await Bun.sleep(5);
    expect(JSON.parse(bodies[0]!).data.FIELD1).toBe("Saved input");
  } finally {
    dispose();
    globalThis.fetch = original;
    dom.cleanup();
  }
});

for (const selected of [[], ["existing"], ["tmp_new"]]) {
  domTest(`linked-record notice is contextual for ${JSON.stringify(selected)}`, async () => {
    const dom = createDomTestHarness();
    const { default: Form } = await import("./PublicFormSubmit.island");
    const dispose = render(
      () =>
        createComponent(Form, {
          submitUrl: "/save",
          form: {
            id: "FORM01",
            name: "Invoice",
            config: { fields: [{ kind: "user_input", fieldId: "FIELD1", inlineCreate: { enabled: true, fields: [] } }] },
          },
          fields: [field("relation", { targetTableId: "TABLE2", cardinality: "single" })],
          relationLabels: { existing: "Existing partner" },
          inlineTargetFields: { TABLE2: [] },
          initialRecord: { version: 1, values: { FIELD1: selected }, inlineCreates: { FIELD1: [{ tempId: "tmp_new", data: {} }] } },
        }),
      dom.root,
    );
    try {
      expect(dom.root.textContent?.includes("New linked records will be saved together with this form.")).toBe(
        selected.includes("tmp_new"),
      );
    } finally {
      dispose();
      dom.cleanup();
    }
  });
}

domTest("edit forms show populated optional sections while keeping empty sections closed without reopening on input", async () => {
  const dom = createDomTestHarness();
  const { default: Form } = await import("./PublicFormSubmit.island");
  const dispose = render(
    () =>
      createComponent(Form, {
        submitUrl: "/save",
        form: {
          id: "FORM01",
          name: "Invoice",
          config: {
            fields: [
              { kind: "user_input", fieldId: "FIELD1", section: { title: "Notes", collapsible: true } },
              { kind: "user_input", fieldId: "FIELD2", section: { title: "Extra", collapsible: true } },
            ],
          },
        },
        fields: [field("text"), { ...field("text"), id: "FIELD2" }],
        initialRecord: { version: 1, values: { FIELD1: "Use our project reference", FIELD2: "" }, inlineCreates: {} },
      }),
    dom.root,
  );
  try {
    const note = dom.root.querySelector<HTMLInputElement>('input[name="FIELD1"]')!;
    const extra = dom.root.querySelector<HTMLInputElement>('input[name="FIELD2"]')!;
    expect(note.closest("[hidden]")).toBeNull();
    expect(extra.closest("[hidden]")).not.toBeNull();
    note.value = "Changed reference";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    dom.root.querySelector<HTMLButtonElement>('button[aria-expanded="true"]')!.click();
    expect(note.closest("[hidden]")).not.toBeNull();
    extra.value = "Changed elsewhere";
    extra.dispatchEvent(new Event("input", { bubbles: true }));
    expect(note.closest("[hidden]")).not.toBeNull();
    expect(extra.closest("[hidden]")).not.toBeNull();
    expect(note.value).toBe("Changed reference");
  } finally {
    dispose();
    dom.cleanup();
  }
});

domTest("German decimal entry submits exact canonical text for fields and object-list cells, including native form capture", async () => {
  const dom = createDomTestHarness();
  const originalFetch = globalThis.fetch;
  const originalFormData = globalThis.FormData;
  Object.defineProperty(globalThis, "FormData", { value: dom.window.FormData, writable: true, configurable: true });
  const bodies: string[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
  const { LocaleProvider } = await import("@k2b/ui");
  const { default: Form } = await import("./PublicFormSubmit");
  const dispose = render(
    () =>
      createComponent(LocaleProvider, {
        locale: "de-DE",
        get children() {
          return createComponent(Form, {
            submitUrl: "/save",
            form: {
              id: "FORM01",
              name: "Payment",
              config: {
                fields: [
                  { kind: "user_input", fieldId: "FIELD1" },
                  { kind: "user_input", fieldId: "FIELD2" },
                ],
              },
            },
            fields: [
              field("number", { decimalPlaces: 4 }),
              {
                ...field("object_list", {
                  fields: [{ id: "Price1", name: "Price", type: "number", config: { decimalPlaces: 4 } }],
                }),
                id: "FIELD2",
              },
            ],
            initialRecord: { version: 1, values: { FIELD1: "10.5000", FIELD2: [{ Price1: "1.0000" }] }, inlineCreates: {} },
          });
        },
      }),
    dom.root,
  );
  try {
    const amount = dom.root.querySelector<HTMLInputElement>('input[name="FIELD1"]')!;
    dom.root.querySelector<HTMLButtonElement>('button[aria-label="Price · Eintrag 1"]')!.click();
    await Promise.resolve();
    const price = dom.root.querySelector<HTMLInputElement>('input[name="FIELD2-0-Price1"]')!;
    expect(amount.value).toBe("10,5");
    price.focus();
    price.value = "9007199254740993,1234";
    price.dispatchEvent(new Event("input", { bubbles: true }));
    expect(price.value).toBe("9007199254740993,1234");
    amount.focus();
    amount.value = "22,60";
    amount.dispatchEvent(new Event("input", { bubbles: true }));
    expect(amount.value).toBe("22,60");
    dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(5);
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!).data).toEqual({ FIELD1: "22.60", FIELD2: [{ Price1: "9007199254740993.1234" }] });
  } finally {
    dispose();
    globalThis.fetch = originalFetch;
    globalThis.FormData = originalFormData;
    dom.cleanup();
  }
});

domTest("either relation selection is required before any submit request", async () => {
  const dom = createDomTestHarness();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls++;
      return Response.json({});
    },
    { preconnect: original.preconnect },
  );
  const { default: Form } = await import("./PublicFormSubmit.island");
  const message = "Choose at least one set or item.";
  const dispose = render(
    () =>
      createComponent(Form, {
        submitUrl: "/save",
        form: {
          id: "FORM01",
          name: "Loan",
          config: {
            fields: [
              { kind: "user_input", fieldId: "FIELD1" },
              { kind: "user_input", fieldId: "FIELD2" },
            ],
            validations: [{ leftFieldId: "FIELD1", rightFieldId: "FIELD2", operator: "anyPresent", message }],
          },
        },
        fields: [
          field("relation", { targetTableId: "TABLE2", cardinality: "multiple" }),
          { ...field("relation", { targetTableId: "TABLE3", cardinality: "multiple" }), id: "FIELD2" },
        ],
      }),
    dom.root,
  );
  try {
    expect(dom.root.textContent).not.toContain(message);
    expect(dom.root.querySelector('[aria-invalid="true"]')).toBeNull();
    dom.root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Bun.sleep(5);
    expect(calls).toBe(0);
    expect(dom.root.querySelector('[data-grids-form-field="FIELD1"]')!.textContent).toContain(message);
    expect(dom.root.querySelector("fieldset")!.disabled).toBe(false);
  } finally {
    dispose();
    globalThis.fetch = original;
    dom.cleanup();
  }
});
