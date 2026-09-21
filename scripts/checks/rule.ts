/**
 * Contract for one repository check rule. `bun scripts/check.ts` loads every
 * rule from this directory, runs it, and prints its findings grouped by rule.
 */
export type Finding = { file?: string; line?: number; message: string };

export type RuleContext = {
  /** Absolute repository root. */
  workspaceRoot: string;
  /** `--fix` was requested; rules that can repair findings do so and report what remains. */
  fix: boolean;
  /** Extra `--flags` after the rule names, for example `--apps` for `cycles`. */
  flags: ReadonlySet<string>;
};

export type Rule = {
  name: string;
  description: string;
  run: (ctx: RuleContext) => Promise<Finding[]>;
};

/** Runs a command and returns its exit code with the combined output. */
export const capture = async (
  cmd: string[],
  options: { cwd: string; env?: Record<string, string | undefined> } = { cwd: process.cwd() },
): Promise<{ code: number; output: string }> => {
  const child = Bun.spawn(cmd, { cwd: options.cwd, env: options.env ?? process.env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, output: `${stdout}${stderr}`.trimEnd() };
};
