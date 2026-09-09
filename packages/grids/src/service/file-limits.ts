import * as settings from "@k2b/cloud/services/settings";

export const DEFAULT_MAX_FILE_SIZE_MB = 10;

export const getMaxFileSizeBytes = async (): Promise<number> => {
  const mb = await settings.get<number>("grids.max_file_size_mb");
  const resolved = typeof mb === "number" && Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_FILE_SIZE_MB;
  return resolved * 1024 * 1024;
};
