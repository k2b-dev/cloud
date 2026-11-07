import { constants, type Stats } from "node:fs";
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { AI_FILES_MAX_FILE_BYTES_DEFAULT } from "@k2b/cloud/ai/browser";
import { getLocalConfigPaths } from "./local-paths";

/** The real target of a path and the file it named when it was checked, before any question. */
export type LocalFileReview = {
  target: string;
  identity: { dev: number; ino: number; directory: boolean } | null;
  /** The file was one of cld's login files when it was checked, even if that file moves later. */
  config: boolean;
};

const missing = (error: unknown) => error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");

const realTarget = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch (error) {
    if (!missing(error) || dirname(path) === path) throw error;
    return join(await realTarget(dirname(path)), basename(path));
  }
};

/** cld's login files by identity, so a hard link or a moved folder cannot read them under another name. */
const isLocalConfigFile = async (info: Stats): Promise<boolean> => {
  const { configDirectory, configFile } = getLocalConfigPaths();
  // The login lives in the top-level files; plugins below are code.
  const files = [
    ...(configFile ? [configFile] : []),
    ...(await readdir(configDirectory).catch(() => [])).map((entry) => join(configDirectory, entry)),
  ];
  for (const file of files) {
    // Follow a linked login file: its target holds the login.
    const current = await stat(file).catch(() => null);
    if (current?.isFile() && current.dev === info.dev && current.ino === info.ino) return true;
  }
  return false;
};

export const reviewLocalFile = async (path: string): Promise<LocalFileReview> => {
  const target = await realTarget(path);
  const info = await stat(target).catch((error) => {
    if (missing(error)) return null;
    throw error;
  });
  return {
    target,
    identity: info && { dev: info.dev, ino: info.ino, directory: info.isDirectory() },
    config: info !== null && (await isLocalConfigFile(info)),
  };
};

/**
 * Open the file that was checked and approved. Read only through the returned handle: if the path now names another
 * file, including through a parent folder, a link, or a hard link, this fails instead.
 */
export const openReviewedFile = async (path: string, review: LocalFileReview): Promise<{ file: FileHandle; info: Stats }> => {
  const changed = () => new Error(`${path} changed after it was checked. Try again.`);
  if (!review.identity) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: "ENOENT" });
  let file: FileHandle;
  try {
    // Do not follow a replaced leaf link or wait on a substituted FIFO.
    file = await open(review.target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ELOOP" || missing(error))) throw changed();
    throw error;
  }
  try {
    const info = await file.stat();
    if (info.dev !== review.identity.dev || info.ino !== review.identity.ino) throw changed();
    if (review.config || (await isLocalConfigFile(info))) throw new Error("cld's configuration is never available to the assistant.");
    return { file, info };
  } catch (error) {
    await file.close();
    throw error;
  }
};

/**
 * A chat upload with the bytes of the opened file. Cloud refuses larger files, so a larger one is refused before it is
 * read; memory stays bounded by that limit, whatever the file size.
 */
export const reviewedUpload = async (file: FileHandle, name: string, type: string, signal?: AbortSignal): Promise<File> => {
  const { size } = await file.stat();
  if (size > AI_FILES_MAX_FILE_BYTES_DEFAULT)
    throw new Error(`${name} exceeds the ${AI_FILES_MAX_FILE_BYTES_DEFAULT / (1024 * 1024)} MB limit for chat files.`);
  // Read the checked size; bytes appended later are not part of this upload.
  const bytes = new Uint8Array(size);
  let length = 0;
  while (length < size) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(bytes, length, size - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  return new File([bytes.subarray(0, length)], name, { type });
};
