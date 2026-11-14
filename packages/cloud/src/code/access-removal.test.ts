import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../..");
const removedFiles = [
  "cloud/src/code/access.ts",
  "cloud/src/code/access-core.ts",
  "cloud/src/code/access-proof.ts",
  "cloud/src/contracts/code-access.ts",
  "cloud/src/_internal/code-access-authority.ts",
  "cloud/src/shared/code-access-messages.ts",
  "cloud/src/api/code-access-routes.ts",
  "cloud/src/access/CodeAccessSection.tsx",
  "core/src/code/activation-plan.ts",
  "core/src/code/target-access.ts",
  "core/src/code/activation-transport.ts",
  "spaces/src/service/code-access.ts",
  "mail/src/service/code-access.ts",
];

test("Code rights adapters and target activation planning stay removed", async () => {
  for (const file of removedFiles) expect({ file, exists: existsSync(resolve(root, "packages", file)) }).toEqual({ file, exists: false });
  const forbidden =
    /\b(?:CodeAccess(?:Adapter|Declaration|Decision|Entry|Grant|RefusalCode|SetData|Target|Section)|spaceCodeAccess|mailboxCodeAccess|CodeActivationCheck|CodeTargetAccess|CodeActivationTransport(?:Error)?|codeActivationTransport|reconcileCodeAccess|checkCodeActivation|visibleManagers|generatedCodeAccess|codeAccessPresentation|codeAccessContracts|codeGrantDetailsContracts|readCodeGrantDetails|codeAccessBindings|setCodeAccess|removeCodeAccess|listCodeAccess|signCodeAccessProof|signCodeAccessList|signCodeAccessCleanup)\b|code_dynamic_target|code\.(?:target_grants|version_grants)|capabilities\.code_access_grants/;
  const runtimeFiles = new Bun.Glob("{packages,scripts}/**/*.{ts,tsx}");
  const violations: string[] = [];
  for await (const file of runtimeFiles.scan({ cwd: root, onlyFiles: true })) {
    if (/(?:node_modules|\/dist\/|\/migrate(?:\/|\.ts$)|\.test[.-]|\.integration\.|\.behavior\.|\.browser\.)/.test(file)) continue;
    if (forbidden.test(readFileSync(resolve(root, file), "utf8"))) violations.push(file);
  }
  expect(violations).toEqual([]);
});
