import { fetchChunk } from "../../chat-code/runtime/services";
import { createArtifactSession as createSession } from "../../chat-code/runtime/session";
import { startArtifactRun } from "./host";
import { runStream } from "./streams";

export type { ArtifactSession, RunLog, RunSnapshot, SessionOptions } from "../../chat-code/runtime/session";
export function createArtifactSession(
  container: Parameters<typeof createSession>[0],
  source: Parameters<typeof createSession>[1],
  options: Parameters<typeof createSession>[2],
  start?: Parameters<typeof createSession>[3],
) {
  return createSession(
    container,
    source,
    { ...options, chunk: options.chunk ?? fetchChunk("/api/assistant/artifacts/runtime"), stream: options.stream ?? runStream },
    start ?? ((hooks) => startArtifactRun(container!, source, hooks)),
  );
}
