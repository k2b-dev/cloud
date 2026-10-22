import { invokeCapabilityWithDataSchema } from "@k2b/cloud/capabilities";
import { geoContract } from "@k2b/cloud/contracts";
import {
  GEO_SNAPSHOT_MAX_BYTES,
  type GeoMapSnapshotManifest,
  geoMapSnapshotFingerprint,
  geoMapSnapshotPart,
} from "@k2b/cloud/contracts/geo-snapshot";
import { CloudMap } from "@k2b/cloud/geo/ui";
import { LocaleProvider, type MapViewHandle, type MapViewSnapshot } from "@k2b/ui";
import { render } from "solid-js/web";
import { renderNotebookBook } from "../../lib/book-renderer";
import { mapMarkers, mapStateMessage, type NotebookMapImage, notebookMapRevision, parseNotebookMapBlocks } from "../../lib/map-blocks";
import { notebookMapMessages } from "../../lib/map-messages";

export class NotebookMapCaptureError extends Error {}
async function availabilityReason(locale: string, signal: AbortSignal) {
  const result = await invokeCapabilityWithDataSchema(
    { kind: "query", appId: "core", capabilityId: geoContract.availability.id, input: {}, signal },
    geoContract.availability.data,
  );
  return result.ok ? mapStateMessage({ availability: result.data.data }, locale) : "";
}

/** Browser image loading shares the map preparation deadline and stops waiting when the dialog closes. */
export function decodeNotebookPrintImages(host: HTMLElement, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error("Print image preparation timed out")), 30_000);
    signal.addEventListener("abort", abort, { once: true });
    Promise.all(
      [...host.querySelectorAll<HTMLImageElement>("img")].map((image) => {
        // The print document is hidden until window.print(); lazy images must load before that call.
        image.loading = "eager";
        return image.decode();
      }),
    ).then(() => finish(), finish);
  });
}

/** Render fitted saved maps in the visible export preview; one GPU capture at a time. */
export async function captureNotebookMaps(
  markdown: string,
  host: HTMLElement,
  locale: string,
  signal: AbortSignal,
  notebookId: string,
  noteId: string,
) {
  signal.throwIfAborted();
  const blocks = parseNotebookMapBlocks(markdown).blocks;
  const form = new FormData();
  const images = new Map<number, NotebookMapImage>();
  const urls: string[] = [];
  const manifest: GeoMapSnapshotManifest = { version: 1, revision: await notebookMapRevision(markdown), images: [] };
  let bytes = 0;
  signal.throwIfAborted();
  host.innerHTML = renderNotebookBook({
    markdown,
    locale,
    notebookId,
    noteId,
    print: true,
    browserImages: true,
    querySource: true,
    mapImagesPending: true,
  }).html;
  const figures = [...host.querySelectorAll<HTMLElement>("figure.notebook-map")];
  const slots = blocks.map((block, index) => {
    const slot = document.createElement("div");
    slot.className = "notebook-map-export__slot";
    slot.style.height = `${block.document.route && !block.document.pins.length ? 150 : 186}px`;
    slot.setAttribute("role", "status");
    slot.textContent = notebookMapMessages.resolve([locale]).t.printImageWaiting;
    figures[index]?.querySelector(".notebook-map__body")?.prepend(slot);
    return slot;
  });
  const release = () => urls.splice(0).forEach((url) => URL.revokeObjectURL(url));
  const reason = await availabilityReason(locale, signal);
  signal.throwIfAborted();
  if (reason) throw new NotebookMapCaptureError(reason);

  try {
    for (const [index, block] of blocks.entries()) {
      signal.throwIfAborted();
      const document = block.document;
      const slot = slots[index]!;
      let dispose: (() => void) | undefined;
      try {
        slot.replaceChildren();
        slot.scrollIntoView({ block: "nearest" });
        const snapshot = await new Promise<MapViewSnapshot>((resolve, reject) => {
          let handle: MapViewHandle | undefined;
          let capturing = false;
          const fail = () => {
            finish();
            reject(new Error("Map snapshot unavailable"));
          };
          const timer = setTimeout(fail, 30_000);
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", fail);
          };
          signal.addEventListener("abort", fail, { once: true });
          const capture = async () => {
            if (!handle || capturing) return;
            capturing = true;
            try {
              resolve(await handle.snapshot({ signal }));
            } catch (error) {
              reject(error);
            } finally {
              finish();
            }
          };
          dispose = render(
            () => (
              <LocaleProvider locale={locale}>
                <CloudMap
                  height={document.route && !document.pins.length ? 150 : 186}
                  markers={mapMarkers(document)}
                  lines={document.route ? [{ id: "route", polyline6: document.route.polyline6 }] : []}
                  ref={(value) => {
                    handle = value;
                  }}
                  onStateChange={(state) => {
                    if (state === "ready") queueMicrotask(() => void capture());
                    if (state === "error" || state === "no-webgl" || state === "empty") {
                      finish();
                      fail();
                    }
                  }}
                />
              </LocaleProvider>
            ),
            slot,
          );
        });
        signal.throwIfAborted();
        bytes += snapshot.data.size;
        if (bytes > GEO_SNAPSHOT_MAX_BYTES) throw new Error("Map snapshot budget exceeded");
        const id = `line-${block.line}`;
        manifest.images.push({
          id,
          fingerprint: await geoMapSnapshotFingerprint(document),
          width: snapshot.width,
          height: snapshot.height,
        });
        form.append(geoMapSnapshotPart(id), snapshot.data, `${id}.png`);
        const src = URL.createObjectURL(snapshot.data);
        urls.push(src);
        images.set(block.line, { src, width: snapshot.width, height: snapshot.height });
        dispose?.();
        dispose = undefined;
        const image = new Image(snapshot.width, snapshot.height);
        image.className = "notebook-map__image";
        image.alt = document.title;
        image.src = src;
        await image.decode();
        signal.throwIfAborted();
        slot.replaceChildren(image);
      } finally {
        dispose?.();
      }
    }
    signal.throwIfAborted();
    host.innerHTML = renderNotebookBook({
      markdown,
      locale,
      notebookId,
      noteId,
      print: true,
      browserImages: true,
      querySource: true,
      mapImages: images,
    }).html;
    form.set("mapSnapshots", JSON.stringify(manifest));
    return { form, images, release };
  } catch (error) {
    release();
    if (signal.aborted) throw error;
    throw new NotebookMapCaptureError((await availabilityReason(locale, signal)) || notebookMapMessages.resolve([locale]).t.printFailed);
  }
}
