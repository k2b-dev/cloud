import { readFile } from "node:fs/promises";
import { repository } from "../../../../scripts/perf-baseline/runtime";
import { rankBottlenecks, renderBottlenecks, timeMetrics } from "./browser-model";
import { parsePrevious } from "./model";

/** Ranks candidates against an earlier Mail result; reads files only. */
export async function rankFromFiles(resultPath: string, candidatesPath: string) {
  const result = parsePrevious(JSON.parse(await readFile(resultPath, "utf8")));
  const candidates: unknown = JSON.parse(await readFile(candidatesPath, "utf8"));
  return renderBottlenecks(rankBottlenecks(timeMetrics(result), candidates, repository));
}
