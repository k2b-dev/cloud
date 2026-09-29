import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { publicCloudOrigin } from "../packages/cloud/src/shared/app-url";

const LOCAL_ORIGINS = ["http://localhost:3000", "http://127.0.0.1:3000"];

/** Browser origins that may use direct Filegate leases: the local gateway and the configured `APP_URL`. */
export const devFilegateAllowedOrigins = (appUrl: string): string[] => [
  ...new Set([...LOCAL_ORIGINS, publicCloudOrigin(appUrl || "localhost:3000")]),
];

/** Filegate daemon configuration for the development stack. */
export const devFilegateConfig = (appUrl: string): string => `server:
  listen: "0.0.0.0:4000"
  public_url: "http://127.0.0.1:4000"
  allowed_origins: ${JSON.stringify(devFilegateAllowedOrigins(appUrl))}
auth:
  token_file: /etc/filegate/token
state_dir: /var/lib/filegate
uploads:
  max_file_size: 1GiB
roots:
  - name: cloud
    path: /data/cloud
    managed: true
    index: true
    versioning:
      enabled: true
  - name: freeipa
    path: /data/freeipa
    execution: true
    index: false
`;

/**
 * Prepare a persistent backend token without printing it or rotating it on
 * restart, and write the daemon configuration for the configured `APP_URL`.
 * Returns whether the configuration changed, because Filegate reads it only on start.
 */
export async function prepareDevFilegate(
  directory = new URL("../.local/filegate/", import.meta.url).pathname,
  appUrl = process.env.APP_URL ?? "",
): Promise<boolean> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = `${directory}/token`;
  try {
    await readFile(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map((n) => n.toString(16).padStart(2, "0")).join("");
    await writeFile(path, `${token}\n`, { mode: 0o600, flag: "wx" });
  }
  await chmod(path, 0o600);

  const configPath = `${directory}/conf.yaml`;
  const config = devFilegateConfig(appUrl);
  const current = await readFile(configPath, "utf8").catch(() => undefined);
  if (current === config) return false;
  await writeFile(configPath, config, { mode: 0o600 });
  return true;
}

if (import.meta.main) await prepareDevFilegate();
