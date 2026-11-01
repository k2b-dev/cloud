import { sql } from "@k2b/cloud";
import type { RunnerJobLease } from "@k2b/cloud/code/runner";
import { codeAdmissionLock } from "./admission";
import { claimCodeJob } from "./runner-jobs";
import { claimCodeRuns } from "./scheduling";
import { codeSettings } from "./settings";
/** Alternation is durable across Core replicas and polls. Empty classes yield their turn immediately. */
export async function claimCodeWork(slots: number, instanceId: string, limits: Parameters<typeof claimCodeRuns>[1]) {
  const jobLimit = await codeSettings.get("core.code.runner_job_slots");
  return sql.begin(async (db) => {
    await codeAdmissionLock(db);
    const runs: Awaited<ReturnType<typeof claimCodeRuns>> = [];
    const jobs: RunnerJobLease[] = [];
    const [turn] = await db<{ job_last: boolean }[]>`SELECT job_last FROM code.dispatch_turn WHERE singleton FOR UPDATE`;
    let jobLast = turn?.job_last ?? false;
    const [active] = await db<
      { count: number }[]
    >`SELECT count(*)::int AS count FROM code.jobs WHERE state='running' AND runner_instance_id=${instanceId}::uuid AND lease_expires_at>clock_timestamp()`;
    let jobCapacity = Math.max(0, jobLimit - (active?.count ?? 0));
    for (let i = 0; i < slots; i++) {
      let job: RunnerJobLease | undefined;
      let run: Awaited<ReturnType<typeof claimCodeRuns>>[number] | undefined;
      if (!jobLast && jobCapacity) job = await claimCodeJob(instanceId, db);
      if (!job) [run] = await claimCodeRuns(1, limits, instanceId, db);
      if (!run && !job && jobLast && jobCapacity) job = await claimCodeJob(instanceId, db);
      if (!run && !job) continue;
      if (job) {
        jobs.push(job);
        jobCapacity--;
        jobLast = true;
      } else if (run) {
        runs.push(run);
        jobLast = false;
      }
    }
    await db`UPDATE code.dispatch_turn SET job_last=${jobLast} WHERE singleton`;
    return { runs, jobs };
  });
}
