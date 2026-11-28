const localServices = {
  PostgreSQL: { protocols: ["postgres:", "postgresql:"], hosts: ["localhost", "127.0.0.1", "ipa_postgres"] },
  NATS: { protocols: ["nats:"], hosts: ["localhost", "127.0.0.1", "nats"] },
  Gotenberg: { protocols: ["http:"], hosts: ["localhost", "127.0.0.1", "gotenberg"] },
};

/** Reject remote targets without including credentials in diagnostics. */
export const localVerificationUrl = (service: keyof typeof localServices, value: string | undefined): URL => {
  const url = value ? URL.parse(value) : null;
  const allowed = localServices[service];
  if (!url || !allowed.protocols.includes(url.protocol) || !allowed.hosts.includes(url.hostname)) {
    throw new Error(`Grids verification requires local ${service}`);
  }
  return url;
};

export const assertVerificationReport = (xml: string, phase: string): void => {
  if (
    !/<testcase[\s/>]/.test(xml) ||
    /<(?:skipped|failure|error)[\s/>]/.test(xml) ||
    /\b(?:skipped|failures|errors)="[1-9]\d*"/.test(xml)
  ) {
    throw new Error(`${phase} ran no tests, skipped tests, or reported failures`);
  }
};

/** Phases selected by `--shard <index>/<count>` (1-based, over the full phase list) and/or `--phase <name>`. */
export const selectPhases = <T extends { name: string }>(phases: T[], options: { phase?: string; shard?: string }): T[] => {
  let selected = phases;
  if (options.shard) {
    const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(options.shard);
    const index = Number(match?.[1]);
    const count = Number(match?.[2]);
    if (!match || index > count) throw new Error(`Invalid shard "${options.shard}"; expected <index>/<count> with 1 <= index <= count`);
    selected = selected.filter((_, position) => position % count === index - 1);
  }
  if (options.phase) {
    if (!phases.some((phase) => phase.name === options.phase)) {
      throw new Error(`Unknown phase "${options.phase}"; known: ${phases.map((phase) => phase.name).join(", ")}`);
    }
    selected = selected.filter((phase) => phase.name === options.phase);
  }
  return selected;
};

type Run = (command: string[]) => { exitCode: number; stdout: { toString(): string } };

/**
 * The source a verification ran on: the checkout's commit and whether it had changes. A copy without `.git` (a run on
 * the test machine) names it with `CLOUD_SOURCE_COMMIT` and `CLOUD_SOURCE_DIRTY` (`0`/`false` for a clean copy; a copy
 * that does not say counts as changed). Without either, the run refuses: a report must name its source.
 */
export const verificationSource = (
  root: string,
  env: Record<string, string | undefined> = process.env,
  run: Run = (command) => Bun.spawnSync(command, { cwd: root }),
): { commit: string; dirty: boolean } => {
  const head = run(["git", "rev-parse", "HEAD"]);
  if (head.exitCode === 0)
    return { commit: head.stdout.toString().trim(), dirty: run(["git", "status", "--porcelain"]).stdout.toString().trim() !== "" };
  const commit = env.CLOUD_SOURCE_COMMIT?.trim();
  if (!commit) throw new Error("Cannot record verification commit: no git checkout and no CLOUD_SOURCE_COMMIT");
  return { commit, dirty: !["0", "false"].includes(env.CLOUD_SOURCE_DIRTY?.trim() ?? "") };
};
