import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";

/** Prepare a persistent backend token without printing it or rotating it on restart. */
export async function prepareDevFilegate(directory = new URL("../.local/filegate/", import.meta.url).pathname) {
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
}

if (import.meta.main) await prepareDevFilegate();
