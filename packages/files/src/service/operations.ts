import { Filegate } from "@valentinkolb/filegate/client";
import { get } from "@k2b/cloud/services";
import type {
  FileBase,
  FileInfo,
  FileInfoResponse,
  MutationResult,
  SearchResult,
  ChunkedUploadSession,
  ChunkedUploadResponse,
  MoveTargetResult,
  TransferResult,
} from "@/contracts";
import * as paths from "./paths";
import * as permissions from "./permissions";

const getFilegate = async (): Promise<Filegate> => {
  const [url, token] = await Promise.all([get<string>("files.filegate_url"), get<string>("files.filegate_token")]);
  return new Filegate({ url, token });
};

/**
 * Ownership info for file operations.
 * - For files: mode is the file permission (e.g., "600" or "660")
 * - For directories: mode is the directory permission (e.g., "700" or "2770")
 * - dirMode is used for auto-created parent directories during upload
 */
type OwnershipInfo = {
  uid: number;
  gid: number;
  mode: string;
  dirMode: string;
};

/**
 * Get ownership info for file proxy requests.
 * Returns numeric UIDs/GIDs and the exact modes to set.
 *
 * Matches nfsctl.bash permission structure:
 * - Home: owner=user:user, dirs=700, files=600
 * - Group: owner=root:group, dirs=2770 (SGID), files=660
 */
const getOwnershipInfo = async (base: FileBase, isDirectory: boolean): Promise<OwnershipInfo | null> => {
  if (base.type === "home") {
    // Home: user owns files, need both uidNumber and gidNumber
    // nfsctl: chown user:user, chmod 700 (dirs), chmod 600 (files)
    if (base.uidNumber === undefined || base.gidNumber === undefined) {
      return null;
    }
    const [dirMode, fileMode] = await Promise.all([get<string>("files.home_dir_mode"), get<string>("files.home_file_mode")]);
    return {
      uid: base.uidNumber,
      gid: base.gidNumber,
      mode: isDirectory ? dirMode : fileMode,
      dirMode,
    };
  } else {
    // Group: root owns files (uid=0), group has access
    // nfsctl: chown root:group, chmod 2770 (dirs with SGID), chmod 660 (files)
    if (base.gidNumber === undefined) {
      return null;
    }
    const [dirMode, fileMode] = await Promise.all([get<string>("files.group_dir_mode"), get<string>("files.group_file_mode")]);
    return {
      uid: 0,
      gid: base.gidNumber,
      mode: isDirectory ? dirMode : fileMode,
      dirMode,
    };
  }
};

/**
 * Get file or directory info.
 * - For files: returns file metadata
 * - For directories: returns directory listing with items
 */
export const info = async (params: {
  base: FileBase;
  path: string;
  showHidden?: boolean;
  computeSizes?: boolean;
}): Promise<MutationResult<FileInfoResponse>> => {
  const resolved = await paths.resolvePath(params.base, params.path);
  if (!resolved.ok) return resolved;

  const result = await (await getFilegate()).info({
    path: resolved.data.fullPath,
    showHidden: params.showHidden,
    computeSizes: params.computeSizes,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 404 | 500,
    };
  }

  // Update path to be relative
  return {
    ok: true,
    data: {
      ...result.data,
      path: resolved.data.relativePath,
    } as FileInfoResponse,
  };
};

/**
 * Download file content
 * @param inline - If true, returns Content-Disposition: inline for browser preview
 */
export const download = async (params: {
  base: FileBase;
  path: string;
  inline?: boolean;
}): Promise<
  MutationResult<{
    stream: ReadableStream;
    filename: string;
    size: number;
    contentType: string;
    inline: boolean;
  }>
> => {
  const resolved = await paths.resolvePath(params.base, params.path);
  if (!resolved.ok) return resolved;

  const result = await (await getFilegate()).download({
    path: resolved.data.fullPath,
    inline: params.inline,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 404 | 500,
    };
  }

  const response = result.data;
  if (!response.body) {
    return { ok: false, error: "Empty response body", status: 500 };
  }

  return {
    ok: true,
    data: {
      stream: response.body,
      filename: response.headers.get("X-File-Name") ?? "download",
      size: parseInt(response.headers.get("Content-Length") ?? "0"),
      contentType: response.headers.get("Content-Type") ?? "application/octet-stream",
      inline: params.inline ?? false,
    },
  };
};

/**
 * Generate thumbnail for an image file.
 * Returns the Response from filegate directly (includes cache headers, etag, etc.).
 * Uses sensible defaults: 200x200 max size, preserves aspect ratio.
 */
export const thumbnail = async (params: { base: FileBase; path: string }): Promise<MutationResult<{ response: Response }>> => {
  const resolved = await paths.resolvePath(params.base, params.path);
  if (!resolved.ok) return resolved;

  const result = await (await getFilegate()).thumbnail.image({
    path: resolved.data.fullPath,
    width: 200,
    height: 200,
    fit: "inside",
    format: "webp",
    quality: 80,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 404 | 500,
    };
  }

  return {
    ok: true,
    data: {
      response: result.data,
    },
  };
};

/**
 * Upload a file with proper ownership/permissions
 */
export const upload = async (params: {
  base: FileBase;
  path: string;
  content: ArrayBuffer;
  filename: string;
}): Promise<MutationResult<FileInfo>> => {
  const resolved = await paths.resolvePath(params.base, params.path);
  if (!resolved.ok) return resolved;

  const ownership = await getOwnershipInfo(params.base, false); // false = file

  const result = await (await getFilegate()).upload.single({
    path: resolved.data.fullPath,
    filename: params.filename,
    data: params.content,
    ...(ownership && {
      uid: ownership.uid,
      gid: ownership.gid,
      mode: ownership.mode,
      dirMode: ownership.dirMode,
    }),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 500,
    };
  }

  return { ok: true, data: result.data };
};

/**
 * Create a directory with proper ownership/permissions
 */
export const mkdir = async (params: { base: FileBase; path: string }): Promise<MutationResult<FileInfo>> => {
  const resolved = await paths.resolvePath(params.base, params.path);
  if (!resolved.ok) return resolved;

  const ownership = await getOwnershipInfo(params.base, true); // true = directory

  const result = await (await getFilegate()).mkdir({
    path: resolved.data.fullPath,
    ...(ownership && {
      uid: ownership.uid,
      gid: ownership.gid,
      mode: ownership.mode,
    }),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 500,
    };
  }

  return { ok: true, data: result.data };
};

/**
 * Move a file or directory within the same base.
 * Uses filegate.transfer with mode="move".
 */
export const move = async (params: { base: FileBase; from: string; to: string }): Promise<MutationResult<FileInfo>> => {
  const fromResolved = await paths.resolvePath(params.base, params.from);
  if (!fromResolved.ok) return fromResolved;

  const toResolved = await paths.resolvePath(params.base, params.to);
  if (!toResolved.ok) return toResolved;

  const result = await (await getFilegate()).transfer({
    from: fromResolved.data.fullPath,
    to: toResolved.data.fullPath,
    mode: "move",
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 404 | 500,
    };
  }

  return { ok: true, data: result.data };
};

/**
 * Copy a file or directory within the same base.
 * Uses filegate.transfer with mode="copy".
 */
export const copy = async (params: { base: FileBase; from: string; to: string }): Promise<MutationResult<FileInfo>> => {
  const fromResolved = await paths.resolvePath(params.base, params.from);
  if (!fromResolved.ok) return fromResolved;

  const toResolved = await paths.resolvePath(params.base, params.to);
  if (!toResolved.ok) return toResolved;

  const result = await (await getFilegate()).transfer({
    from: fromResolved.data.fullPath,
    to: toResolved.data.fullPath,
    mode: "copy",
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 500,
    };
  }

  return { ok: true, data: result.data };
};

/**
 * Soft-delete a file or directory by moving it to /Trash/.
 * Filegate's ensureUniqueName handles name conflicts automatically (-01, -02, ...).
 */
export const remove = async (params: { base: FileBase; path: string }): Promise<MutationResult<void>> => {
  const resolved = await paths.resolvePath(params.base, params.path);
  if (!resolved.ok) return resolved;

  // Prevent deleting the Trash folder itself or its contents
  if (resolved.data.relativePath === "Trash" || resolved.data.relativePath.startsWith("Trash/")) {
    return { ok: false, error: "Cannot delete items from trash", status: 400 };
  }

  // Ensure Trash directory exists
  const trashPath = await paths.resolvePath(params.base, "/Trash");
  if (!trashPath.ok) return trashPath;
  await (await getFilegate()).mkdir({ path: trashPath.data.fullPath });

  // Build target path: /Trash/<filename>
  const filename = resolved.data.relativePath.split("/").pop() || "unnamed";
  const targetTrashPath = await paths.resolvePath(params.base, `/Trash/${filename}`);
  if (!targetTrashPath.ok) return targetTrashPath;

  // Move to trash with auto-rename on conflict
  const result = await (await getFilegate()).transfer({
    from: resolved.data.fullPath,
    to: targetTrashPath.data.fullPath,
    mode: "move",
    ensureUniqueName: true,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 404 | 500,
    };
  }

  return { ok: true, data: undefined };
};

/**
 * Duplicate a file or directory in the same directory with a new name.
 * Uses filegate.transfer with mode="copy".
 */
export const duplicate = async (params: { base: FileBase; path: string; newName: string }): Promise<MutationResult<FileInfo>> => {
  const resolved = await paths.resolvePath(params.base, params.path);
  if (!resolved.ok) return resolved;

  // Get parent directory path
  const parentPath = params.path.substring(0, params.path.lastIndexOf("/")) || "/";
  const targetPath = parentPath === "/" ? `/${params.newName}` : `${parentPath}/${params.newName}`;

  const targetResolved = await paths.resolvePath(params.base, targetPath);
  if (!targetResolved.ok) return targetResolved;

  const result = await (await getFilegate()).transfer({
    from: resolved.data.fullPath,
    to: targetResolved.data.fullPath,
    mode: "copy",
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 500,
    };
  }

  return { ok: true, data: result.data };
};

/**
 * Search for files across multiple bases.
 * Runs searches in parallel for performance.
 */
export const searchAll = async (params: {
  bases: FileBase[];
  pattern: string;
  showHidden?: boolean;
  limit?: number;
}): Promise<MutationResult<{ results: SearchResult[]; totalFiles: number }>> => {
  const { bases, pattern, showHidden = false, limit = 100 } = params;

  // Resolve all base paths
  const basePaths: { base: FileBase; fullPath: string }[] = [];
  for (const base of bases) {
    const resolved = await paths.resolvePath(base, "/");
    if (resolved.ok) {
      basePaths.push({ base, fullPath: resolved.data.fullPath });
    }
  }

  if (basePaths.length === 0) {
    return { ok: true, data: { results: [], totalFiles: 0 } };
  }

  // Use filegate.glob to search all paths at once
  const result = await (await getFilegate()).glob({
    paths: basePaths.map((b) => b.fullPath),
    pattern,
    showHidden,
    limit,
  });

  if (!result.ok) {
    return { ok: false, error: result.error, status: 500 };
  }

  // Map results back to bases
  const results: SearchResult[] = [];
  for (const searchResult of result.data.results) {
    // Find which base this result belongs to
    const baseMatch = basePaths.find((b) => searchResult.basePath.startsWith(b.fullPath));
    if (!baseMatch) continue;

    const baseInfo = permissions.toBaseInfo(baseMatch.base);
    results.push({
      base: baseInfo,
      files: searchResult.files,
      total: searchResult.total,
      hasMore: searchResult.hasMore,
    });
  }

  const totalFiles = results.reduce((sum, r) => sum + r.total, 0);

  return { ok: true, data: { results, totalFiles } };
};

// =============================================================================
// Chunked Upload Operations
// =============================================================================

/**
 * Start a chunked upload session.
 * Returns an uploadId that must be used for subsequent chunk uploads.
 */
export const chunkedUploadStart = async (params: {
  base: FileBase;
  path: string;
  filename: string;
  size: number;
  checksum: string;
  chunkSize: number;
}): Promise<MutationResult<ChunkedUploadSession>> => {
  const resolved = await paths.resolvePath(params.base, params.path);
  if (!resolved.ok) return resolved;

  const ownership = await getOwnershipInfo(params.base, false); // false = file

  const result = await (await getFilegate()).upload.chunked.start({
    path: resolved.data.fullPath,
    filename: params.filename,
    size: params.size,
    checksum: params.checksum,
    chunkSize: params.chunkSize,
    ...(ownership && {
      uid: ownership.uid,
      gid: ownership.gid,
      mode: ownership.mode,
      dirMode: ownership.dirMode,
    }),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 500,
    };
  }

  return { ok: true, data: result.data };
};

/**
 * Upload a single chunk of a chunked upload.
 * Returns progress info or completion info with file metadata.
 */
export const chunkedUploadChunk = async (params: {
  uploadId: string;
  index: number;
  data: Blob | ArrayBuffer | Uint8Array;
  checksum?: string;
}): Promise<MutationResult<ChunkedUploadResponse>> => {
  const result = await (await getFilegate()).upload.chunked.send({
    uploadId: params.uploadId,
    index: params.index,
    data: params.data,
    ...(params.checksum && { checksum: params.checksum }),
  });

  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      status: result.status as 400 | 404 | 500,
    };
  }

  return { ok: true, data: result.data };
};

// =============================================================================
// Move/Copy Operations
// =============================================================================

/**
 * Search for directories within a base for move/copy target selection.
 * Uses filegate.glob with directories-only filter.
 */
export const searchDirectories = async (params: {
  base: FileBase;
  query: string;
  limit?: number;
}): Promise<MutationResult<{ directories: MoveTargetResult[]; total: number }>> => {
  const { base, query, limit = 20 } = params;

  const resolved = await paths.resolvePath(base, "/");
  if (!resolved.ok) return resolved;

  // Build glob pattern: match directory names containing the query
  // For empty query, list all directories
  const trimmedQuery = query.trim().toLowerCase();
  const pattern = trimmedQuery ? `**/*` : `**/*`;

  const result = await (await getFilegate()).glob({
    paths: [resolved.data.fullPath],
    pattern,
    directories: true,
    files: false,
    showHidden: false,
    limit: 100, // Fetch more, then filter by query client-side
  });

  if (!result.ok) {
    return { ok: false, error: result.error, status: 500 };
  }

  // Extract directories from results and filter by query
  const directories: MoveTargetResult[] = [];

  for (const searchResult of result.data.results) {
    for (const file of searchResult.files) {
      // Convert absolute path to relative path within base
      const relativePath = file.path.replace(resolved.data.fullPath, "") || "/";

      // Filter by query if provided
      if (trimmedQuery && !file.name.toLowerCase().includes(trimmedQuery)) {
        continue;
      }

      directories.push({
        path: relativePath,
        name: file.name,
      });
    }
  }

  // Always include root directory as first option
  // Name is empty - frontend will use base name for display
  const rootMatches = !trimmedQuery || "root".includes(trimmedQuery);
  if (rootMatches) {
    directories.unshift({ path: "/", name: "" });
  }

  return {
    ok: true,
    data: {
      directories: directories.slice(0, limit),
      total: directories.length,
    },
  };
};

/**
 * Transfer (move or copy) files between bases.
 * Uses filegate.transfer() with mode="move" or mode="copy".
 * - Same base: mode="move" (fast rename, preserves permissions)
 * - Different base: mode="copy" with ownership params (required for cross-base)
 */
export const transfer = async (params: {
  sourceBase: FileBase;
  targetBase: FileBase;
  sourcePaths: string[];
  targetPath: string;
}): Promise<MutationResult<TransferResult>> => {
  const { sourceBase, targetBase, sourcePaths, targetPath } = params;

  // Determine if this is same-base (move) or cross-base (copy)
  const isSameBase =
    sourceBase.type === targetBase.type &&
    (sourceBase.type === "home"
      ? sourceBase.uid === (targetBase as typeof sourceBase).uid
      : sourceBase.name === (targetBase as { type: "group"; name: string }).name);

  const errors: { path: string; error: string }[] = [];
  let transferred = 0;

  // Get ownership info for target base (needed for cross-base copy)
  const targetOwnership = await getOwnershipInfo(targetBase, false);

  for (const sourcePath of sourcePaths) {
    // Resolve source path
    const sourceResolved = await paths.resolvePath(sourceBase, sourcePath);
    if (!sourceResolved.ok) {
      errors.push({ path: sourcePath, error: sourceResolved.error });
      continue;
    }

    // Build target path: targetPath + source filename
    const filename = sourcePath.split("/").pop() || "";
    const fullTargetPath = targetPath === "/" ? `/${filename}` : `${targetPath}/${filename}`;

    const targetResolved = await paths.resolvePath(targetBase, fullTargetPath);
    if (!targetResolved.ok) {
      errors.push({ path: sourcePath, error: targetResolved.error });
      continue;
    }

    if (isSameBase) {
      // Same base: use move (fast rename, preserves permissions)
      const result = await (await getFilegate()).transfer({
        from: sourceResolved.data.fullPath,
        to: targetResolved.data.fullPath,
        mode: "move",
      });

      if (!result.ok) {
        errors.push({ path: sourcePath, error: result.error });
      } else {
        transferred++;
      }
    } else {
      // Different base: use copy with ownership (required for cross-base transfers)
      if (!targetOwnership) {
        errors.push({
          path: sourcePath,
          error: "Target base missing ownership info",
        });
        continue;
      }

      const result = await (await getFilegate()).transfer({
        from: sourceResolved.data.fullPath,
        to: targetResolved.data.fullPath,
        mode: "copy",
        uid: targetOwnership.uid,
        gid: targetOwnership.gid,
        fileMode: targetOwnership.mode,
        dirMode: targetOwnership.dirMode,
      });

      if (!result.ok) {
        errors.push({ path: sourcePath, error: result.error });
      } else {
        transferred++;
      }
    }
  }

  return {
    ok: true,
    data: {
      moved: isSameBase,
      transferred,
      errors,
    },
  };
};
