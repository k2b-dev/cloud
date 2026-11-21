import type { RuntimeContext } from "./cloud";
import type { WorkState } from "./work";
export const timeLimitMessage = (milliseconds: number) =>
  `The run reached the ${milliseconds / 1000}-second time limit; split the work, report progress, or use a scheduled action.`;

export type RuntimeHooks = {
  context?: RuntimeContext;
  files?: { path: string; size: number; type: string }[];
  work?: (state: WorkState) => void;
  pending?: (count: number) => void;
  log: (level: string, text: string) => void;
  error: (message: string) => void;
  output: (value: unknown) => void;
  ready: () => void;
  request: (method: string, args: unknown[], signal: AbortSignal) => Promise<unknown>;
};
