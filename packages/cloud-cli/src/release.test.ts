import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises";
import { arch, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { COSIGN_CERTIFICATE_IDENTITY_REGEXP, cosignVerifyBlobArgs, resolveCliRelease, updateCli } from "./release";

const temporaryDirectories: string[] = [];

const createTemporaryDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "cld-release-test-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

const currentAssetName = () => {
  const os = platform();
  const cpu = arch() === "x64" ? "x64" : arch() === "arm64" ? "arm64" : null;
  if ((os !== "darwin" && os !== "linux") || !cpu) throw new Error("Unsupported release test platform.");
  return `cld_${os}_${cpu}`;
};

const createSkillArchive = async (directory: string): Promise<Uint8Array> => {
  const source = join(directory, "skill-source");
  const archive = join(directory, "cloud-cli-skill.tar.gz");
  await mkdir(join(source, "cloud-cli"), { recursive: true });
  await writeFile(join(source, "cloud-cli", "SKILL.md"), "---\nname: cloud-cli\n---\n# Cloud CLI\n");
  const tar = Bun.spawn(["tar", "-czf", archive, "-C", source, "cloud-cli"], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([tar.exited, new Response(tar.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
  return new Uint8Array(await Bun.file(archive).arrayBuffer());
};

/** A `cosign` on PATH that records its arguments, one per line, and exits with the given code. */
const createCosignStub = async (directory: string, exitCode = 0) => {
  const bin = join(directory, "stub-bin");
  const log = join(directory, "cosign.args");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "cosign"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit ${exitCode}\n`, { mode: 0o755 });
  await chmod(join(bin, "cosign"), 0o755);
  return { path: `${bin}:${process.env.PATH ?? ""}`, args: async () => (await readFile(log, "utf8")).trimEnd().split("\n") };
};

const cosignIdentityArgs = [
  "--certificate-identity-regexp",
  COSIGN_CERTIFICATE_IDENTITY_REGEXP,
  "--certificate-oidc-issuer",
  "https://token.actions.githubusercontent.com",
];

/** `bundle` is the HTTP status of the bundle asset; absent means 404. */
type SignatureAssets = { bundle?: number; signature?: boolean };

/** Serves release cloud-v1.2.3 with a binary, its checksum, and the requested signature assets; records requested paths. */
const serveSignedRelease = (assetName: string, binary: string, assets: SignatureAssets) => {
  const requested: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      requested.push(url.pathname);
      const base = "/release/download/cloud-v1.2.3";
      if (url.pathname === "/releases") return Response.json([{ tag_name: "cloud-v1.2.3" }]);
      if (url.pathname === `${base}/checksums.txt`) return new Response(`${sha256(new TextEncoder().encode(binary))}  ${assetName}\n`);
      if (url.pathname === `${base}/${assetName}`) return new Response(binary);
      if (url.pathname === `${base}/checksums.txt.sigstore.json` && assets.bundle) return new Response("{}", { status: assets.bundle });
      if (url.pathname === `${base}/checksums.txt.sig` && assets.signature) return new Response("signature");
      if (url.pathname === `${base}/checksums.txt.pem` && assets.signature) return new Response("certificate");
      return new Response("not found", { status: 404 });
    },
  });
  return { server, requested };
};

describe("Cloud CLI releases", () => {
  test("resolves the highest stable CLI release across pages", async () => {
    const firstPage = [
      { tag_name: "cloud-core-v1.0.0" },
      { tag_name: "cloud-v1.9.4" },
      { tag_name: "cloud-v2.0.0-rc.1", prerelease: true },
      ...Array.from({ length: 97 }, (_, index) => ({ id: index })),
    ];
    const release = await resolveCliRelease(undefined, {
      fetchImpl: async (input) => {
        const page = new URL(String(input)).searchParams.get("page");
        return Response.json(page === "1" ? firstPage : [{ tag_name: "cloud-v2.0.0" }]);
      },
    });

    expect(release).toEqual({ tag: "cloud-v2.0.0", version: "2.0.0" });
  });

  test("rejects prerelease versions and pins Cosign to the release workflow on main", async () => {
    await expect(resolveCliRelease("1.2.3-rc.1", { fetchImpl: async () => Response.json({}) })).rejects.toThrow("stable version");
    expect(COSIGN_CERTIFICATE_IDENTITY_REGEXP).toContain("workflows/release");
    expect(COSIGN_CERTIFICATE_IDENTITY_REGEXP).toContain("workflows/release\\.yml@refs/heads/main");
    const identity = new RegExp(COSIGN_CERTIFICATE_IDENTITY_REGEXP);
    expect(identity.test("https://github.com/k2b-dev/cloud/.github/workflows/release.yml@refs/heads/main")).toBe(true);
    expect(identity.test("https://github.com/k2b-dev/cloud/.github/workflows/release.yml@refs/heads/feature")).toBe(false);
    expect(identity.test("https://github.com/k2b-dev/cloud/.github/workflows/ci.yml@refs/heads/main")).toBe(false);
    expect(identity.test("https://github.com/other-owner/cloud/.github/workflows/release.yml@refs/heads/main")).toBe(false);
    expect(identity.test("https://github.com/k2b-dev/other/.github/workflows/release.yml@refs/heads/main")).toBe(false);
  });

  test("updates an installed binary only after checksum verification", async () => {
    const directory = await createTemporaryDirectory();
    const executablePath = join(directory, "cld");
    const skillsDir = join(directory, "skills");
    const claudeSkillsDir = join(directory, "claude-skills");
    const assetName = "cld_linux_x64";
    const replacement = new TextEncoder().encode("new binary");
    const skillArchive = await createSkillArchive(directory);
    await writeFile(executablePath, "old binary", { mode: 0o755 });
    await chmod(executablePath, 0o755);

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/releases") return Response.json([{ tag_name: "cloud-v1.2.3" }]);
        if (url.pathname === "/release/download/cloud-v1.2.3/checksums.txt")
          return new Response(`${sha256(replacement)}  ${assetName}\n${sha256(skillArchive)}  cloud-cli-skill.tar.gz\n`);
        if (url.pathname === `/release/download/cloud-v1.2.3/${assetName}`) return new Response(replacement);
        if (url.pathname === "/release/download/cloud-v1.2.3/cloud-cli-skill.tar.gz") return new Response(skillArchive.slice().buffer);
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const result = await updateCli({
        apiBase: `http://127.0.0.1:${server.port}`,
        releaseBase: `http://127.0.0.1:${server.port}/release`,
        executablePath,
        standalone: true,
        target: { os: "linux", arch: "x64", asset: assetName },
        verifyCosign: false,
        skillsDir,
        claudeSymlink: true,
        claudeSkillsDir,
        confirm: async () => true,
      });

      expect(result.release.version).toBe("1.2.3");
      expect(result.skill).toBe("installed");
      expect(result.claudeSymlink).toBe("created");
      expect(await readFile(executablePath, "utf8")).toBe("new binary");
      expect(await readFile(join(skillsDir, "cloud-cli", "SKILL.md"), "utf8")).toContain("Cloud CLI");
      expect(await readlink(join(claudeSkillsDir, "cloud-cli"))).toBe(join(skillsDir, "cloud-cli"));
    } finally {
      server.stop(true);
    }
  });

  test("refuses an update when the release checksum does not match", async () => {
    const directory = await createTemporaryDirectory();
    const executablePath = join(directory, "cld");
    const assetName = "cld_linux_x64";
    await writeFile(executablePath, "old binary", { mode: 0o755 });
    await chmod(executablePath, 0o755);

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/releases") return Response.json([{ tag_name: "cloud-v1.2.3" }]);
        if (url.pathname === "/release/download/cloud-v1.2.3/checksums.txt") return new Response(`${"0".repeat(64)}  ${assetName}\n`);
        if (url.pathname === `/release/download/cloud-v1.2.3/${assetName}`) return new Response("new binary");
        return new Response("not found", { status: 404 });
      },
    });

    try {
      await expect(
        updateCli({
          apiBase: `http://127.0.0.1:${server.port}`,
          releaseBase: `http://127.0.0.1:${server.port}/release`,
          executablePath,
          standalone: true,
          target: { os: "linux", arch: "x64", asset: assetName },
          verifyCosign: false,
          installSkill: false,
          confirm: async () => true,
        }),
      ).rejects.toThrow("checksum verification failed");
      expect(await readFile(executablePath, "utf8")).toBe("old binary");
    } finally {
      server.stop(true);
    }
  });

  test("installs the highest stable, non-draft, non-prerelease release through the shell installer", async () => {
    const directory = await createTemporaryDirectory();
    const prefix = join(directory, "bin");
    const skillsDir = join(directory, "skills");
    const assetName = currentAssetName();
    const binary = new TextEncoder().encode("release binary");
    const skillArchive = await createSkillArchive(directory);
    await mkdir(prefix, { mode: 0o700 });
    await chmod(prefix, 0o700);
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/releases") {
          if (url.searchParams.get("page") !== "1") return Response.json([]);
          return new Response(
            JSON.stringify(
              [
                { tag_name: "npm-cloud-v9.9.9" },
                { tag_name: "cloud-core-v9.9.9" },
                { tag_name: "cloud-v3.0.0", draft: true, prerelease: false },
                { tag_name: "cloud-v2.1.0", draft: false, prerelease: true },
                { tag_name: "cloud-v1.9.4", draft: false, prerelease: false },
                { tag_name: "cloud-v2.0.0", draft: false, prerelease: false },
              ],
              null,
              2,
            ),
          );
        }
        if (url.pathname === "/release/download/cloud-v2.0.0/checksums.txt")
          return new Response(`${sha256(binary)}  ${assetName}\n${sha256(skillArchive)}  cloud-cli-skill.tar.gz\n`);
        if (url.pathname === `/release/download/cloud-v2.0.0/${assetName}`) return new Response(binary);
        if (url.pathname === "/release/download/cloud-v2.0.0/cloud-cli-skill.tar.gz") return new Response(skillArchive.slice().buffer);
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const installer = join(import.meta.dir, "..", "scripts", "install.sh");
      const child = Bun.spawn(["sh", installer, `--prefix=${prefix}`, `--skills-dir=${skillsDir}`, "--yes", "--no-verify"], {
        env: {
          ...process.env,
          CLD_RELEASE_API_BASE: `http://127.0.0.1:${server.port}`,
          CLD_RELEASE_BASE: `http://127.0.0.1:${server.port}/release`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("installed");
      expect(await readFile(join(prefix, "cld"), "utf8")).toBe("release binary");
      expect(await readFile(join(skillsDir, "cloud-cli", "SKILL.md"), "utf8")).toContain("Cloud CLI");
      expect((await stat(prefix)).mode & 0o777).toBe(0o700);
    } finally {
      server.stop(true);
    }
  });

  test("accepts space-separated installer flags and refreshes the skill when cld is already current", async () => {
    const directory = await createTemporaryDirectory();
    const prefix = join(directory, "bin");
    const skillsDir = join(directory, "skills");
    const assetName = currentAssetName();
    const skillArchive = await createSkillArchive(directory);
    await mkdir(prefix, { recursive: true, mode: 0o700 });
    await writeFile(join(prefix, "cld"), "#!/bin/sh\nprintf 'cld 2.0.0\\n'\n", { mode: 0o755 });
    await chmod(join(prefix, "cld"), 0o755);

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/releases") {
          if (url.searchParams.get("page") !== "1") return Response.json([]);
          return new Response(JSON.stringify([{ tag_name: "cloud-v2.0.0" }], null, 2));
        }
        if (url.pathname === "/release/download/cloud-v2.0.0/checksums.txt")
          return new Response(`${"0".repeat(64)}  ${assetName}\n${sha256(skillArchive)}  cloud-cli-skill.tar.gz\n`);
        if (url.pathname === "/release/download/cloud-v2.0.0/cloud-cli-skill.tar.gz") return new Response(skillArchive.slice().buffer);
        return new Response("not found", { status: 404 });
      },
    });

    try {
      const installer = join(import.meta.dir, "..", "scripts", "install.sh");
      const child = Bun.spawn(
        ["sh", installer, "--prefix", prefix, "--skills-dir", skillsDir, "--version", "2.0.0", "--yes", "--no-verify"],
        {
          env: {
            ...process.env,
            CLD_RELEASE_API_BASE: `http://127.0.0.1:${server.port}`,
            CLD_RELEASE_BASE: `http://127.0.0.1:${server.port}/release`,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("already installed");
      expect(stdout).toContain("Cloud CLI skill installed");
      expect(await readFile(join(prefix, "cld"), "utf8")).toContain("cld 2.0.0");
      expect(await readFile(join(skillsDir, "cloud-cli", "SKILL.md"), "utf8")).toContain("Cloud CLI");
    } finally {
      server.stop(true);
    }
  });
  test("builds cosign verify-blob arguments for a bundle and for the detached signature", () => {
    expect(cosignVerifyBlobArgs("/t/checksums.txt", { bundle: "/t/checksums.txt.sigstore.json" })).toEqual([
      "verify-blob",
      "--bundle",
      "/t/checksums.txt.sigstore.json",
      ...cosignIdentityArgs,
      "/t/checksums.txt",
    ]);
    expect(cosignVerifyBlobArgs("/t/checksums.txt", { signature: "/t/checksums.txt.sig", certificate: "/t/checksums.txt.pem" })).toEqual([
      "verify-blob",
      "--certificate",
      "/t/checksums.txt.pem",
      "--signature",
      "/t/checksums.txt.sig",
      ...cosignIdentityArgs,
      "/t/checksums.txt",
    ]);
  });

  const updateWithCosign = async (assets: SignatureAssets, cosignExitCode = 0) => {
    const directory = await createTemporaryDirectory();
    const executablePath = join(directory, "cld");
    const assetName = "cld_linux_x64";
    await writeFile(executablePath, "old binary", { mode: 0o755 });
    const cosign = await createCosignStub(directory, cosignExitCode);
    const { server, requested } = serveSignedRelease(assetName, "new binary", assets);
    const originalPath = process.env.PATH;
    process.env.PATH = cosign.path;
    try {
      const result = await updateCli({
        apiBase: `http://127.0.0.1:${server.port}`,
        releaseBase: `http://127.0.0.1:${server.port}/release`,
        executablePath,
        standalone: true,
        target: { os: "linux", arch: "x64", asset: assetName },
        installSkill: false,
        confirm: async () => true,
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      return { result, requested, cosign, executablePath };
    } finally {
      process.env.PATH = originalPath;
      server.stop(true);
    }
  };

  test("cld update verifies the checksum manifest with the Sigstore bundle when the release has one", async () => {
    const { result, requested, cosign, executablePath } = await updateWithCosign({ bundle: 200, signature: true });

    expect("value" in result && result.value.cosign).toBe("verified");
    const args = await cosign.args();
    expect(args.slice(0, 2)).toEqual(["verify-blob", "--bundle"]);
    expect(args[2]).toEndWith("/checksums.txt.sigstore.json");
    expect(args.slice(3, 7)).toEqual(cosignIdentityArgs);
    expect(args[7]).toEndWith("/checksums.txt");
    expect(requested.some((path) => path.endsWith(".sig") || path.endsWith(".pem"))).toBe(false);
    expect(await readFile(executablePath, "utf8")).toBe("new binary");
  });

  test("cld update falls back to the detached signature only when the release has no bundle", async () => {
    const { result, cosign } = await updateWithCosign({ signature: true });

    expect("value" in result && result.value.cosign).toBe("verified");
    const args = await cosign.args();
    expect(args[0]).toBe("verify-blob");
    expect(args[1]).toBe("--certificate");
    expect(args[2]).toEndWith("/checksums.txt.pem");
    expect(args[3]).toBe("--signature");
    expect(args[4]).toEndWith("/checksums.txt.sig");
    expect(args.slice(5, 9)).toEqual(cosignIdentityArgs);
  });

  test("cld update refuses the release when the bundle cannot be downloaded or does not verify", async () => {
    const unavailable = await updateWithCosign({ bundle: 403, signature: true });
    expect("error" in unavailable.result && String(unavailable.result.error)).toContain("checksums.txt.sigstore.json (403)");
    expect(await readFile(unavailable.executablePath, "utf8")).toBe("old binary");

    const rejected = await updateWithCosign({ bundle: 200, signature: true }, 1);
    expect("error" in rejected.result && String(rejected.result.error)).toContain("Cosign verification failed");
    expect(await readFile(rejected.executablePath, "utf8")).toBe("old binary");
  });

  const installWithCosign = async (assets: SignatureAssets) => {
    const directory = await createTemporaryDirectory();
    const prefix = join(directory, "bin");
    const assetName = currentAssetName();
    const cosign = await createCosignStub(directory);
    const { server, requested } = serveSignedRelease(assetName, "release binary", assets);
    try {
      const installer = join(import.meta.dir, "..", "scripts", "install.sh");
      const child = Bun.spawn(["sh", installer, "--prefix", prefix, "--version", "1.2.3", "--no-skills", "--yes"], {
        env: {
          ...process.env,
          PATH: cosign.path,
          CLD_RELEASE_API_BASE: `http://127.0.0.1:${server.port}`,
          CLD_RELEASE_BASE: `http://127.0.0.1:${server.port}/release`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, output: `${stdout}\n${stderr}`, requested, cosign };
    } finally {
      server.stop(true);
    }
  };

  test("the shell installer prefers the Sigstore bundle and falls back to the detached signature", async () => {
    const bundled = await installWithCosign({ bundle: 200, signature: true });
    expect(bundled.exitCode, bundled.output).toBe(0);
    const bundleArgs = await bundled.cosign.args();
    expect(bundleArgs.slice(0, 2)).toEqual(["verify-blob", "--bundle"]);
    expect(bundleArgs[2]).toEndWith("/checksums.txt.sigstore.json");
    expect(bundleArgs.slice(3, 7)).toEqual(cosignIdentityArgs);
    expect(bundled.requested.some((path) => path.endsWith(".sig") || path.endsWith(".pem"))).toBe(false);

    const detached = await installWithCosign({ signature: true });
    expect(detached.exitCode, detached.output).toBe(0);
    const detachedArgs = await detached.cosign.args();
    expect(detachedArgs[1]).toBe("--certificate");
    expect(detachedArgs[2]).toEndWith("/checksums.txt.pem");
    expect(detachedArgs[3]).toBe("--signature");
    expect(detachedArgs[4]).toEndWith("/checksums.txt.sig");
    expect(detachedArgs.slice(5, 9)).toEqual(cosignIdentityArgs);

    const broken = await installWithCosign({ bundle: 403, signature: true });
    expect(broken.exitCode).not.toBe(0);
    expect(broken.output).toContain("could not download the checksum bundle");
  });
});

test("release API requests carry a GitHub token only when one is configured", async () => {
  const { releaseApiHeaders } = await import("./release");
  expect(releaseApiHeaders(undefined)).toEqual({ Accept: "application/vnd.github+json" });
  expect(releaseApiHeaders("ghs_x")).toEqual({ Accept: "application/vnd.github+json", Authorization: "Bearer ghs_x" });
});
