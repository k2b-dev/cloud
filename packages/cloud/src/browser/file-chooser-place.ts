import { FILE_CHOOSER_PLACE_MAX_FOLDERS, type FileChooserPlace, FileChooserPlaceBodySchema } from "../contracts/file-chooser-place";
import type { FileProviderCaller } from "./file-providers";
import type { Crumb } from "./provider-folder";

export type FileChooserPlaceState = { state: "loading" } | { state: "ready"; place: FileChooserPlace | null };

const placeUrl = (caller: FileProviderCaller) => `${(caller.baseUrl ?? "/api").replace(/\/$/, "")}/me/file-chooser/place`;

/**
 * The person's last place in the chooser. Anything but a readable answer, such as a visitor's 401 or an outage, opens
 * This device: the place is a convenience, and the chooser works without it.
 */
export const readFileChooserPlace = async (caller: FileProviderCaller, signal: AbortSignal): Promise<FileChooserPlace | null> => {
  try {
    const response = await (caller.fetch ?? fetch)(placeUrl(caller), { signal, headers: { accept: "application/json" } });
    if (!response.ok) return null;
    const parsed = FileChooserPlaceBodySchema.safeParse(await response.json());
    return parsed.success ? parsed.data.place : null;
  } catch {
    return null;
  }
};

/** Remembers the place as the dialog closes; `keepalive` lets the request finish when the page navigates away. */
export const rememberFileChooserPlace = (caller: FileProviderCaller, place: FileChooserPlace | null): void => {
  void (caller.fetch ?? fetch)(placeUrl(caller), {
    method: "PUT",
    keepalive: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ place }),
  }).catch(() => undefined);
};

/** The place of an open folder: the provider and the folders below its root, the deepest ones when the path is long. */
export const placeOf = (appId: string, trail: readonly Crumb[]): FileChooserPlace => ({
  appId,
  folders: trail
    .slice(1)
    .flatMap((crumb) => (crumb.id ? [{ id: crumb.id, name: crumb.name }] : []))
    .slice(-FILE_CHOOSER_PLACE_MAX_FOLDERS),
});
