import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rule } from "./chat-code-boundary";

test("chat code rejects Studio imports, reexports, dynamic loads and indirect browser hosts", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "cloud-chat-boundary-"));
  const source = join(workspaceRoot, "packages/assistant/src");
  await mkdir(join(source, "chat-code/runtime"), { recursive: true });
  await mkdir(join(source, "frontend"), { recursive: true });
  await writeFile(
    join(source, "chat-code/runtime/bad.ts"),
    'import "../../artifacts/service"; export {x} from "../../artifacts/contracts"; const host=import("../../artifacts/html/host"); require("../../artifacts/database"); import "@/artifacts/service"; import type {X} from "../../artifacts/contracts";',
  );
  await writeFile(join(source, "chat-code/indirect.ts"), 'import "../frontend/helper";');
  await writeFile(join(source, "frontend/helper.ts"), 'import "../cli/code-host";');
  await writeFile(join(source, "chat-code/safe.ts"), 'import {x} from "@k2b/cloud/ai"; import "./runtime/allowed";');
  await writeFile(join(source, "chat-code/runtime/allowed.ts"), "export const x=1;");
  const findings = await rule.run({ workspaceRoot, fix: false, flags: new Set() });
  expect(findings).toHaveLength(7);
  expect(findings.every((finding) => finding.message.startsWith("Chat code must not import Studio or Chromium"))).toBe(true);
  expect(findings.find((finding) => finding.file?.endsWith("helper.ts"))?.message).toContain("chat-code/indirect.ts → frontend/helper.ts");
});
