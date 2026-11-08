import { runStream as run } from "../../chat-code/runtime/streams";

export { RuntimeStream } from "../../chat-code/runtime/streams";
export const runStream = (...args: Parameters<typeof run>) =>
  run(args[0], args[1], args[2], args[3], args[4], "/api/assistant/artifacts/runtime");
