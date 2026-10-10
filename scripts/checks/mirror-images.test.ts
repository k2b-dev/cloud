import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { dockerHubImage, rule } from "./mirror-images";

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const list = `# comment\nnats:2.14.3-alpine@${digest("a")}\noven/bun:1.4.2@${digest("b")}\n`;
const nats = `ghcr.io/k2b-dev/mirror/nats:2.14.3-alpine@${digest("a")}`;
const bun = `ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@${digest("b")}`;

/** Runs the rule on a repository with these files and returns `file:line message` per finding. */
const findings = async (files: Record<string, string>) => {
  const root = await mkdtemp(join(tmpdir(), "cloud-mirror-images-"));
  try {
    for (const [path, source] of Object.entries({ ".github/mirror-images.txt": list, ...files })) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), source);
    }
    Bun.spawnSync(["git", "init", "--quiet"], { cwd: root });
    const found = await rule.run({ workspaceRoot: root, fix: false, flags: new Set() });
    return found.map((finding) => `${relative(root, finding.file ?? "")}:${finding.line ?? ""} ${finding.message}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const workflow = (job: string) => `on: push\njobs:\n  test:\n    runs-on: ubuntu-24.04\n${job}`;

test("reads Docker Hub references and leaves other registries, local builds and shell words alone", () => {
  expect(dockerHubImage("postgres:17-alpine")).toBe("postgres:17-alpine");
  expect(dockerHubImage("docker.io/library/postgres:17-alpine")).toBe("postgres:17-alpine");
  expect(dockerHubImage("docker.io/valkey/valkey:8-alpine")).toBe("valkey/valkey:8-alpine");
  expect(dockerHubImage(`oven/bun:1.4.2@${digest("b")}`)).toBe("oven/bun:1.4.2");
  expect(dockerHubImage("alpine")).toBe("alpine");
  for (const other of [nats, "mcr.microsoft.com/playwright:v1", "localhost/x:1", "cloud-core:ci", "${{ matrix.image }}"])
    expect(dockerHubImage(other)).toBeUndefined();
  for (const word of ["pwuser", "127.0.0.1:3000:3000", "0:0", "max-size=4m", "/etc/nats.conf:ro"])
    expect(dockerHubImage(word, { word: true })).toBeUndefined();
});

test("accepts mirror references at the listed digest and images pulled through pull-images.sh", async () => {
  expect(
    await findings({
      Dockerfile: `# syntax=${bun}\nFROM --platform=$BUILDPLATFORM ${bun} AS build\nFROM build AS test\nFROM ghcr.io/k2b-dev/filegate:7.0.0\n`,
      ".github/workflows/ci.yml": workflow(
        `    services:\n      nats:\n        image: ${nats}\n    steps:\n      - run: |\n          "$GITHUB_WORKSPACE/.github/pull-images.sh" nats:2.14.3-alpine ghcr.io/k2b-dev/filegate:7.0.0\n          docker run --detach --publish 127.0.0.1:4222:4222 \\\n            nats:2.14.3-alpine --js\n          docker run --detach cloud-core:ci\n`,
      ),
    }),
  ).toEqual([]);
});

test("rejects Docker Hub images in Dockerfiles and names the mirror reference", async () => {
  expect(
    await findings({
      "docs/Dockerfile.dev": `# syntax=docker/dockerfile:1.7-labs\nFROM oven/bun:1.4.2 AS build\nFROM ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@${digest("c")}\nFROM alpine\n`,
      ".github/workflows/ci.yml": workflow(`    steps:\n      - run: .github/pull-images.sh nats:2.14.3-alpine\n`),
    }),
  ).toEqual([
    `docs/Dockerfile.dev:3 use ${bun}, the digest pinned in .github/mirror-images.txt`,
    "docs/Dockerfile.dev:1 docker/dockerfile:1.7-labs would be pulled from Docker Hub; add it to .github/mirror-images.txt and pull it from the mirror",
    `docs/Dockerfile.dev:2 oven/bun:1.4.2 would be pulled from Docker Hub; use ${bun}`,
    "docs/Dockerfile.dev:4 alpine would be pulled from Docker Hub; add it to .github/mirror-images.txt and pull it from the mirror",
    ".github/mirror-images.txt:3 no workflow or Dockerfile uses oven/bun:1.4.2; remove it from the list",
  ]);
});

test("rejects Docker Hub images that a workflow job would pull directly", async () => {
  const found = await findings({
    Dockerfile: `FROM ${bun}\n`,
    "compose.test.yml": "services:\n  valkey:\n    image: docker.io/valkey/valkey:8-alpine\n",
    ".github/workflows/ci.yml": workflow(
      [
        "    strategy:",
        "      matrix:",
        "        include:",
        "          - image: postgres:17-alpine",
        "    services:",
        "      postgres:",
        "        image: ${{ matrix.image }}",
        "      nats:",
        "        image: nats:2.14.3-alpine",
        "    steps:",
        "      - uses: docker/setup-buildx-action@0000000000000000000000000000000000000000 # v4",
        "      - run: |",
        "          .github/pull-images.sh debian:13-slim",
        "          docker run --rm nats:2.14.3-alpine",
        "          docker pull redis:7",
        "          docker compose -f compose.test.yml up -d",
        "      - uses: docker://alpine:3.20",
        "      - uses: docker/build-push-action@0000000000000000000000000000000000000000 # v7",
        "        with:",
        "          sbom: true",
        "      - uses: docker/build-push-action@1111111111111111111111111111111111111111 # v7",
        "        with:",
        "          attests: type=sbom",
        "",
      ].join("\n"),
    ),
  });
  expect(found).toEqual([
    ".github/workflows/ci.yml:17 debian:13-slim would be pulled from Docker Hub; add it to .github/mirror-images.txt and pull it from the mirror",
    ".github/workflows/ci.yml:18 job test starts nats:2.14.3-alpine without pulling it through .github/pull-images.sh first, so it would come from Docker Hub",
    ".github/workflows/ci.yml:20 job test starts valkey/valkey:8-alpine without pulling it through .github/pull-images.sh first, so it would come from Docker Hub",
    ".github/workflows/ci.yml:19 pull redis:7 through .github/pull-images.sh",
    ".github/workflows/ci.yml:8 postgres:17-alpine would be pulled from Docker Hub; add it to .github/mirror-images.txt and pull it from the mirror",
    `.github/workflows/ci.yml:13 nats:2.14.3-alpine would be pulled from Docker Hub; use ${nats}`,
    ".github/workflows/ci.yml:15 job test: docker/setup-buildx-action pulls moby/buildkit from Docker Hub; set driver-opts to image=ghcr.io/k2b-dev/mirror/<its entry in .github/mirror-images.txt>",
    ".github/workflows/ci.yml:21 alpine:3.20 would be pulled from Docker Hub; add it to .github/mirror-images.txt and pull it from the mirror",
    ".github/workflows/ci.yml:22 job test: the SBOM attestation pulls its generator from Docker Hub; set sbom to generator=ghcr.io/k2b-dev/mirror/<its entry in .github/mirror-images.txt>",
    ".github/workflows/ci.yml:25 job test: the SBOM attestation pulls its generator from Docker Hub; set sbom to generator=ghcr.io/k2b-dev/mirror/<its entry in .github/mirror-images.txt>",
    ".github/mirror-images.txt:2 no workflow or Dockerfile uses nats:2.14.3-alpine; remove it from the list",
  ]);
});

test("accepts docker:// steps and an SBOM generator from the mirror", async () => {
  const scanner = `ghcr.io/k2b-dev/mirror/docker/buildkit-syft-scanner:1.12.0@${digest("c")}`;
  expect(
    await findings({
      ".github/mirror-images.txt": `nats:2.14.3-alpine@${digest("a")}\ndocker/buildkit-syft-scanner:1.12.0@${digest("c")}\n`,
      ".github/workflows/release.yml": workflow(
        [
          "    steps:",
          `      - uses: docker://${nats}`,
          "      - uses: docker/build-push-action@0000000000000000000000000000000000000000 # v7",
          "        with:",
          `          sbom: generator=${scanner}`,
          "      - uses: docker/build-push-action@1111111111111111111111111111111111111111 # v7",
          "        with:",
          "          sbom: false",
          "          attests: type=provenance,mode=max",
          "",
        ].join("\n"),
      ),
    }),
  ).toEqual([]);
});

test("rejects malformed and unused list entries and mirror references that are not listed", async () => {
  expect(
    await findings({
      ".github/mirror-images.txt": `${list}postgres:17-alpine\nghcr.io/x/y:1@${digest("d")}\nnats:2.14.3-alpine@${digest("e")}\n`,
      Dockerfile: `FROM ${bun}\nFROM ghcr.io/k2b-dev/mirror/debian:13-slim@${digest("f")}\n`,
      "packages/example/scripts/acceptance.ts": `await docker("run", "ghcr.io/k2b-dev/mirror/oven/bun:1.4.2@${digest("c")}");\n`,
      ".github/tool.sh": `image=ghcr.io/k2b-dev/mirror/nats:2.14.3-alpine@${digest("c")}\n`,
    }),
  ).toEqual([
    ".github/mirror-images.txt:4 expected a Docker Hub image as <name>:<tag>@sha256:<digest>, got postgres:17-alpine",
    `.github/mirror-images.txt:5 expected a Docker Hub image as <name>:<tag>@sha256:<digest>, got ghcr.io/x/y:1@${digest("d")}`,
    ".github/mirror-images.txt:6 nats:2.14.3-alpine is listed twice",
    `.github/tool.sh:1 use ${nats}, the digest pinned in .github/mirror-images.txt`,
    `Dockerfile:2 ghcr.io/k2b-dev/mirror/debian:13-slim@${digest("f")} is not in .github/mirror-images.txt`,
    `packages/example/scripts/acceptance.ts:1 use ${bun}, the digest pinned in .github/mirror-images.txt`,
    ".github/mirror-images.txt:2 no workflow or Dockerfile uses nats:2.14.3-alpine; remove it from the list",
  ]);
});
