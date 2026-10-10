import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import type { Finding, Rule } from "./rule";

const mirror = "ghcr.io/k2b-dev/mirror/";
const listPath = ".github/mirror-images.txt";

const component = "[a-z0-9]+(?:[._-][a-z0-9]+)*";
const reference = new RegExp(`^(${component}(?:/${component})*)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(@sha256:[0-9a-f]{64})?$`);
const mirrorReference = /ghcr\.io\/k2b-dev\/mirror\/[^\s"'`]*/g;

/**
 * The `name:tag` of a Docker Hub image reference, or undefined for another
 * registry, an expression, and anything else. Words of a shell command count
 * only with a tag or digest, so `--user pwuser` is no image. Images named
 * `cloud-*` are this repository's own local builds.
 */
export const dockerHubImage = (image: string, { word = false } = {}): string | undefined => {
  const match = reference.exec(image.replace(/^["']|["']$/g, ""));
  const path = match?.[1];
  if (!match || !path || (word && !match[2] && !match[3])) return undefined;
  const first = path.split("/")[0] ?? "";
  if (path.includes("/") && (first.includes(".") || first === "localhost") && first !== "docker.io") return undefined;
  const name = path.replace(/^docker\.io\//, "").replace(/^library\//, "");
  if (!/^[a-z]/.test(name) || name.startsWith("cloud-")) return undefined;
  return match[2] ? `${name}:${match[2]}` : name;
};

type Entry = { reference: string; line: number };
type Source = { file: string; text: string };
type State = { entries: Map<string, Entry>; used: Set<string>; findings: Finding[] };

/** The line of the first `needle` at or after offset `from`. */
const lineOf = (text: string, needle: string, from = 0): number | undefined => {
  const index = text.indexOf(needle, Math.max(0, from));
  return index === -1 ? undefined : text.slice(0, index).split("\n").length;
};

const dockerHubFinding = (state: State, source: Source, image: string, needle: string, from = 0): Finding => {
  const entry = state.entries.get(image);
  return {
    file: source.file,
    line: lineOf(source.text, needle, from),
    message: entry
      ? `${image} would be pulled from Docker Hub; use ${mirror}${entry.reference}`
      : `${image} would be pulled from Docker Hub; add it to ${listPath} and pull it from the mirror`,
  };
};

/** Every mirror reference in `source` must be an entry of the list at its pinned digest. */
const checkMirrorReferences = (state: State, source: Source) => {
  for (const match of source.text.matchAll(mirrorReference)) {
    const pinned = match[0].slice(mirror.length);
    const image = pinned.split("@")[0] ?? "";
    const entry = state.entries.get(image);
    const line = source.text.slice(0, match.index).split("\n").length;
    if (entry?.reference === pinned) state.used.add(image);
    else if (entry)
      state.findings.push({ file: source.file, line, message: `use ${mirror}${entry.reference}, the digest pinned in ${listPath}` });
    else state.findings.push({ file: source.file, line, message: `${match[0]} is not in ${listPath}` });
  }
};

/** The `# syntax=` frontend and every `FROM` image that is no earlier stage. */
const checkDockerfile = (state: State, source: Source) => {
  checkMirrorReferences(state, source);
  const stages = new Set(["scratch"]);
  const syntax = /^#\s*syntax\s*=\s*(\S+)/m.exec(source.text)?.[1];
  const images = syntax ? [syntax] : [];
  for (const [, image, stage] of source.text.matchAll(/^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/gim)) {
    if (image && !stages.has(image)) images.push(image);
    if (stage) stages.add(stage);
  }
  for (const image of images) {
    const hub = dockerHubImage(image);
    if (hub) state.findings.push(dockerHubFinding(state, source, hub, image));
  }
};

const imageHolder = z.object({ image: z.string().optional() }).nullish();
const workflowSchema = z.object({
  jobs: z
    .record(
      z.string(),
      z.object({
        services: z.record(z.string(), imageHolder).optional(),
        container: z.union([z.string(), imageHolder]).optional(),
        strategy: z.object({ matrix: z.union([z.record(z.string(), z.unknown()), z.string()]).optional() }).optional(),
        steps: z
          .array(z.object({ run: z.string().optional(), uses: z.string().optional(), with: z.record(z.string(), z.unknown()).optional() }))
          .default([]),
      }),
    )
    .default({}),
});
type Job = z.infer<typeof workflowSchema>["jobs"][string];
const composeSchema = z.object({ services: z.record(z.string(), imageHolder).default({}) });

/** The values that an image such as `${{ matrix.image }}` takes in this job. */
const resolve = (image: string, job: Job): unknown[] => {
  const key = /^\$\{\{\s*matrix\.(\w+)\s*\}\}$/.exec(image)?.[1];
  const matrix = job.strategy?.matrix;
  if (!key || typeof matrix !== "object") return [image];
  const values = matrix[key];
  const include = z.array(z.record(z.string(), z.unknown())).catch([]).parse(matrix.include);
  return [...(Array.isArray(values) ? values : []), ...include.map((entry) => entry[key])];
};

/** The words after `command` on each line of `run` that calls it, with continuation lines joined. */
const commandWords = (run: string, command: RegExp): string[] =>
  run
    .replace(/\\\n/g, " ")
    .split("\n")
    .flatMap((line) => {
      const match = command.exec(line);
      return match ? line.slice(match.index + match[0].length).split(/\s+/) : [];
    });

const checkJob = (state: State, source: Source, root: string, id: string, job: Job) => {
  const runs = job.steps.map((step) => step.run ?? "");
  const words = (command: RegExp) => runs.flatMap((run) => commandWords(run, command));
  // Findings point to the first match in this job, and for step commands in its steps.
  const jobStart = source.text.indexOf(`\n  ${id}:`);
  const stepsStart = source.text.indexOf("steps:", jobStart);

  const pulled = new Set<string>();
  for (const word of words(/pull-images\.sh"?/)) {
    const image = dockerHubImage(word, { word: true });
    if (image && state.entries.has(image)) pulled.add(image);
    else if (image) state.findings.push(dockerHubFinding(state, source, image, word, stepsStart));
  }
  for (const image of pulled) state.used.add(image);

  // Image to the text that starts it; a Compose file counts once per job.
  const started = new Map<string, string>();
  for (const word of words(/docker (?:run|create)\b/)) {
    const image = dockerHubImage(word, { word: true });
    if (image) started.set(image, word);
  }
  for (const run of runs)
    for (const [needle, file] of run.matchAll(/docker compose -f (\S+)/g)) {
      const compose = composeSchema.parse(Bun.YAML.parse(readFileSync(join(root, file ?? ""), "utf8")));
      for (const service of Object.values(compose.services)) {
        const image = service?.image && dockerHubImage(service.image);
        if (image && !started.has(image)) started.set(image, needle);
      }
    }
  for (const [image, needle] of started)
    if (!pulled.has(image))
      state.findings.push({
        file: source.file,
        line: lineOf(source.text, needle, stepsStart),
        message: `job ${id} starts ${image} without pulling it through .github/pull-images.sh first, so it would come from Docker Hub`,
      });

  for (const word of words(/docker pull\b/)) {
    const image = dockerHubImage(word, { word: true });
    if (image)
      state.findings.push({
        file: source.file,
        line: lineOf(source.text, word, stepsStart),
        message: `pull ${image} through .github/pull-images.sh`,
      });
  }

  const container = typeof job.container === "string" ? job.container : job.container?.image;
  const images = [...Object.values(job.services ?? {}).map((service) => service?.image), container]
    .flatMap((image) => (image ? resolve(image, job) : []))
    .filter((image): image is string => typeof image === "string");
  for (const image of images) {
    const hub = dockerHubImage(image);
    if (hub) state.findings.push(dockerHubFinding(state, source, hub, image, jobStart));
  }

  for (const step of job.steps) {
    const uses = step.uses ?? "";
    const finding = (message: string) =>
      state.findings.push({ file: source.file, line: lineOf(source.text, uses, jobStart), message: `job ${id}: ${message}` });
    const hub = uses.startsWith("docker://") ? dockerHubImage(uses.slice("docker://".length)) : undefined;
    if (hub) state.findings.push(dockerHubFinding(state, source, hub, uses, jobStart));
    if (
      uses.startsWith("docker/setup-buildx-action@") &&
      !String(step.with?.["driver-opts"] ?? "").includes(`image=${mirror}moby/buildkit:`)
    )
      finding(
        `docker/setup-buildx-action pulls moby/buildkit from Docker Hub; set driver-opts to image=${mirror}<its entry in ${listPath}>`,
      );
    // BuildKit's default SBOM generator is docker/buildkit-syft-scanner from Docker Hub.
    const sbom = String(step.with?.sbom ?? "false");
    const attests = String(step.with?.attests ?? "");
    if (
      uses.startsWith("docker/build-push-action@") &&
      (sbom !== "false" || attests.includes("type=sbom")) &&
      !`${sbom},${attests}`.includes(`generator=${mirror}`)
    )
      finding(`the SBOM attestation pulls its generator from Docker Hub; set sbom to generator=${mirror}<its entry in ${listPath}>`);
  }
};

const checkWorkflow = (state: State, source: Source, root: string) => {
  checkMirrorReferences(state, source);
  const parsed = workflowSchema.safeParse(Bun.YAML.parse(source.text));
  if (!parsed.success) {
    state.findings.push({ file: source.file, message: `unexpected workflow shape:\n${z.prettifyError(parsed.error)}` });
    return;
  }
  for (const [id, job] of Object.entries(parsed.data.jobs)) checkJob(state, source, root, id, job);
};

/** One Docker Hub `name:tag@sha256:<digest>` per line, keyed by `name:tag`. */
const parseList = (file: string, text: string, findings: Finding[]): Map<string, Entry> => {
  const entries = new Map<string, Entry>();
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const image = line.split("@")[0] ?? "";
    if (dockerHubImage(line) !== image || !image.includes(":") || !line.includes("@sha256:"))
      findings.push({ file, line: index + 1, message: `expected a Docker Hub image as <name>:<tag>@sha256:<digest>, got ${line}` });
    else if (entries.has(image)) findings.push({ file, line: index + 1, message: `${image} is listed twice` });
    else entries.set(image, { reference: line, line: index + 1 });
  });
  return entries;
};

/** Tracked and new, not ignored files, relative to `root`. */
const repositoryFiles = (root: string): string[] => {
  const result = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
  return result.stdout.toString().split("\0").filter(Boolean);
};

/**
 * CI, the release workflows and the image builds never pull from Docker Hub,
 * whose anonymous pull limit failed CI runs. Each Docker Hub image is pinned in
 * .github/mirror-images.txt and comes from the public GHCR mirror: service
 * containers, `docker://` steps, BuildKit, the SBOM generator and Dockerfiles
 * name the mirror at exactly the listed digest, and a job that starts a Docker
 * Hub image by name (`docker run`, Compose) first pulls it through
 * .github/pull-images.sh. A TypeScript or shell script or a fixture may name the mirror
 * at the listed digest; a Docker Hub name in one is out of reach here, because
 * nothing here knows which job runs the file, so that job's pull-images.sh
 * call has to list it.
 */
export const rule: Rule = {
  name: "mirror-images",
  description: "workflows and Dockerfiles take Docker Hub images only from the GHCR mirror pinned in .github/mirror-images.txt",
  run: async ({ workspaceRoot }) => {
    const findings: Finding[] = [];
    const listFile = join(workspaceRoot, listPath);
    const state: State = { entries: parseList(listFile, readFileSync(listFile, "utf8"), findings), used: new Set(), findings };
    const read = (path: string): Source => ({ file: join(workspaceRoot, path), text: readFileSync(join(workspaceRoot, path), "utf8") });
    for (const path of repositoryFiles(workspaceRoot)) {
      if (/^Dockerfile/.test(basename(path))) checkDockerfile(state, read(path));
      else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(path)) checkWorkflow(state, read(path), workspaceRoot);
      // Scripts and fixtures may name the mirror directly; their digests must follow the list too.
      else if (/\.(tsx?|sh)$/.test(path) && !path.startsWith("scripts/checks/")) checkMirrorReferences(state, read(path));
    }
    for (const [image, entry] of state.entries)
      if (!state.used.has(image))
        findings.push({ file: listFile, line: entry.line, message: `no workflow or Dockerfile uses ${image}; remove it from the list` });
    return findings;
  },
};
