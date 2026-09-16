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
