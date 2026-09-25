/**
 * Environment configuration for `cld`.
 *
 * This is the only module in the CLI that reads `process.env`. Every key is
 * optional; explicit flags always win over the environment.
 *
 *   CLD_CONFIG            Path of the profile config file. Default:
 *                         `$XDG_CONFIG_HOME/cloud/cld/config.json`, falling back
 *                         to `~/.config/cloud/cld/config.json`.
 *   CLD_SERVER            Cloud server URL used when no `--server` flag is given.
 *   CLD_TOKEN             Bearer token used when no `--token` flag is given.
 *   CLD_LOCALE            Output locale used when no `--locale` flag is given.
 *   CLD_RELEASE_BASE      Base URL for release assets (`cld update`).
 *   CLD_RELEASE_API_BASE  Base URL of the release metadata API (`cld update`).
 *   SSH_CONNECTION / SSH_TTY
 *                         Read only: mark an SSH session, where `cld login` suggests `--device`.
 *   DISPLAY / WAYLAND_DISPLAY
 *                         Read only: a Linux session without either cannot open a browser.
 *   GH_TOKEN / GITHUB_TOKEN
 *                         Optional GitHub token for release metadata requests (lifts the anonymous API rate limit); never sent to asset downloads.
 *   CLD_OUTPUT_DIR        Build only: output directory for the standalone binaries.
 *   CLD_VERSION           Build only: version embedded into the binaries.
 *   CLD_COMMIT            Build only: commit embedded into the binaries.
 *   CLD_TARGETS           Build only: comma-separated list of build targets.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const read = (key: string): string | undefined => {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
};

/** Directory that holds user configuration (`$XDG_CONFIG_HOME` or `~/.config`). */
export const userConfigDirectory = (): string => read("XDG_CONFIG_HOME") ?? join(homedir(), ".config");

/** Absolute path of the `cld` profile config file. */
export const configPath = (): string => read("CLD_CONFIG") ?? join(userConfigDirectory(), "cloud", "cld", "config.json");

export const envServer = (): string | undefined => read("CLD_SERVER");
export const envToken = (): string | undefined => read("CLD_TOKEN");
export const envLocale = (): string | undefined => read("CLD_LOCALE");
export const envReleaseBase = (): string | undefined => read("CLD_RELEASE_BASE");
export const envReleaseApiBase = (): string | undefined => read("CLD_RELEASE_API_BASE");
/** Whether this terminal probably cannot open a local browser: an SSH session, or Linux without a display. */
export const envLacksLocalBrowser = (): boolean =>
  Boolean(read("SSH_CONNECTION") ?? read("SSH_TTY")) || (process.platform === "linux" && !read("DISPLAY") && !read("WAYLAND_DISPLAY"));
export const envGithubToken = (): string | undefined => read("GH_TOKEN")?.trim() || read("GITHUB_TOKEN")?.trim() || undefined;

/** Build-time knobs read by `scripts/build.ts`. */
export const buildEnv = () => ({
  outputDir: read("CLD_OUTPUT_DIR"),
  version: read("CLD_VERSION"),
  commit: read("CLD_COMMIT"),
  targets: read("CLD_TARGETS"),
});
