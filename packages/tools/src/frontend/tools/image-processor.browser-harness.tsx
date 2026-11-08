import { files } from "@k2b/stdlib/browser";
import { render } from "solid-js/web";
import { ImageProcessorView } from "./ImageProcessor.island";

const fixture = {
  downloads: [] as { filename: string; blob: Promise<Blob> }[],
  archiveImages: async (): Promise<{ name: string; width: number; height: number }[]> => {
    const archive = await fixture.downloads.find((item) => item.filename === "photos.zip")!.blob;
    const entries = await files.extractZip(new Uint8Array(await archive.arrayBuffer()));
    const images = [];
    for (const entry of entries) {
      const image = await createImageBitmap(new Blob([new Uint8Array(entry.data)], { type: "image/jpeg" }));
      images.push({ name: entry.filename, width: image.width, height: image.height });
      image.close();
    }
    return images;
  },
  rejectArchive: false,
  rejectDownload: false,
  dispose: () => {},
};
Object.assign(window, { photoFixture: fixture });
const click = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (!this.download) return click.call(this);
  if (fixture.rejectArchive && this.download === "photos.zip") throw new Error("Archive destination unavailable");
  if (fixture.rejectDownload && this.download !== "photos.zip") throw new Error("Download destination unavailable");
  fixture.downloads.push({ filename: this.download, blob: fetch(this.href).then((response) => response.blob()) });
};
async function mount() {
  let source = await (await fetch("/photo.jpg")).blob();
  if (new URLSearchParams(location.search).has("large")) {
    const image = await createImageBitmap(source);
    const canvas = document.createElement("canvas");
    canvas.width = 3000;
    canvas.height = 1500;
    canvas.getContext("2d")!.drawImage(image, 0, 0, 3000, 1500);
    image.close();
    source = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), "image/jpeg"));
    canvas.width = canvas.height = 0;
  }
  const file = new File([source], "photo.jpg", { type: "image/jpeg" });
  const second = new File([new URLSearchParams(location.search).has("brokenSecond") ? "invalid image" : file], "photo.jpg", {
    type: "image/jpeg",
  });
  fixture.dispose = render(
    () => (
      <ImageProcessorView
        initialImages={
          new URLSearchParams(location.search).has("empty")
            ? []
            : new URLSearchParams(location.search).has("many")
              ? Array.from({ length: 28 }, (_, index) => {
                  const photo = new File([file], `photo-${index + 1}.jpg`, { type: "image/jpeg" });
                  return { id: index + 1, file: photo, source: photo };
                })
              : [
                  { id: 1, file, source: file },
                  { id: 2, file: second, source: second },
                ]
        }
      />
    ),
    document.getElementById("tools")!,
  );
}
void mount();
