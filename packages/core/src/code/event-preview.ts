import { sql } from "@k2b/cloud";
import { CodeCheckedVersionManifestSchema } from "@k2b/cloud/contracts";
import { type CodeContext, CodeDataError, requireCodePermission } from "./access";
import { createCodeCheckRequest } from "./authoring-check";
import type { CodeAuthoringInput } from "./authoring-contracts";
import { type CodeSourceFiles, CodeSourceFilesSchema } from "./contracts";
import { codeEventEntry } from "./event-access";
import { createRunnerCodeTestingHost } from "./runner-jobs";
import { readCode } from "./store";
import { type CodeTestingHost, simulateCode } from "./testing";

/** The source is the pinned active version. Only checker and fake Runner jobs are reachable here. */
export async function simulateCodeEvent(input: CodeAuthoringInput<"simulateEvent">, context: CodeContext) {
  const { code } = await readCode(input.codeId, context);
  await requireCodePermission(code, context, true);
  if (code.activeVersionId !== input.versionId || code.state !== "active")
    throw new CodeDataError("CONFLICT", "Preview requires the active Code version.");
  const [version] = await sql<{ source_files: CodeSourceFiles; manifest: unknown }[]>`SELECT source_files,manifest FROM code.versions
    WHERE id=${input.versionId}::uuid AND code_id=${code.id}`;
  const manifest = CodeCheckedVersionManifestSchema.parse(version?.manifest);
  const entry = codeEventEntry(manifest, input.event);
  if (!entry?.event) throw new CodeDataError("BAD_INPUT", "Preview event does not belong to this Code handler.");
  const request = await createCodeCheckRequest(code.id, CodeSourceFilesSchema.parse(version?.source_files), manifest.entry, context);
  return previewCodeEvent(request, entry.entrypoint, input, await createRunnerCodeTestingHost(context), context.signal);
}
/** Exported seam for verifying that a real-message fixture can only enter the fake executor. */
export function previewCodeEvent(
  code: Parameters<typeof simulateCode>[0]["code"],
  entrypoint: string,
  input: Pick<CodeAuthoringInput<"simulateEvent">, "event" | "mocks">,
  host: CodeTestingHost,
  signal?: AbortSignal,
) {
  return simulateCode(
    {
      code,
      trace: true,
      fixture: {
        version: 1,
        name: "Event preview",
        now: Date.parse(input.event.time),
        seed: 0,
        mocks: input.mocks,
        runs: [{ entrypoint, input: input.event }],
      },
    },
    host,
    signal,
  );
}
