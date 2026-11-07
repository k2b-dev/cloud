import { render } from "solid-js/web";
import { ImageProcessorView } from "./ImageProcessor.island";

const fixture = {
  downloads: [] as { filename: string; blob: Promise<Blob> }[],
  rejectArchive: false,
  dispose: () => {},
};
Object.assign(window, { photoFixture: fixture });
const click = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (!this.download) return click.call(this);
  if (fixture.rejectArchive && this.download === "photos.zip") throw new Error("Archive destination unavailable");
  fixture.downloads.push({ filename: this.download, blob: fetch(this.href).then((response) => response.blob()) });
};
async function mount() {
  const file = new File([await (await fetch("/photo.jpg")).blob()], "photo.jpg", { type: "image/jpeg" });
  const second = new File([file], "photo.jpg", { type: "image/jpeg" });
  fixture.dispose = render(
    () => (
      <ImageProcessorView
        initialImages={
          new URLSearchParams(location.search).has("empty")
            ? []
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
