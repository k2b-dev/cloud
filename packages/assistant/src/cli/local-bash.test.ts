import { describe, expect, test } from "bun:test";
import { runLocalBash } from "./local-bash";

describe("local Assistant Bash tool", () => {
  test("captures exit status and both output streams", async () => {
    const result = await runLocalBash("printf 'hello'; printf 'warning' >&2; exit 7", { timeoutMs: 5_000 });

    expect(result).toEqual({
      status: "completed",
      exitCode: 7,
      stdout: "hello",
      stderr: "warning",
      truncated: false,
    });
  });

  test("removes every CLD_ variable and preserves other environment values", async () => {
    const previous = process.env.CLD_ASSISTANT_TEST;
    const previousOther = process.env.ASSISTANT_BASH_TEST;
    process.env.CLD_ASSISTANT_TEST = "private";
    process.env.ASSISTANT_BASH_TEST = "kept";
    try {
      const result = await runLocalBash('compgen -e; printf "value:%s" "$ASSISTANT_BASH_TEST"', { timeoutMs: 5_000 });
      expect(result.status).toBe("completed");
      expect(result.stdout.split("\n").some((key) => key.startsWith("CLD_"))).toBeFalse();
      expect(result.stdout).toContain("ASSISTANT_BASH_TEST");
      expect(result.stdout).toContain("value:kept");
      expect(process.env.CLD_ASSISTANT_TEST).toBe("private");
    } finally {
      if (previous === undefined) delete process.env.CLD_ASSISTANT_TEST;
      else process.env.CLD_ASSISTANT_TEST = previous;
      if (previousOther === undefined) delete process.env.ASSISTANT_BASH_TEST;
      else process.env.ASSISTANT_BASH_TEST = previousOther;
    }
  });

  test("bounds captured output without changing command completion", async () => {
    const result = await runLocalBash("printf '123456'; printf 'abcdef' >&2", {
      timeoutMs: 5_000,
      maxStreamBytes: 4,
    });

    expect(result).toEqual({
      status: "completed",
      exitCode: 0,
      stdout: "1234",
      stderr: "abcd",
      truncated: true,
    });
  });

  test("kills commands at the configured timeout", async () => {
    const result = await runLocalBash("sleep 1", { timeoutMs: 10 });

    expect(result.status).toBe("timed_out");
    expect(result.exitCode).toBeNull();
  });
});
