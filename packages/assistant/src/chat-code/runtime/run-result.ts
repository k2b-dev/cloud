import type { z } from "zod";
import type { ArtifactSession } from "./session";

const text = (value: string, max = 1000) => (value.length > max ? `${value.slice(0, max)}…` : value);
export function inspectCodeRun(
  runId: string,
  entry: {
    session: Pick<ArtifactSession, "snapshot">;
    revision: number;
    outputSchema?: z.ZodType;
  },
) {
  const state = entry.session.snapshot();
  const invalidOutput =
    entry.outputSchema &&
    state.status === "ready" &&
    state.work?.status !== "running" &&
    !entry.outputSchema.safeParse(state.output).success;
  const output = state.output === undefined ? null : JSON.stringify(state.output);
  return {
    userVisible: false,
    delivery:
      "Show views from cloud.view.* with present({path}); never retype their values. Return key figures, or use code_export then present for files.",
    runId,
    status: invalidOutput ? "error" : state.status,
    work: state.work,
    error: invalidOutput
      ? "Action output does not match its schema. Effects may have completed; inspect state before retrying."
      : state.error
        ? text(state.error, 6000)
        : null,
    logs: state.logs.slice(-20).map((log) => ({ ...log, text: text(log.text, 2000) })),
    output: output === null ? null : text(output, 16000),
    outputTruncated: output !== null && output.length > 16000,
    files: state.files,
    views: state.views,
  };
}
