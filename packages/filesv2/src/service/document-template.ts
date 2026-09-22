import { appAssetPath } from "@k2b/cloud/server";
import { FilesError } from "./errors";

/** The empty office document a new file starts from; any failure to locate it is a packaging defect, not a storage fault. */
export async function documentTemplate(extension: string): Promise<Blob> {
  let path: string;
  try {
    path = appAssetPath("templates", `empty.${extension}`);
  } catch (error) {
    throw new FilesError("template_missing", 503, { cause: error });
  }
  const file = Bun.file(path);
  if (!(await file.exists())) throw new FilesError("template_missing", 503, { cause: new Error(`No template at ${path}`) });
  return file;
}
