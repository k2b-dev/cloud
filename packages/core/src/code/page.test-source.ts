import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CodePageTree, type CodeUser, generateCodeSdk, validateCodePage } from "@k2b/cloud/code";

/**
 * Runs a Code page's TSX as Code runs it: through the SDK's blocks and jsx factory, then its GET route, then Core's
 * check. Tests and screenshots use it so a page comes from Code source, never from a hand-written description.
 */
export async function buildCodePage(
  source: string,
  codeId: string,
  user: CodeUser = {
    id: "visitor",
    username: "visitor",
    groupIds: [],
    groupNames: [],
    kind: "user",
    name: "Visitor",
  },
): Promise<CodePageTree> {
  const directory = mkdtempSync(join(tmpdir(), "core-code-page-source-"));
  writeFileSync(join(directory, "sdk.js"), generateCodeSdk([], { mode: "personal" }).runtime);
  const entry = source.replace('"@sdk"', '"./sdk.js"').replace("import { app,", "import { __codeSdk, app,");
  const transpiler = new Bun.Transpiler({ loader: "tsx", tsconfig: { compilerOptions: { jsx: "react", jsxFactory: "jsx" } } });
  writeFileSync(join(directory, "code.mjs"), `${transpiler.transformSync(entry)}\nexport { __codeSdk };`);
  const module = await import(join(directory, "code.mjs"));
  const response = await module.__codeSdk.run("route:GET:/", {
    method: "GET",
    path: "/",
    query: "",
    contentType: "text/plain",
    body: "",
    params: {},
    user,
  });
  return validateCodePage(response.tree, codeId);
}
