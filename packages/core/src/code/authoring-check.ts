import { listCapabilityCatalog } from "@k2b/cloud/capabilities/server";
import { CODE_CHECK_LIMITS, type CodeCheckRequest, generateCodeSdk } from "@k2b/cloud/code";
import type { CapabilityManifest, CodeCheckedVersionManifest } from "@k2b/cloud/contracts";
import { approvalArgsDigest } from "@k2b/cloud/services/approvals";
import { type CodeContext, CodeDataError, codePerson, requireCodePermission } from "./access";
import { createRunnerCodeCheckHost } from "./runner-jobs";
import { readCode } from "./store";

/** Build authoritative checker input for CLI/chat and C8 from the live catalog under this caller's authority.
 * Author-supplied SDK code, compiler paths and budget overrides never enter this request. */
export async function createCodeCheckRequest(
  codeId: string,
  files: Record<string, string>,
  entry: string,
  context: CodeContext,
): Promise<CodeCheckRequest> {
  codePerson(context, true);
  const { code } = await readCode(codeId, context);
  await requireCodePermission(code, context, true);
  const manifests: CapabilityManifest[] = [];
  let cursor: string | undefined;
  let bytes = 0;
  do {
    context.signal?.throwIfAborted();
    const page = await listCapabilityCatalog({ authority: context.authority, locale: context.locale, cursor, limit: 25 });
    if (!page.ok) throw new CodeDataError("CONFLICT", "The Code capability catalog is unavailable. Retry the check.");
    bytes += Buffer.byteLength(JSON.stringify(page.data));
    if (bytes > CODE_CHECK_LIMITS.requestBytes) throw new CodeDataError("BAD_INPUT", "Code SDK exceeds the checker request budget.");
    manifests.push(...page.data.apps.map((app) => app.manifest));
    cursor = page.data.page.hasMore ? page.data.page.nextCursor : undefined;
  } while (cursor);
  const sdk = generateCodeSdk(
    manifests,
    code.owner.kind === "person"
      ? { mode: "personal" }
      : {
          mode: "resource",
          owner: code.owner.kind === "resource" ? { kind: "resource", ref: code.owner.ref } : { kind: "app", appId: code.owner.appId },
        },
  );
  return {
    files,
    entry,
    sdk,
    aiOperations: sdk.manifest.operations
      .filter((operation) => operation.capability.startsWith("core.ai."))
      .map((operation) => operation.capability),
    limits: CODE_CHECK_LIMITS,
  };
}
/** The server check is binding: submitted source, bundle and static evidence must match the runner's fresh result. */
export async function verifyCodeSubmission(
  input: { codeId: string; sourceFiles: Record<string, string>; bundle: string; manifest: CodeCheckedVersionManifest },
  context: CodeContext,
): Promise<void> {
  const request = await createCodeCheckRequest(input.codeId, input.sourceFiles, input.manifest.entry, context);
  const checked = await createRunnerCodeCheckHost(context).check(request, context.signal);
  if (!checked.ok) throw new CodeDataError("BAD_INPUT", "The authoritative server check failed. Run check again.");
  // Only source-derived evidence is compared; the host selects secret bindings, and validateCodeSecretBindings checks those.
  const { entry: _entry, policyRows: _policyRows, secrets: _secrets, ...evidence } = input.manifest;
  if (input.bundle !== checked.bundle || approvalArgsDigest(evidence) !== approvalArgsDigest(checked.manifest))
    throw new CodeDataError("CONFLICT", "The server check differs from the submitted bundle or manifest. Refresh the SDK and check again.");
}
