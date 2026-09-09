import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { arch, homedir, platform, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CLI_RELEASE_REPOSITORY = "k2b-dev/cloud";
export const CLI_RELEASE_BASE = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases`;
export const CLI_RELEASE_API_BASE = `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}`;

const MAX_RELEASE_FILE_BYTES = 512 * 1024 * 1024;
const CLI_RELEASE_PAGE_SIZE = 100;
const FETCH_TIMEOUT_MS = 30_000;
const FETCH_ATTEMPTS = 3;
const CLOUD_CLI_SKILL_ASSET = "cloud-cli-skill.tar.gz";
const CLOUD_CLI_SKILL_NAME = "cloud-cli";
const cliReleaseTag = /^cli-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const COSIGN_CERTIFICATE_IDENTITY_REGEXP =
  "^https://github\\.com/k2b-dev/cloud/\\.github/workflows/cli\\.yml@refs/tags/cli-v[0-9]+\\.[0-9]+\\.[0-9]+$";

export type CliRelease = {
  tag: string;
  version: string;
};

type StableVersion = {
  major: number;
  minor: number;
  patch: number;
};

export type CliTarget = {
  os: "darwin" | "linux";
  arch: "arm64" | "x64";
  asset: string;
};

type GithubRelease = {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
};

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type ReleaseSource = {
  apiBase?: string;
  releaseBase?: string;
  fetchImpl?: FetchImplementation;
};

type UpdateOptions = ReleaseSource & {
  version?: string;
  executablePath?: string;
  standalone?: boolean;
  target?: CliTarget;
  verifyCosign?: boolean;
  installSkill?: boolean;
  skillsDir?: string;
  claudeSymlink?: boolean;
  claudeSkillsDir?: string;
  confirm?: (message: string) => Promise<boolean>;
};

export type CliUpdateResult = {
  release: CliRelease;
  target: CliTarget;
  cosign: "verified" | "unavailable" | "skipped";
  skill: "installed" | "skipped";
  claudeSymlink: "created" | "exists" | "blocked" | "skipped";
};

const normalizeBase = (value: string): string => value.replace(/\/+$/, "");

const releaseSource = (source: ReleaseSource) => ({
  apiBase: normalizeBase(source.apiBase ?? process.env.CLD_RELEASE_API_BASE ?? CLI_RELEASE_API_BASE),
  releaseBase: normalizeBase(source.releaseBase ?? process.env.CLD_RELEASE_BASE ?? CLI_RELEASE_BASE),
  fetchImpl: source.fetchImpl ?? fetch,
});

const toCliTag = (version: string): string => (version.startsWith("cli-v") ? version : `cli-v${version.replace(/^v/, "")}`);

const parseStableVersion = (value: string): StableVersion | null => {
  const match = value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

const compareStableVersions = (left: StableVersion, right: StableVersion): number =>
  left.major - right.major || left.minor - right.minor || left.patch - right.patch;

const retryDelay = (attempt: number): Promise<void> => Bun.sleep(250 * 2 ** attempt);

const fetchWithRetry = async (url: string, init: RequestInit, fetchImpl: FetchImplementation): Promise<Response> => {
  let lastError: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (response.ok || (response.status < 500 && response.status !== 429)) return response;
      lastError = new Error(`Request failed with ${response.status}.`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < FETCH_ATTEMPTS) await retryDelay(attempt);
  }
  throw new Error(`Cloud CLI release request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
};

export const resolveCliTarget = (os = platform(), cpu = arch()): CliTarget => {
  if (os !== "darwin" && os !== "linux") throw new Error(`Cloud CLI does not support ${os}. Use macOS or Linux.`);
  const normalizedArch = cpu === "x64" ? "x64" : cpu === "arm64" ? "arm64" : null;
  if (!normalizedArch) throw new Error(`Cloud CLI does not support ${cpu} CPUs.`);
  return { os, arch: normalizedArch, asset: `cld_${os}_${normalizedArch}` };
};

const parseRelease = (value: GithubRelease): CliRelease | null => {
  if (value.draft === true || value.prerelease === true || typeof value.tag_name !== "string" || !cliReleaseTag.test(value.tag_name))
    return null;
  return { tag: value.tag_name, version: value.tag_name.slice("cli-v".length) };
};

const releaseVersion = (release: CliRelease): StableVersion => {
  const version = parseStableVersion(release.version);
  if (!version) throw new Error(`Cloud CLI release ${release.tag} is not a stable version.`);
  return version;
};

export const resolveCliRelease = async (version: string | undefined, source: ReleaseSource = {}): Promise<CliRelease> => {
  const { apiBase, fetchImpl } = releaseSource(source);
  const requestedTag = version ? toCliTag(version) : undefined;
  const requestedVersion = version ? parseStableVersion(version.replace(/^cli-v/, "").replace(/^v/, "")) : null;
  if (version && !requestedVersion) throw new Error("Cloud CLI updates require a stable version such as 1.2.3.");

  const url = requestedTag ? `${apiBase}/releases/tags/${encodeURIComponent(requestedTag)}` : undefined;
  const response = url ? await fetchWithRetry(url, { headers: { Accept: "application/vnd.github+json" } }, fetchImpl) : undefined;

  if (requestedTag) {
    if (!response) throw new Error("Could not resolve the requested Cloud CLI release.");
    if (!response.ok) throw new Error(`Could not resolve Cloud CLI release (${response.status}).`);
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== "object") throw new Error(`Cloud CLI release ${requestedTag} is invalid.`);
    const release = parseRelease(payload as GithubRelease);
    if (!release || release.tag !== requestedTag) throw new Error(`Cloud CLI release ${requestedTag} was not found.`);
    return release;
  }

  let newest: CliRelease | null = null;
  for (let page = 1; ; page += 1) {
    const pageUrl = `${apiBase}/releases?per_page=${CLI_RELEASE_PAGE_SIZE}&page=${page}`;
    const pageResponse = await fetchWithRetry(pageUrl, { headers: { Accept: "application/vnd.github+json" } }, fetchImpl);
    if (!pageResponse.ok) throw new Error(`Could not resolve Cloud CLI release (${pageResponse.status}).`);
    const payload = (await pageResponse.json()) as unknown;
    if (!Array.isArray(payload)) throw new Error("Cloud CLI release response is invalid.");
    for (const entry of payload) {
      if (!entry || typeof entry !== "object") continue;
      const release = parseRelease(entry as GithubRelease);
      if (!release || (newest && compareStableVersions(releaseVersion(release), releaseVersion(newest)) <= 0)) continue;
      newest = release;
    }
    if (payload.length < CLI_RELEASE_PAGE_SIZE) break;
  }
  if (!newest) throw new Error("No stable Cloud CLI release is available.");
  return newest;
};

const fetchBytes = async (url: string, fetchImpl: FetchImplementation): Promise<Uint8Array> => {
  const response = await fetchWithRetry(url, {}, fetchImpl);
  if (!response.ok) throw new Error(`Could not download ${url} (${response.status}).`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RELEASE_FILE_BYTES) throw new Error("Cloud CLI release asset is too large.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RELEASE_FILE_BYTES) throw new Error("Cloud CLI release asset is too large.");
  return bytes;
};

const expectedChecksum = (manifest: string, asset: string): string => {
  for (const line of manifest.split(/\r?\n/)) {
    const match = line.match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match?.[2] === asset) return match[1]!.toLowerCase();
  }
  throw new Error(`${asset} is not listed in checksums.txt.`);
};

const verifyChecksum = (asset: Uint8Array, expected: string): void => {
  const actual = createHash("sha256").update(asset).digest("hex");
  if (actual !== expected) throw new Error("Cloud CLI checksum verification failed.");
};

const verifyCosign = async (
  directory: string,
  manifest: Uint8Array,
  signature: Uint8Array,
  certificate: Uint8Array,
): Promise<"verified" | "unavailable"> => {
  if (!Bun.which("cosign")) return "unavailable";
  const manifestPath = join(directory, "checksums.txt");
  const signaturePath = join(directory, "checksums.txt.sig");
  const certificatePath = join(directory, "checksums.txt.pem");
  await Promise.all([
    writeFile(manifestPath, manifest, { mode: 0o600 }),
    writeFile(signaturePath, signature, { mode: 0o600 }),
    writeFile(certificatePath, certificate, { mode: 0o600 }),
  ]);
  try {
    await execFileAsync("cosign", [
      "verify-blob",
      "--certificate",
      certificatePath,
      "--signature",
      signaturePath,
      "--certificate-identity-regexp",
      COSIGN_CERTIFICATE_IDENTITY_REGEXP,
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      manifestPath,
    ]);
  } catch {
    throw new Error("Cloud CLI Cosign verification failed.");
  }
  return "verified";
};

const stageBinary = async (directory: string, asset: string, bytes: Uint8Array): Promise<string> => {
  const staged = join(directory, `.${asset}.installing-${process.pid}`);
  await writeFile(staged, bytes, { mode: 0o755 });
  await chmod(staged, 0o755);
  return staged;
};

const replaceBinary = async (staged: string, destination: string): Promise<void> => {
  const backup = join(dirname(destination), `.${basename(destination)}.backup-${process.pid}`);
  const destinationExists = await stat(destination)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  let backupCreated = false;
  try {
    if (destinationExists) {
      await rename(destination, backup);
      backupCreated = true;
    }
    await rename(staged, destination);
  } catch (error) {
    await rm(staged, { force: true });
    if (backupCreated) {
      await rm(destination, { force: true });
      await rename(backup, destination).catch(() => undefined);
    }
    throw error;
  }
  if (backupCreated) await rm(backup, { force: true }).catch(() => undefined);
};

export const defaultCloudCliSkillsDir = (): string => join(homedir(), ".agents", "skills");
export const defaultClaudeSkillsDir = (): string => join(homedir(), ".claude", "skills");

const replaceDirectory = async (source: string, destination: string): Promise<void> => {
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const backup = join(dirname(destination), `.${basename(destination)}.backup-${process.pid}`);
  const destinationExists = await lstat(destination)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    });
  let backupCreated = false;
  try {
    if (destinationExists) {
      await rename(destination, backup);
      backupCreated = true;
    }
    await rename(source, destination);
  } catch (error) {
    await rm(destination, { recursive: true, force: true }).catch(() => undefined);
    if (backupCreated) await rename(backup, destination).catch(() => undefined);
    throw error;
  }
  if (backupCreated) await rm(backup, { recursive: true, force: true }).catch(() => undefined);
};

const installSkillArchive = async (directory: string, archive: Uint8Array, skillsDir: string): Promise<string> => {
  const archivePath = join(directory, CLOUD_CLI_SKILL_ASSET);
  const extractDir = join(directory, "skill");
  await mkdir(extractDir, { recursive: true, mode: 0o700 });
  await writeFile(archivePath, archive, { mode: 0o600 });
  await execFileAsync("tar", ["-xzf", archivePath, "-C", extractDir]);
  const extractedSkill = join(extractDir, CLOUD_CLI_SKILL_NAME);
  await stat(join(extractedSkill, "SKILL.md"));
  const destination = join(resolve(skillsDir), CLOUD_CLI_SKILL_NAME);
  await replaceDirectory(extractedSkill, destination);
  return destination;
};

const ensureClaudeSkillSymlink = async (
  skillPath: string,
  claudeSkillsDir = defaultClaudeSkillsDir(),
): Promise<"created" | "exists" | "blocked"> => {
  const claudeSkillPath = join(claudeSkillsDir, CLOUD_CLI_SKILL_NAME);
  await mkdir(claudeSkillsDir, { recursive: true, mode: 0o700 });
  const existing = await lstat(claudeSkillPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isSymbolicLink()) return "blocked";
    const currentTarget = await readlink(claudeSkillPath);
    return resolve(claudeSkillsDir, currentTarget) === resolve(skillPath) ? "exists" : "blocked";
  }
  await symlink(skillPath, claudeSkillPath, "dir");
  return "created";
};

export const updateCli = async (options: UpdateOptions = {}): Promise<CliUpdateResult> => {
  const executablePath = options.executablePath ?? process.execPath;
  const standalone =
    options.standalone ??
    ((typeof __CLD_STANDALONE__ === "boolean" && __CLD_STANDALONE__ === true) ||
      (Bun as typeof Bun & { isStandaloneExecutable?: boolean }).isStandaloneExecutable === true);
  if (!standalone) throw new Error("cld update is only available from an installed Cloud CLI binary.");

  const source = releaseSource(options);
  const currentVersion = typeof __CLD_VERSION__ === "string" ? __CLD_VERSION__ : "0.0.0-dev";
  const currentStableVersion = parseStableVersion(currentVersion);
  const target = options.target ?? resolveCliTarget();
  const installSkill = options.installSkill !== false;
  const requestedVersion = options.version ? parseStableVersion(options.version.replace(/^cli-v/, "").replace(/^v/, "")) : null;
  if (!installSkill && requestedVersion && currentStableVersion && compareStableVersions(requestedVersion, currentStableVersion) === 0) {
    return {
      release: { tag: `cli-v${currentVersion}`, version: currentVersion },
      target,
      cosign: "skipped",
      skill: "skipped",
      claudeSymlink: "skipped",
    };
  }

  const release = await resolveCliRelease(options.version, source);
  if (!installSkill && release.version === currentVersion)
    return { release, target, cosign: "skipped", skill: "skipped", claudeSymlink: "skipped" };
  if (!options.version && currentStableVersion && compareStableVersions(releaseVersion(release), currentStableVersion) < 0) {
    throw new Error(`Refusing to downgrade cld ${currentVersion} to ${release.version} without --version.`);
  }

  if (options.confirm && !(await options.confirm(`Update cld ${currentVersion} to ${release.version}?`))) {
    throw new Error("Update cancelled.");
  }

  const replaceInstalledBinary = release.version !== currentVersion;
  const directory = dirname(executablePath);
  const temporaryDirectory = await mkdtemp(join(replaceInstalledBinary ? directory : tmpdir(), ".cld-update-"));
  try {
    const downloadBase = `${source.releaseBase}/download/${release.tag}`;
    const manifest = await fetchBytes(`${downloadBase}/checksums.txt`, source.fetchImpl);
    const cosign =
      options.verifyCosign === false
        ? "skipped"
        : await verifyCosign(
            temporaryDirectory,
            manifest,
            await fetchBytes(`${downloadBase}/checksums.txt.sig`, source.fetchImpl),
            await fetchBytes(`${downloadBase}/checksums.txt.pem`, source.fetchImpl),
          );
    const binary = await fetchBytes(`${downloadBase}/${target.asset}`, source.fetchImpl);
    verifyChecksum(binary, expectedChecksum(new TextDecoder().decode(manifest), target.asset));
    if (replaceInstalledBinary) {
      const staged = await stageBinary(directory, target.asset, binary);
      await replaceBinary(staged, executablePath);
    }
    let installedSkillPath: string | null = null;
    if (installSkill) {
      const skillArchive = await fetchBytes(`${downloadBase}/${CLOUD_CLI_SKILL_ASSET}`, source.fetchImpl);
      verifyChecksum(skillArchive, expectedChecksum(new TextDecoder().decode(manifest), CLOUD_CLI_SKILL_ASSET));
      installedSkillPath = await installSkillArchive(temporaryDirectory, skillArchive, options.skillsDir ?? defaultCloudCliSkillsDir());
    }
    return {
      release,
      target,
      cosign,
      skill: installSkill ? "installed" : "skipped",
      claudeSymlink:
        options.claudeSymlink && installedSkillPath
          ? await ensureClaudeSkillSymlink(installedSkillPath, options.claudeSkillsDir)
          : "skipped",
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
};

declare const __CLD_VERSION__: string;
declare const __CLD_STANDALONE__: boolean;
