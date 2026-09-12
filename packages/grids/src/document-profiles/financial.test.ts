import { expect, test } from "bun:test";
import { documentProfiles, profileRegistry } from "../document-profiles";
import { createDocumentIssuanceService } from "../service/document-issuance";
import { validateTemplateWrite } from "../service/document-templates";
import { financialQueryProfiles } from "./financial";

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
