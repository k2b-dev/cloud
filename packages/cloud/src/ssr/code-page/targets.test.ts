import { expect, test } from "bun:test";
import { codePageMessages } from "./messages";
import { codeActivationRows, codeDynamicOperations, codeTargetLabel } from "./targets";

const call = (operation: string, id: string | null, type = "spaces.space") => ({ operation, target: { type, id } });
const owner = { type: "mail.mailbox", id: "m_info" };

test("switching on lists the owner, each target with its operations, and what is new against the running version", () => {
  const running = { permissions: [call("spaces.task.create", "sp_1")] };
  const next = {
    permissions: [call("spaces.task.create", "sp_1"), call("spaces.task.update", "sp_1"), call("spaces.task.create", "sp_2")],
  };
  expect(codeActivationRows(running, next, owner)).toEqual([
    { ref: owner, operations: [], isNew: false },
    { ref: { type: "spaces.space", id: "sp_1" }, operations: ["spaces.task.create", "spaces.task.update"], isNew: true },
    { ref: { type: "spaces.space", id: "sp_2" }, operations: ["spaces.task.create"], isNew: true },
  ]);
  expect(codeActivationRows(next, next, null).map((row) => row.isNew)).toEqual([false, false]);
  // An app-wide call targets the app; a dynamic ID is no fixed target.
  expect(codeActivationRows(null, { permissions: [{ operation: "core.ai.generate", target: null }, call("mail.read", null)] }, null)).toEqual([
    { ref: { type: "app", id: "core" }, operations: ["core.ai.generate"], isNew: true },
  ]);
});

test("calls whose target the Code picks while running are listed once, new when the running version made none", () => {
  const next = { permissions: [call("mail.message.read", null, "mail.mailbox"), call("mail.message.read", "m_1", "mail.mailbox")] };
  expect(codeDynamicOperations(null, next)).toEqual({ operations: ["mail.message.read"], isNew: true });
  expect(codeDynamicOperations(next, next)).toEqual({ operations: ["mail.message.read"], isNew: false });
  expect(codeDynamicOperations(null, { permissions: [] })).toBeNull();
});

test("targets read as on the Code page: the owner itself, an app by name, a foreign target by type and ID", () => {
  const t = codePageMessages.resolve(["de"]).t;
  const target = { key: "", ref: { type: "spaces.space", id: "sp_1" }, title: null, typeTitle: "Space", icon: null, own: false, href: null };
  expect(codeTargetLabel(target, "info@", t)).toBe("an Space sp_1");
  expect(codeTargetLabel({ ...target, own: true }, "info@", t)).toBe("an info@ selbst");
  expect(codeTargetLabel({ ...target, ref: { type: "app", id: "core" }, title: "Cloud" }, "info@", t)).toBe("in der App Cloud");
  expect(codeTargetLabel({ ...target, typeTitle: null }, "info@", t)).toBe("an sp_1");
});
