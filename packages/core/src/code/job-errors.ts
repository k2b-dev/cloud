/** Stable authoring errors for CLI/chat; busy means retry later, without an unbounded wait queue in Core. */
export class CodeJobError extends Error {
  constructor(
    readonly code: "code_job_busy" | "code_job_request_limit" | "code_job_time_limit" | "code_job_cancelled" | "code_job_failed",
  ) {
    super(code);
  }
}
