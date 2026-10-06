import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding, Rule } from "./rule";

type Job = { needs?: string | string[]; if?: string; steps?: { env?: Record<string, string>; run?: string }[] };

type Workflow = { jobs?: Record<string, Job> };

const needsOf = (job: Job): string[] => (job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs]);

const differences = (subject: string, expected: string[], actual: string[]): string[] => [
  ...expected.filter((id) => !actual.includes(id)).map((id) => `${subject} is missing ${id}`),
  ...actual.filter((id) => !expected.includes(id)).map((id) => `${subject} lists ${id}, which it must not`),
];

/** The step that decides the required `gate` status check. */
export const gateStep = (workflow: Workflow) => workflow.jobs?.gate?.steps?.find((step) => step.env?.MAY_SKIP !== undefined);

/**
 * `gate` is the only required status check, so it must see every job and
 * accept a skip only where the job's own path filter caused it. A skip that
 * cascades from a failed or abandoned upstream job is then always visible as
 * that upstream job's result.
 */
export const rule: Rule = {
  name: "ci-gate",
  description: "the CI gate needs every job and lets only path-filtered jobs be skipped",
  run: async ({ workspaceRoot }) => {
    const file = join(workspaceRoot, ".github", "workflows", "ci.yml");
    const workflow: Workflow = Bun.YAML.parse(readFileSync(file, "utf8"));
    const jobs = Object.entries(workflow.jobs ?? {}).filter(([id]) => id !== "gate");
    const gate = workflow.jobs?.gate;
    const step = gateStep(workflow);
    if (!gate || !step?.env?.MAY_SKIP) return [{ file, message: "jobs.gate needs a step with a MAY_SKIP environment variable" }];

    const maySkip = step.env.MAY_SKIP.split(" ").filter(Boolean);
    const messages = [
      ...(gate.if === "always()" ? [] : ["jobs.gate must run with `if: always()`"]),
      ...differences(
        "jobs.gate.needs",
        jobs.map(([id]) => id),
        needsOf(gate),
      ),
      ...differences(
        "MAY_SKIP",
        jobs.filter(([, job]) => job.if !== undefined).map(([id]) => id),
        maySkip,
      ),
      ...jobs
        .filter(([id]) => maySkip.includes(id))
        .flatMap(([id, job]) =>
          needsOf(job)
            .filter((need) => maySkip.includes(need))
            .map((need) => `${id} needs ${need}, which may be skipped; a cascading skip would hide in the gate`),
        ),
    ];
    return messages.map((message): Finding => ({ file, message }));
  },
};
