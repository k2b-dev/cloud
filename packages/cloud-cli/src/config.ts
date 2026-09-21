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

/** Build-time knobs read by `scripts/build.ts`. */
export const buildEnv = () => ({
  outputDir: read("CLD_OUTPUT_DIR"),
  version: read("CLD_VERSION"),
  commit: read("CLD_COMMIT"),
  targets: read("CLD_TARGETS"),
});
