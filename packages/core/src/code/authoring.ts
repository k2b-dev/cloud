import { getCapabilityCatalogApp, invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities/server";
import type { CodeCheckRequest, CodeCheckResult } from "@k2b/cloud/code";
import { CloudResourceReaderViewSchema, capabilityActionPolicy, resolveCapabilityResourceReader } from "@k2b/cloud/contracts";
import { z } from "zod";
import { type CodeContext, CodeDataError, codePerson } from "./access";
import { activateCodeVersion } from "./activation";
import { reconcileCodeAccess } from "./activation-maintenance";
import { createCodeCheckRequest } from "./authoring-check";
import type { CodeAuthoringCommand, CodeAuthoringData, CodeAuthoringInput, CodeAuthoringPermission } from "./authoring-contracts";
import { type Code, codeQueryContracts } from "./contracts";
import { effectiveCodePolicy, previewCodePolicy, readCodePolicy, updateCodePolicy } from "./policy";
import { type CodePolicyRow, codePolicyRow } from "./policy-contracts";
import { createRunnerCodeCheckHost, createRunnerCodeTestingHost } from "./runner-jobs";
import { startCodeRun } from "./scheduling";
import { deleteCodeSecret, listCodeSecrets, setCodeSecret } from "./secrets";
import { codeSourceHash, createCode, listCodeRuns, listCodes, readCode, readCodeRun, readCodeVersion } from "./store";
import { simulateCode, testCode } from "./testing";
import { diffCodeVersion, listCodeVersions, setCodePaused, submitCodeVersion } from "./versions";

const initialSource =
  'import { app } from "@sdk";\n\napp.schedule("0 8 * * 1", async () => {\n}, { name: "monday" });\nexport default app;\n';
/** Read every chunk of one immutable version through the existing permission-aware reader. */
async function versionText(
  codeId: string,
  versionId: string,
  content: { kind: "source"; path: string } | { kind: "manifest" },
  context: CodeContext,
) {
  let text = "",
    offset = 0;
  do {
    context.signal?.throwIfAborted();
    const page = await readCodeVersion({ codeId, versionId, content, offset, length: 16_384 }, context);
    if (!page.content) throw new CodeDataError("NOT_FOUND", "Code version content not found.");
    text += page.content.text;
    if (page.content.nextOffset === null) return text;
    offset = page.content.nextOffset;
  } while (true);
}
async function pull(codeId: string, context: CodeContext): Promise<CodeAuthoringData<"pull">> {
  const { code } = await readCode(codeId, context);
  const latest = (await listCodeVersions({ codeId, limit: 1 }, context)).items[0];
  const files: Record<string, string> = {};
  let entry = "code.ts";
  if (latest) {
    for (const path of latest.version.files) files[path] = await versionText(codeId, latest.version.id, { kind: "source", path }, context);
    if (latest.version.manifestAvailable) {
      const manifest: unknown = JSON.parse(await versionText(codeId, latest.version.id, { kind: "manifest" }, context));
      const parsed = z.object({ entry: z.string() }).safeParse(manifest);
      if (parsed.success) entry = parsed.data.entry;
    }
  }
  return {
    version: 1,
    config: { version: 1, codeId, title: code.title, owner: code.owner, entry, baseVersionId: latest?.version.id ?? null },
    files,
  };
}
/** The version is saved by now, so a failed read leaves this field out and never fails the submission. */
async function runningVersionNumber(codeId: string, context: CodeContext) {
  try {
    const { code } = await readCode(codeId, context);
    if (!code.activeVersionId) return null;
    return (await readCodeVersion({ codeId, versionId: code.activeVersionId, offset: 0, length: 1 }, context)).version.number;
  } catch {
    return undefined;
  }
}
/** Classifications and display names come from current catalog/reader authority, never author-supplied titles. */
async function describeCheck(
  request: CodeCheckRequest,
  result: CodeCheckResult,
  code: Code,
  context: CodeContext,
  presentation = true,
): Promise<CodeAuthoringData<"check">> {
  if (!result.ok) return { version: 1, result, manifest: null, permissions: [] };
  const policyRows = new Set<CodePolicyRow>();
  if (result.manifest.ai) policyRows.add("ai");
  const permissions: CodeAuthoringPermission[] = [];
  const catalogs = new Map<string, Awaited<ReturnType<typeof getCapabilityCatalogApp>>>();
  const targets = new Map<string, { title: string | null; typeTitle: string | null }>();
  for (const permission of result.permissions) {
    const appId = permission.operation.split(".")[0]!;
    if (!catalogs.has(appId)) catalogs.set(appId, await getCapabilityCatalogApp(appId, context.locale, context.authority));
    const catalog = catalogs.get(appId)!;
    if (!catalog.ok || !catalog.data) throw new CodeDataError("CONFLICT", "Code operation catalog unavailable. Retry check.");
    const manifest = catalog.data.manifest;
    const localId = permission.operation.slice(appId.length + 1);
    const query = manifest.queries.some((operation) => operation.localId === localId);
    policyRows.add(codePolicyRow(query ? "query" : "action", capabilityActionPolicy(manifest, localId)));
    if (!presentation) continue;
    let title: string | null = null,
      typeTitle: string | null = null;
    if (permission.target) {
      const key = JSON.stringify(permission.target);
      if (!targets.has(key)) {
        const target = permission.target;
        const targetAppId = target.type.split(".")[0]!;
        if (!catalogs.has(targetAppId))
          catalogs.set(targetAppId, await getCapabilityCatalogApp(targetAppId, context.locale, context.authority));
        const targetCatalog = catalogs.get(targetAppId)!;
        const targetManifest = targetCatalog.ok ? targetCatalog.data?.manifest : null;
        const reader =
          target.id === null || !targetManifest
            ? null
            : resolveCapabilityResourceReader(targetManifest, { type: target.type, id: target.id });
        const resource =
          reader && target.id !== null
            ? await invokeCapabilityWithDataSchema(
                { appId: targetAppId, capabilityId: reader.localId, kind: "query", input: { id: target.id } },
                z.object({ view: CloudResourceReaderViewSchema }),
                { authority: context.authority, locale: context.locale, signal: context.signal },
              )
            : null;
        targets.set(key, {
          title: resource?.ok ? resource.data.data.view.title : null,
          typeTitle: targetManifest?.types.find((type) => `${targetAppId}.${type.localId}` === target.type)?.title ?? null,
        });
      }
      ({ title, typeTitle } = targets.get(key)!);
    }
    const own =
      code.owner.kind === "resource" && permission.target?.type === code.owner.ref.type && permission.target.id === code.owner.ref.id;
    permissions.push({
      ...permission,
      title,
      typeTitle,
      own,
      needsTargetAdmin: code.owner.kind !== "person" && permission.status === "new" && !own,
    });
  }
  return { version: 1, result, manifest: { ...result.manifest, entry: request.entry, policyRows: [...policyRows].sort() }, permissions };
}
async function check(input: CodeAuthoringInput<"check">, context: CodeContext, presentation = true) {
  const request = await createCodeCheckRequest(input.codeId, input.files, input.entry ?? "code.ts", context);
  const { code } = await readCode(input.codeId, context);
  const access = await reconcileCodeAccess({ codeId: input.codeId }, context);
  request.existingPermissions = access
    .filter((grant) => grant.state === "present")
    .flatMap((grant) => grant.operations.map((operation) => ({ operation, target: grant.target })));
  const result = await createRunnerCodeCheckHost(context).check(request, context.signal);
  return describeCheck(request, result, code, context, presentation);
}
/** Shared CLI/chat service. Calls the same owning services as capabilities and never executes source in Core. */
export const codeAuthoringServices = {
  async init(input: CodeAuthoringInput<"init">, context: CodeContext): Promise<CodeAuthoringData<"init">> {
    const user = codePerson(context, true);
    const code = await createCode({ title: input.title, owner: input.owner ?? { kind: "person", userId: user.id } }, context);
    return {
      version: 1,
      config: { version: 1, codeId: code.id, title: code.title, owner: code.owner, entry: "code.ts", baseVersionId: null },
      files: { "code.ts": initialSource },
    };
  },
  pull: (input: CodeAuthoringInput<"pull">, context: CodeContext) => pull(input.codeId, context),
  async pullAll(input: CodeAuthoringInput<"pullAll">, context: CodeContext): Promise<CodeAuthoringData<"pullAll">> {
    if (!codePerson(context).roles.includes("admin")) throw new CodeDataError("FORBIDDEN", "Cloud administration required for pull --all.");
    // One resource Code per page bounds source material; other owner kinds are excluded in the store.
    const page = await listCodes({ ownerKind: "resource", cursor: input.cursor, limit: 1 }, context);
    const items = [];
    for (const code of page.items) if (code.owner.kind === "resource") items.push(await pull(code.id, context));
    return { version: 1, items, nextCursor: page.nextCursor };
  },
  async status(input: CodeAuthoringInput<"status">, context: CodeContext): Promise<CodeAuthoringData<"status">> {
    const { code, permission } = await readCode(input.config.codeId, context);
    const latest = (await listCodeVersions({ codeId: code.id, limit: 1 }, context)).items[0] ?? null;
    const base =
      input.config.baseVersionId === null
        ? null
        : (
            await readCodeVersion(
              {
                codeId: code.id,
                versionId: input.config.baseVersionId,
                offset: 0,
                length: 1,
              },
              context,
            )
          ).version;
    return {
      version: 1,
      items: [
        {
          code,
          permission,
          baseVersionId: input.config.baseVersionId,
          baseCurrent: (latest?.version.id ?? null) === input.config.baseVersionId,
          modified: base ? base.sourceHash !== codeSourceHash(input.files, input.config.entry) : Object.keys(input.files).length > 0,
          latest,
        },
      ],
    };
  },
  async runs(input: CodeAuthoringInput<"runs">, context: CodeContext): Promise<CodeAuthoringData<"runs">> {
    return { version: 1, ...(await listCodeRuns(input, context)) };
  },
  async runRead(input: CodeAuthoringInput<"runRead">, context: CodeContext): Promise<CodeAuthoringData<"runRead">> {
    return { version: 1, ...codeQueryContracts.runRead.data.parse(await readCodeRun(input, context)) };
  },
  async pause(input: CodeAuthoringInput<"pause">, context: CodeContext): Promise<CodeAuthoringData<"pause">> {
    return { version: 1, ...(await setCodePaused(input.codeId, true, context)) };
  },
  async resume(input: CodeAuthoringInput<"resume">, context: CodeContext): Promise<CodeAuthoringData<"resume">> {
    return { version: 1, ...(await setCodePaused(input.codeId, false, context)) };
  },
  async policyRead(_input: CodeAuthoringInput<"policyRead">, context: CodeContext): Promise<CodeAuthoringData<"policyRead">> {
    return { version: 1, ...(await readCodePolicy(context)) };
  },
  async policyEffective(input: CodeAuthoringInput<"policyEffective">, context: CodeContext): Promise<CodeAuthoringData<"policyEffective">> {
    return { version: 1, ...(await effectiveCodePolicy(input, context)) };
  },
  async policyPreview(input: CodeAuthoringInput<"policyPreview">, context: CodeContext): Promise<CodeAuthoringData<"policyPreview">> {
    return { version: 1, ...(await previewCodePolicy(input, context)) };
  },
  async policyUpdate(input: CodeAuthoringInput<"policyUpdate">, context: CodeContext): Promise<CodeAuthoringData<"policyUpdate">> {
    return { version: 1, ...(await updateCodePolicy(input, context)) };
  },
  async secretSet(input: CodeAuthoringInput<"secretSet">, context: CodeContext): Promise<CodeAuthoringData<"secretSet">> {
    return { version: 1, ...(await setCodeSecret(input, context)) };
  },
  async secretList(input: CodeAuthoringInput<"secretList">, context: CodeContext): Promise<CodeAuthoringData<"secretList">> {
    return { version: 1, ...(await listCodeSecrets(input, context)) };
  },
  async secretDelete(input: CodeAuthoringInput<"secretDelete">, context: CodeContext): Promise<CodeAuthoringData<"secretDelete">> {
    return { version: 1, ...(await deleteCodeSecret(input, context)) };
  },
  async sdk(input: CodeAuthoringInput<"sdk">, context: CodeContext): Promise<CodeAuthoringData<"sdk">> {
    const { sdk } = await createCodeCheckRequest(input.codeId, {}, "code.ts", context);
    return {
      version: 1,
      files: {
        "sdk/sdk.d.ts": sdk.declarations,
        "sdk/sdk.js": sdk.runtime,
        "sdk/manifest.json": JSON.stringify(sdk.manifest, null, 2) + "\n",
        "tsconfig.json":
          JSON.stringify(
            {
              compilerOptions: {
                target: "ESNext",
                module: "ESNext",
                moduleResolution: "Bundler",
                strict: true,
                noEmit: true,
                paths: { "@sdk": ["./sdk/sdk.d.ts"] },
              },
              include: ["**/*.ts"],
              exclude: ["sdk"],
            },
            null,
            2,
          ) + "\n",
      },
    };
  },
  check,
  async test(input: CodeAuthoringInput<"test">, context: CodeContext) {
    const code = await createCodeCheckRequest(input.codeId, input.files, input.entry ?? "code.ts", context);
    return testCode({ code, tests: input.tests, trace: input.trace }, await createRunnerCodeTestingHost(context), context.signal);
  },
  async simulate(input: CodeAuthoringInput<"simulate">, context: CodeContext) {
    const code = await createCodeCheckRequest(input.codeId, input.files, input.entry ?? "code.ts", context);
    return simulateCode({ code, fixture: input.fixture, trace: input.trace }, await createRunnerCodeTestingHost(context), context.signal);
  },
  async push(input: CodeAuthoringInput<"push">, context: CodeContext): Promise<CodeAuthoringData<"push">> {
    const checked = await check(input, context, false);
    if (!checked.result.ok || !checked.manifest) throw new CodeDataError("BAD_INPUT", "Code check failed. Run check to see diagnostics.");
    const submission = await submitCodeVersion(
      {
        codeId: input.codeId,
        sourceFiles: input.files,
        bundle: checked.result.bundle,
        manifest: checked.manifest,
        baseVersionId: input.baseVersionId,
      },
      context,
    );
    return { version: 1, submission, runningVersion: await runningVersionNumber(input.codeId, context) };
  },
  async submit(input: CodeAuthoringInput<"submit">, context: CodeContext): Promise<CodeAuthoringData<"submit">> {
    return codeAuthoringServices.push(input, context);
  },
  async diff(input: CodeAuthoringInput<"diff">, context: CodeContext): Promise<CodeAuthoringData<"diff">> {
    return { version: 1, diff: await diffCodeVersion(input, context) };
  },
  async activate(input: CodeAuthoringInput<"activate">, context: CodeContext): Promise<CodeAuthoringData<"activate">> {
    return { version: 1, activation: await activateCodeVersion(input, context) };
  },
  async run(input: CodeAuthoringInput<"run">, context: CodeContext): Promise<CodeAuthoringData<"run">> {
    return { version: 1, run: await startCodeRun(input, context) };
  },
} satisfies { [K in CodeAuthoringCommand]: (input: CodeAuthoringInput<K>, context: CodeContext) => Promise<CodeAuthoringData<K>> };
