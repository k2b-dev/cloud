import { chmod, mkdir, writeFile } from "node:fs/promises";

const secret = () => [...crypto.getRandomValues(new Uint8Array(32))].map((n) => n.toString(16).padStart(2, "0")).join("");
const createOnce = async (path: string, value: string) => {
  try {
    await writeFile(path, value, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  await chmod(path, 0o600);
};
/** Persistent local credentials. Never overwrite or print their values. */
export const prepareDevClickhouse = async (directory = new URL("../.local/clickhouse/", import.meta.url).pathname) => {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await createOnce(
    `${directory}/credentials.env`,
    `CLICKHOUSE_USER=pulse_admin\nCLICKHOUSE_PASSWORD=${secret()}\nCLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1\n`,
  );
  await createOnce(`${directory}/pulse_service.password`, `${secret()}\n`);
};
if (import.meta.main) {
  if (process.argv.includes("--help"))
    console.log("Usage: bun scripts/dev-clickhouse.ts\nCreate local ClickHouse admin and service credentials once, without printing them.");
  else if (process.argv.length > 2) throw new Error("Unknown argument. Use --help.");
  else await prepareDevClickhouse();
}
