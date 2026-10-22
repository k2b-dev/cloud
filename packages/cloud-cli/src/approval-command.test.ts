import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFirstPartyModules } from "../test/fixtures/first-party";

test("approval commands parse global profile/server before the module and flag-like IDs after --", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cld-approval-test-"));
  const probe = `
    const requests = [];
    globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({ url: request.url, authorization: request.headers.get("authorization"), body: await request.json() });
      return Response.json({ ok: true });
    };
    const { main } = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
    process.exitCode = await main(JSON.parse(process.env.CLD_APPROVAL_ARGS));
    process.stdout.write("CLD_REQUESTS" + JSON.stringify(requests));
  `;
  try {
    await installFirstPartyModules(directory, ["assistant"]);
    const configPath = join(directory, "config.json");
    await writeFile(
      configPath,
      JSON.stringify({
        currentProfile: "default",
        profiles: {
          default: { server: "http://unused.invalid", token: "wrong-profile" },
          work: { server: "http://unused.invalid", token: "work-token" },
        },
      }),
      { mode: 0o600 },
    );
    for (const action of ["approve", "reject"]) {
      const child = Bun.spawn([process.execPath, "-e", probe], {
        env: {
          ...process.env,
          CLD_CONFIG: configPath,
          XDG_CONFIG_HOME: directory,
          CLD_APPROVAL_ARGS: JSON.stringify([
            "--profile",
            "work",
            "--server",
            "https://selected.example",
            "assistant",
            "actions",
            action,
            "--",
            "-chat",
            "-turn",
            "-call",
          ]),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(code, stderr).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain(`${action}: -call`);
      expect(JSON.parse(stdout.split("CLD_REQUESTS")[1]!)).toEqual([
        {
          url: "https://selected.example/api/ai/conversations/-chat/turns/-turn/actions/-call",
          authorization: "Bearer work-token",
          body: { type: "approval_response", approved: action === "approve" },
        },
      ]);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
