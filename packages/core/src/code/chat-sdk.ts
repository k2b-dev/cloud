import { type CodeSdkOptions, generateCodeSdk } from "@k2b/cloud/code";
import { type CapabilityManifest, CodePolicyRowSchema, capabilityActionPolicy } from "@k2b/cloud/contracts";
import { z } from "zod";
import { type CodeContext, CodeDataError } from "./access";
import { loadCodeSdkCatalog } from "./authoring-check";
import { CodeIdSchema } from "./contracts";
import { codePolicyRow } from "./policy-contracts";

/**
 * Apps per declarations call. The combined SDK is far larger than one tool result; the index plus the declarations of
 * this many of the largest apps stays within the result budget of a 128k-token model (chat-sdk.test.ts).
 */
export const CODE_CHAT_SDK_APPS = 2;

const AppNameSchema = z.string().min(1).max(100);
/** Step 1 without `apps`: the index. Step 2 with `apps`: the declarations of those apps and of everything shared. */
export const CodeChatSdkInputSchema = z
  .object({
    codeId: CodeIdSchema,
    apps: z
      .array(AppNameSchema)
      .max(CODE_CHAT_SDK_APPS)
      .optional()
      .describe("App IDs or export names from the index. Omit for the index; [] returns only the shared declarations."),
  })
  .strict();

const IndexSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal("index"),
    apps: z.array(
      z
        .object({
          appId: z.string(),
          export: z.string(),
          methods: z.array(
            z
              .object({ path: z.string(), kind: z.enum(["query", "action"]), policy: CodePolicyRowSchema, description: z.string() })
              .strict(),
          ),
        })
        .strict(),
    ),
    events: z.array(
      z.object({ type: z.string(), subject: z.string(), place: z.string().nullable(), description: z.string() }).strict(),
    ),
  })
  .strict();
const DeclarationsSchema = z
  .object({ version: z.literal(1), kind: z.literal("declarations"), apps: z.array(z.string()), declarations: z.string() })
  .strict();
export const CodeChatSdkDataSchema = z.discriminatedUnion("kind", [IndexSchema, DeclarationsSchema]);
export type CodeChatSdkData = z.infer<typeof CodeChatSdkDataSchema>;

/** The first sentence of the first line, bounded so that one method stays one short index row. */
const oneLine = (text: string): string => {
  const first = text.trim().split("\n")[0]!.trim();
  const sentence = /^.*?[.!?](?=\s|$)/.exec(first)?.[0] ?? first;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
};

/**
 * The chat's view of the generated SDK. The checker still receives the complete SDK; the chat reads an index of every
 * method first and then the TypeScript declarations of the apps it uses. Paths, events and policy rows come from the
 * same generated manifest and classification the check uses, so the index cannot drift from the checker.
 */
export function codeChatSdkView(manifests: readonly CapabilityManifest[], options: CodeSdkOptions, apps?: readonly string[]): CodeChatSdkData {
  const sdk = generateCodeSdk(manifests, options);
  if (apps === undefined) {
    const byApp = new Map(manifests.map((manifest) => [manifest.appId, manifest]));
    const factories = new Map(sdk.manifest.handles.map((handle) => [handle.type, handle.factoryPath]));
    return {
      version: 1,
      kind: "index",
      apps: sdk.manifest.apps.map((app) => {
        const manifest = byApp.get(app.appId)!;
        return {
          appId: app.appId,
          export: app.exportName,
          methods: sdk.manifest.operations
            .filter((operation) => operation.appId === app.appId)
            .map((operation) => {
              const factory = operation.target ? `.${factories.get(operation.target)!.join(".")}(id)` : "";
              const entries = operation.kind === "query" ? manifest.queries : manifest.actions;
              const description = entries.find((entry) => entry.localId === operation.localId)?.description ?? "";
              return {
                path: `${app.exportName}${factory}.${operation.methodPath.join(".")}`,
                kind: operation.kind,
                policy: codePolicyRow(operation.kind, capabilityActionPolicy(manifest, operation.localId)),
                description: oneLine(description),
              };
            }),
        };
      }),
      events: sdk.manifest.events.map((event) => {
        const [appId] = event.type.split(".");
        const localId = event.type.slice(appId!.length + 1);
        const description = byApp.get(appId!)?.events?.find((entry) => entry.localId === localId)?.description ?? "";
        return { type: event.type, subject: event.subject, place: event.place, description: oneLine(description) };
      }),
    };
  }
  const wanted = new Set<string>();
  for (const name of apps) {
    const app = sdk.manifest.apps.find((entry) => entry.appId === name || entry.exportName === name);
    if (!app) throw new CodeDataError("BAD_INPUT", `Unknown app ${name}. Use an appId or export from the code_sdk index.`);
    wanted.add(app.appId);
  }
  // A resource or app owner's handle type lives in its app; without that app the owner export has no type.
  const owner = options.owner;
  if (owner) wanted.add(owner.kind === "app" ? owner.appId : owner.ref.type.slice(0, owner.ref.type.indexOf(".")));
  const selected = generateCodeSdk(
    manifests.filter((manifest) => wanted.has(manifest.appId)),
    options,
  );
  return { version: 1, kind: "declarations", apps: selected.manifest.apps.map((app) => app.appId), declarations: selected.declarations };
}

export async function readCodeChatSdk(input: z.output<typeof CodeChatSdkInputSchema>, context: CodeContext): Promise<CodeChatSdkData> {
  const { manifests, options } = await loadCodeSdkCatalog(input.codeId, context);
  return codeChatSdkView(manifests, options, input.apps);
}
