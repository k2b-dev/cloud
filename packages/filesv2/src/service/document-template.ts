import { appAssetPath } from "@k2b/cloud/server";
import { FilesError } from "./errors";

/** The empty office document a new file starts from; a missing file is a packaging defect, not a storage fault. */
export async function documentTemplate(extension: string): Promise<Blob> {
  const file = Bun.file(appAssetPath("templates", `empty.${extension}`));
  if (!(await file.exists())) throw new FilesError("template_missing", 503);
  return file;
}
