import { CloudError } from "./errors";
export function createDownload(rpc: (method: string, args: unknown[]) => Promise<unknown>) {
  return async (name: string, data: unknown): Promise<void> => {
    if (typeof data !== "string" && !(data instanceof Blob))
      throw new CloudError(
        "invalid",
        data instanceof Promise
          ? "cloud.download got a Promise; await cloud.sheet.toCsv(...) first."
          : "cloud.download expects a Blob or string; convert the data first.",
      );
    await rpc("file.save", [data, name]);
  };
}
