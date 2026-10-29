import { expect, test } from "bun:test";
import { render } from "solid-js/web";
import { createDomTestHarness } from "../../../ui/test/dom";
import { MachineRights } from "./machine-contracts";

const policy = (status = "active") => ({
  entry: {
    id: "11111111-1111-4111-8111-111111111111",
    principal: { type: "service_account" as const, serviceAccountId: "22222222-2222-4222-8222-222222222222" },
    displayName: "Invoice agent",
    serviceAccountKind: "agent" as const,
    permission: "read" as const,
    createdAt: "2026-10-23T12:00:00.000Z",
  },
  rights: MachineRights.parse({}),
  revision: null,
  status,
});

test("machine rights explain revoked and disabled states without enabling disabled controls", async () => {
  const dom = createDomTestHarness();
  const { MachineRightsEditor } = await import("./MachinePermissions");
  const dispose = render(
    () => (
      <MachineRightsEditor
        policy={policy("disabled")}
        save={async () => {
          throw new Error("Must not save");
        }}
        refresh={() => {}}
      />
    ),
    dom.root,
  );
  try {
    expect(dom.root.textContent).toContain("Invoice agent");
    expect(dom.root.textContent).toContain("Account disabled");
    expect(dom.root.textContent).toContain("Execution is off");
    expect(dom.root.textContent).toContain("Personal data and personal secrets are unavailable");
    const controls = dom.root.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
      "input:not([type='hidden']),textarea,button[role='combobox']",
    );
    expect(controls.length).toBeGreaterThan(4);
    expect([...controls].every((control) => control.disabled)).toBe(true);
    const save = [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Save rights"));
    expect(save?.disabled).toBe(true);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("failed machine-right save preserves the draft and offers an explicit refresh", async () => {
  const dom = createDomTestHarness();
  const { MachineRightsEditor } = await import("./MachinePermissions");
  let refreshed = 0;
  const attempts: MachineRights[] = [];
  const dispose = render(
    () => (
      <MachineRightsEditor
        policy={policy()}
        save={async (rights) => {
          attempts.push(rights);
          throw new Error("Conflict");
        }}
        refresh={() => {
          refreshed++;
        }}
      />
    ),
    dom.root,
  );
  try {
    const execute = dom.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    execute.click();
    const save = [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Save rights"))!;
    save.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attempts[0]?.execute).toBe(true);
    expect(execute.checked).toBe(true);
    expect(dom.root.textContent).toContain("Could not save");
    [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Refresh"))!.click();
    expect(refreshed).toBe(1);
  } finally {
    dispose();
    dom.cleanup();
  }
});

test("an unsaved execution change does not claim that running authority was revoked", async () => {
  const dom = createDomTestHarness();
  const { MachineRightsEditor } = await import("./MachinePermissions");
  const active = { ...policy(), rights: MachineRights.parse({ execute: true }) };
  const dispose = render(
    () => (
      <MachineRightsEditor
        policy={active}
        save={async () => {
          throw new Error("Conflict");
        }}
        refresh={() => {}}
      />
    ),
    dom.root,
  );
  try {
    dom.root.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click();
    [...dom.root.querySelectorAll("button")].find((button) => button.textContent?.includes("Save rights"))!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(dom.root.textContent).toContain("Could not save");
    expect(dom.root.textContent).not.toContain("Execution is off");
  } finally {
    dispose();
    dom.cleanup();
  }
});
