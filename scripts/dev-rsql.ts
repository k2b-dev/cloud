import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
/** One persistent local token, shared only by the Kit and rsql containers. */
export async function prepareDevRsql(directory = new URL("../.local/rsql/", import.meta.url).pathname) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = `${directory}/credentials.env`;
  try {
    await readFile(path);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map((n) => n.toString(16).padStart(2, "0")).join("");
    await writeFile(path, `RSQL_API_TOKEN=${token}\nKIT_RSQL_API_TOKEN=${token}\nKIT_RSQL_URL=http://rsql:8080\n`, {
      mode: 0o600,
      flag: "wx",
    });
  }
  await chmod(path, 0o600);
}
if (import.meta.main) await prepareDevRsql();
