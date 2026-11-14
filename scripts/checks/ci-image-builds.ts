import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { releaseImages } from "../workspace";
import type { Finding, Rule } from "./rule";

const workflowSchema = z.object({
  jobs: z.record(
    z.string(),
    z.object({
      steps: z
        .array(
          z.object({
            uses: z.string().optional(),
            with: z.object({ file: z.string().optional(), "cache-to": z.string().optional() }).loose().optional(),
          }),
        )
        .default([]),
    }),
  ),
});

/** Dockerfiles that a docker/build-push-action step of the workflow builds. */
const builtDockerfiles = (workflow: z.infer<typeof workflowSchema>): Set<string> =>
  new Set(
    Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .filter((step) => step.uses?.startsWith("docker/build-push-action@"))
      .map((step) => step.with?.file ?? "Dockerfile"),
  );

/**
 * main.yml builds every release image. Each Dockerfile has its own narrow COPY
 * set and build-time checks, so the PR gate builds each one too; otherwise a
 * file missing from that set first fails on main (07.11.2026, cloud-website).
 * Cache exports only speed up future builds; their failure must not fail one.
 */
export const rule: Rule = {
  name: "ci-image-builds",
  description: "the PR gate builds every release image Dockerfile and workflow cache exports tolerate failure",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    for (const path of new Bun.Glob(".github/workflows/*.{yml,yaml}").scanSync(workspaceRoot)) {
      const file = join(workspaceRoot, path);
      const parsed = workflowSchema.safeParse(Bun.YAML.parse(readFileSync(file, "utf8")));
      if (!parsed.success) {
        findings.push({ file, message: `unexpected workflow shape:\n${z.prettifyError(parsed.error)}` });
        continue;
      }
      if (path === ".github/workflows/ci.yml") {
        const built = builtDockerfiles(parsed.data);
        const required = [...new Set(releaseImages().map((image) => image.dockerfile))];
        findings.push(
          ...required
            .filter((dockerfile) => !built.has(dockerfile))
            .map((dockerfile) => ({
              file,
              message: `${dockerfile} builds a release image but no ci.yml job builds it; add a docker/build-push-action step`,
            })),
        );
      }
      for (const [job, { steps }] of Object.entries(parsed.data.jobs)) {
        for (const step of steps) {
          const cacheExports = (step.with?.["cache-to"] ?? "")
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);
          if (cacheExports.some((value) => !/(?:^|,)\s*ignore-error=true(?=,|\s|['"]|$)/.test(value))) {
            findings.push({
              file,
              message: `${job}: every cache-to export must set ignore-error=true so a cache failure cannot fail the image build`,
            });
          }
        }
      }
    }
    return findings;
  },
};
