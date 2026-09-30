import { expect, test } from "bun:test";
import { documentProfiles, profileRegistry } from "../document-profiles";
import { createDocumentIssuanceService } from "../service/document-issuance";
import { validateTemplateWrite } from "../service/document-templates";
import { financialQueryProfiles } from "./financial";

test("renderer discovery exposes every installed input schema", () => {
  const references = createDocumentIssuanceService().profiles();
  expect(references).toHaveLength(documentProfiles.length);
  for (const reference of references) {
    expect(reference.inputSchema.$schema).toContain("json-schema.org");
    expect(reference.inputSchema.type).toBe("object");
  }
});

// The stamp is stored with every issued artifact as its provenance, so it must
// name the stdlib that actually rendered and validated it, not an earlier pin.
test("profiles rendered by stdlib record the installed stdlib version", async () => {
  const installed = (await Bun.file(new URL("../package.json", import.meta.resolve("@k2b/stdlib"))).json()) as { version: string };
  const stamped = [...documentProfiles, ...financialQueryProfiles].filter((profile) => profile.rendererVersion.startsWith("stdlib-"));
  expect(stamped.map((profile) => `${profile.id}@${profile.version}`)).toEqual([
    "de.zugferd.en16931@1",
    "de.zugferd.en16931@2",
    "grids.datev-csv@1",
    "grids.sepa-xml@1",
  ]);
  for (const profile of stamped) {
    expect(profile.rendererVersion).toStartWith(`stdlib-${installed.version}-`);
    expect(profile.validatorVersion).toStartWith(`stdlib-${installed.version}-`);
  }
});

test("financial profiles cannot be selected by ordinary templates or the artifact preview API", async () => {
  const service = createDocumentIssuanceService();
  expect(profileRegistry(financialQueryProfiles).size).toBe(2);
  for (const profile of financialQueryProfiles) {
    expect(documentProfiles.some((candidate) => candidate.id === profile.id)).toBe(false);
    expect(service.profiles().some((candidate) => candidate.id === profile.id)).toBe(false);
    const template = validateTemplateWrite({
      renderer: { kind: "profile", id: profile.id, version: profile.version, inputTemplate: "{}" },
    });
    expect(template.ok).toBe(false);
    if (!template.ok) expect(template.error).toMatchObject({ code: "BAD_INPUT", status: 400 });
    const preview = await service.preview({ profileId: profile.id, profileVersion: profile.version, snapshot: {} });
    expect(preview.ok).toBe(false);
  }
});
