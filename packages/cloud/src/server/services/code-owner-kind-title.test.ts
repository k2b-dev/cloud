import { afterEach, expect, spyOn, test } from "bun:test";
import { compileCapabilities } from "../../_internal/capabilities";
import * as registry from "../../_internal/registry";
import { codeOwnerKindTitle } from "./code-account-display";

const compiled = compileCapabilities("mail", {
  protocolVersion: 2,
  types: { mailbox: { title: "Mailbox", description: "A shared mailbox." } },
  presentation: { baseLocale: "en", translations: { de: { types: { mailbox: { title: "Postfach" } } } } },
});
const entry = {
  appId: "mail",
  appName: "Mail",
  appIcon: "ti ti-mail",
  appDescription: "Mail",
  endpoint: "http://mail.invalid",
  manifest: compiled.manifest,
  presentation: compiled.presentation,
  appPresentation: { baseLocale: "en", translations: { de: { name: "E-Mail" } } },
};
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

test("a resource owner is named by its localized type, never by its own name; an app by its name in the reader's language", async () => {
  spies.push(spyOn(registry, "getCapability").mockResolvedValue(entry as never), spyOn(registry, "getApp").mockResolvedValue(null));
  const mailbox = { kind: "resource" as const, ref: { type: "mail.mailbox", id: "einkauf" } };
  expect(await codeOwnerKindTitle(mailbox, "de-AT")).toBe("Postfach");
  expect(await codeOwnerKindTitle(mailbox, "en")).toBe("Mailbox");
  expect(await codeOwnerKindTitle({ kind: "resource", ref: { type: "mail.folder", id: "x" } }, "de")).toBeNull();
  expect(await codeOwnerKindTitle({ kind: "app", appId: "mail" }, "de")).toBe("E-Mail");
  expect(await codeOwnerKindTitle({ kind: "app", appId: "mail" }, "en")).toBe("Mail");
});

test("an app the registry does not know, or a registry that does not answer, names nothing", async () => {
  spies.push(
    spyOn(registry, "getCapability").mockRejectedValue(new Error("registry down")),
    spyOn(registry, "getApp").mockResolvedValue(null),
  );
  expect(await codeOwnerKindTitle({ kind: "resource", ref: { type: "mail.mailbox", id: "einkauf" } }, "de")).toBeNull();
  expect(await codeOwnerKindTitle({ kind: "app", appId: "mail" }, "de")).toBeNull();
});
