import type { CloudCliContext } from "@k2b/cloud/cli";
import {
  CODE_AUTHORING_REQUEST_BYTES,
  type CodeAuthoringCommand,
  type CodeAuthoringData,
  type CodeAuthoringError,
  CodeAuthoringErrorSchema,
  codeAuthoringContracts,
} from "../code/authoring-contracts";
export class RemoteCodeError extends Error {
  constructor(readonly body: CodeAuthoringError) {
    super(body.error.message);
  }
}
export function request<K extends CodeAuthoringCommand>(ctx: CloudCliContext, name: K, input: unknown): Promise<CodeAuthoringData<K>>;
export async function request(ctx: CloudCliContext, name: CodeAuthoringCommand, input: unknown) {
  const parsedInput = codeAuthoringContracts[name].input.safeParse(input);
  if (!parsedInput.success) throw new Error("Invalid Code command input. Check IDs, cursors and flags with --help.");
  const body = JSON.stringify(parsedInput.data);
  if (Buffer.byteLength(body) > CODE_AUTHORING_REQUEST_BYTES) throw new Error("Code command exceeds the checker request budget.");
  const response = await ctx.fetch(`/api/code/authoring/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    const failure = CodeAuthoringErrorSchema.safeParse(parsed);
    if (name === "secretSet")
      throw new RemoteCodeError({
        version: 1,
        error: {
          code: response.status === 409 ? "CONFLICT" : `http_${response.status}`,
          message: "Code secret write failed. Read its metadata before retrying.",
          details: null,
        },
      });
    if (failure.success) throw new RemoteCodeError(failure.data);
    throw new RemoteCodeError({
      version: 1,
      error: {
        code: `http_${response.status}`,
        message: `Code request failed (${response.status}). Read the current state before retrying a write.`,
        details: null,
      },
    });
  }
  return codeAuthoringContracts[name].data.parse(await response.json());
}
