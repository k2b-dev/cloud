import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type LocalPathAccess =
  | { access: "free" }
  | { access: "ask"; reason: "outside" | "protected" | "home" }
  | { access: "blocked"; reason: "cld-config" };

/** Expand a home-relative path and resolve it against the workspace. */
export const resolveLocalPath = (path: string, workspace: string, home = homedir()): string =>
  resolve(workspace, path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);

const realPath = (path: string): string => {
  try {
    return realpathSync(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(realPath(parent), basename(path));
  }
};

const contains = (directory: string, path: string): boolean => {
  const child = relative(directory, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !child.startsWith(sep));
};

const protectedPath = (path: string): boolean =>
  /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12)|id_rsa.*|id_ed25519.*|\.npmrc|\.netrc|\.git-credentials)$/.test(basename(path)) ||
  path.split(sep).some((segment) => [".ssh", ".gnupg", ".aws", ".git"].includes(segment));

/** Classify local access by the real target, including symlinks and future files. */
export const classifyLocalPath = (path: string, options: { workspace: string; home?: string }): LocalPathAccess => {
  const home = realPath(resolve(options.home ?? homedir()));
  const workspace = realPath(resolve(options.workspace));
  const target = realPath(resolveLocalPath(path, options.workspace, home));
  // Keep these locations aligned with packages/cloud-cli/src/config.ts.
  const configDirectory = realPath(resolve(process.env.XDG_CONFIG_HOME || join(home, ".config"), "cloud", "cld"));
  const configFile = process.env.CLD_CONFIG ? realPath(resolveLocalPath(process.env.CLD_CONFIG, process.cwd(), home)) : undefined;
  if (contains(configDirectory, target) || target === configFile) return { access: "blocked", reason: "cld-config" };
  if (contains(workspace, home)) return { access: "ask", reason: "home" };
  if (protectedPath(target)) return { access: "ask", reason: "protected" };
  if (!contains(workspace, target)) return { access: "ask", reason: "outside" };
  return { access: "free" };
};

/** Complete a local token, preserving an optional @ prefix and the user's path spelling. */
export const completeLocalPath = (token: string, cwd: string): string[] => {
  const marker = token.startsWith("@") ? "@" : "";
  const path = token.slice(marker.length);
  const slash = path.lastIndexOf("/");
  const prefix = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  try {
    const directory = resolveLocalPath(prefix || ".", cwd);
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(name) && (!entry.name.startsWith(".") || name.startsWith(".")))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 200)
      .map((entry) => {
        let directoryEntry = entry.isDirectory();
        if (entry.isSymbolicLink()) {
          try {
            directoryEntry = statSync(join(directory, entry.name)).isDirectory();
          } catch {
            // A dangling or unreadable symlink still completes by name.
          }
        }
        return `${marker}${prefix}${entry.name}${directoryEntry ? "/" : ""}`;
      });
  } catch {
    return [];
  }
};

/** Extract existing @file targets once each; other mentions remain ordinary text. */
export const extractMessageAttachments = (message: string, workspace: string): string[] => {
  const files = new Set<string>();
  for (const token of message.split(/\s+/)) {
    if (!token.startsWith("@") || token.length === 1) continue;
    const path = token.slice(1);
    for (const candidate of [path, path.replace(/[,.;:!?)]+$/, "")]) {
      try {
        const target = resolveLocalPath(candidate, workspace);
        if (statSync(target).isFile()) files.add(realpathSync(target));
        break;
      } catch {
        // Retry punctuation only when the literal path does not exist.
      }
    }
  }
  return [...files];
};
