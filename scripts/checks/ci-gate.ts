import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Finding, Rule } from "./rule";

/** The parts of ci.yml the gate depends on. Actions turns every `env` value into a string. */
export const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      needs: z.union([z.string().transform((id) => [id]), z.array(z.string())]).default([]),
      if: z.union([z.string(), z.boolean()]).optional(),
      steps: z.array(z.object({ env: z.record(z.string(), z.coerce.string()).optional(), run: z.string().optional() })).default([]),
    }),
  ),
});

type Workflow = z.infer<typeof workflowSchema>;

type Job = Workflow["jobs"][string];

const differences = (subject: string, expected: string[], actual: string[]): string[] => [
  ...expected.filter((id) => !actual.includes(id)).map((id) => `${subject} is missing ${id}`),
  ...actual.filter((id) => !expected.includes(id)).map((id) => `${subject} lists ${id}, which it must not`),
];

/**
 * A path-filtered job is skipped only when `changes` reports nothing for it.
 * The rule cannot prove that its `if:` reads nothing else; review keeps other
 * conditions out of it.
 */
const isPathFiltered = (job: Job) =>
  job.needs.includes("changes") && typeof job.if === "string" && job.if.includes("needs.changes.outputs.");

/** The step that decides the required `gate` status check. */
export const gateStep = (workflow: Workflow) => workflow.jobs.gate?.steps.find((step) => step.env?.MAY_SKIP !== undefined);

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
    const parsed = workflowSchema.safeParse(Bun.YAML.parse(readFileSync(file, "utf8")));
    if (!parsed.success) return [{ file, message: `ci.yml has an unexpected shape:\n${z.prettifyError(parsed.error)}` }];
    const workflow = parsed.data;
    const jobs = Object.entries(workflow.jobs).filter(([id]) => id !== "gate");
    const gate = workflow.jobs.gate;
    const step = gateStep(workflow);
    if (!gate || !step?.env?.MAY_SKIP) return [{ file, message: "jobs.gate needs a step with a MAY_SKIP environment variable" }];

    const maySkip = step.env.MAY_SKIP.split(" ").filter(Boolean);
    const messages = [
      ...(gate.if === "always()" ? [] : ["jobs.gate must run with `if: always()`"]),
      ...(step.env.RESULTS === "${{ toJSON(needs) }}" ? [] : ["the gate step must set RESULTS to `${{ toJSON(needs) }}`"]),
      ...differences(
        "jobs.gate.needs",
        jobs.map(([id]) => id),
        gate.needs,
      ),
      ...jobs
        .filter(([, job]) => job.if !== undefined && !isPathFiltered(job))
        .map(([id]) => `${id} may be skipped only by a path filter: its \`if:\` must read needs.changes.outputs and it must need changes`),
      ...differences(
        "MAY_SKIP",
        jobs.filter(([, job]) => isPathFiltered(job)).map(([id]) => id),
        maySkip,
      ),
      ...jobs
        .filter(([id]) => maySkip.includes(id))
        .flatMap(([id, job]) =>
          job.needs
            .filter((need) => maySkip.includes(need))
            .map((need) => `${id} needs ${need}, which may be skipped; a cascading skip would hide in the gate`),
        ),
    ];
    return messages.map((message): Finding => ({ file, message }));
  },
};
