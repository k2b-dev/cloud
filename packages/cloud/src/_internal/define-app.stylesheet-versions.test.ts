import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Pages = Record<string, { status: number; hrefs: string[] }>;
const hash = (content: string) => createHash("sha256").update(content).digest("hex").slice(0, 16);
const sheets = ["fonts", "tabler-icons", "global"];

test("page-head URLs follow content and Core's release across real process restarts", async () => {
  const root = mkdtempSync(join(tmpdir(), "cloud-stylesheet-versions-"));
  const faqCss = "body{color:red}";
  const mailCss = "body{color:blue}";
  for (const [id, content] of [
    ["faq", faqCss],
    ["mail", mailCss],
  ] as const) {
    mkdirSync(join(root, "public", id), { recursive: true });
    writeFileSync(join(root, "public", id, "app.css"), content);
    writeFileSync(join(root, "public", id, "favicon.svg"), `<svg id="${id}"/>`);
  }

  const start = async (
    release: string,
    { nextCoreRelease, nodeEnv = "production" }: { nextCoreRelease?: string; nodeEnv?: string } = {},
  ): Promise<Pages[]> => {
    const probe = {
      root,
      defineApp: join(import.meta.dir, "define-app.ts"),
      apps: ["faq", "mail", "core"],
      coreRelease: release,
      nextCoreRelease,
    };
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "define-app.stylesheet-versions.test-fixture.ts"), JSON.stringify(probe)],
      {
        cwd: new URL("../..", import.meta.url).pathname,
        env: { ...process.env, NODE_ENV: nodeEnv },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 20_000,
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ exitCode, errors: exitCode === 0 ? "" : stderr }).toEqual({ exitCode: 0, errors: "" });
    return stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
  };

  try {
    const [first, afterCoreRedeploy] = await start("sha-0123456789ab", { nextCoreRelease: "sha-core-redeployed" });
    const [restarted] = await start("sha-0123456789ab");
    expect(restarted).toEqual(first);
    for (const id of ["faq", "mail", "core"]) {
      expect(first![id]!.status).toBe(200);
      expect(first![id]!.hrefs).toHaveLength(5);
      for (const sheet of sheets) expect(first![id]!.hrefs).toContain(`/public/${sheet}.css?v=sha-0123456789ab`);
    }
    expect(first!.faq!.hrefs).toContain(`/public/faq/app.css?v=${hash(faqCss)}`);
    expect(first!.mail!.hrefs).toContain(`/public/mail/app.css?v=${hash(mailCss)}`);
    expect(first!.faq!.hrefs).toContain(`/public/faq/favicon.svg?v=${hash('<svg id="faq"/>')}`);
    expect(first!.core!.hrefs).toContain("/branding/favicon");
    for (const id of ["faq", "mail", "core"]) {
      expect(afterCoreRedeploy![id]).toEqual({
        status: 200,
        hrefs: first![id]!.hrefs.map((href) => href.replace("v=sha-0123456789ab", "v=sha-core-redeployed")),
      });
    }

    const updatedCss = "body{color:green}";
    writeFileSync(join(root, "public", "faq", "app.css"), updatedCss);
    const [changed] = await start("sha-0123456789ab");
    expect(changed).toEqual({
      ...first,
      faq: {
        status: 200,
        hrefs: first!.faq!.hrefs.map((href) =>
          href === `/public/faq/app.css?v=${hash(faqCss)}` ? `/public/faq/app.css?v=${hash(updatedCss)}` : href,
        ),
      },
    });

    rmSync(join(root, "public", "mail", "app.css"));
    const [unnamed] = await start("local");
    expect(unnamed!.mail!.status).toBe(200);
    expect(unnamed!.mail!.hrefs).toContain("/public/mail/app.css");
    for (const id of ["faq", "mail", "core"]) {
      for (const sheet of sheets) expect(unnamed![id]!.hrefs).toContain(`/public/${sheet}.css`);
    }

    const [development] = await start("sha-0123456789ab", { nodeEnv: "development" });
    // Exactly the five original development hrefs, in their original order, with one shared start stamp.
    const stamp = /\?v=(\d+)$/.exec(development!.faq!.hrefs[0]!)?.[1];
    expect(stamp).toMatch(/^\d+$/);
    for (const id of ["faq", "mail"]) {
      expect(development![id]!.status).toBe(200);
      expect(development![id]!.hrefs).toEqual([
        `/public/${id}/favicon.svg?v=${stamp}`,
        `/public/fonts.css?v=${stamp}`,
        `/public/tabler-icons.css?v=${stamp}`,
        `/public/${id}/app.css?v=${stamp}`,
        `/public/global.css?v=${stamp}`,
      ]);
    }
    expect(development!.core!.hrefs[0]).toBe("/branding/favicon");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
