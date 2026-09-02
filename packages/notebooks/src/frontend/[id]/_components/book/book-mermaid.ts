/** Enhance static source figures without ever mounting returned SVG as live DOM. */
export async function enhanceBookMermaid(
  root: HTMLElement,
  renderSvg: (source: string, id: string) => Promise<string>,
  signal: AbortSignal,
  errorText: string,
): Promise<void> {
  const cleanups: Array<() => void> = [];
  const active = () => !signal.aborted && root.isConnected;
  if (!active()) return;
  signal.addEventListener("abort", () => cleanups.splice(0).forEach((cleanup) => cleanup()), { once: true });
  for (const figure of Array.from(root.querySelectorAll<HTMLElement>(".notebook-book-mermaid"))) {
    if (!active()) return;
    const pre = figure.querySelector("pre");
    const caption = figure.querySelector("figcaption");
    const code = pre?.querySelector("code.language-mermaid");
    if (!pre || !code) continue;
    const fail = () => {
      if (!active()) return;
      const message = document.createElement("p");
      message.className = "notebook-book-diagnostic";
      message.setAttribute("role", "status");
      message.textContent = errorText;
      figure.prepend(message);
      cleanups.push(() => message.remove());
    };
    try {
      // Serial rendering bounds layout concurrency. Mermaid has no abortable
      // render API; a detached/aborted owner never receives its late result.
      const svg = await renderSvg(code.textContent ?? "", `book-mermaid-${crypto.randomUUID()}`);
      if (!active()) return;
      const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
      const image = document.createElement("img");
      image.alt = caption?.textContent ?? "";
      image.className = "notebook-book-diagram";
      image.style.maxWidth = "100%";
      image.style.height = "auto";
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = caption?.textContent ?? "";
      details.append(summary);
      image.onload = () => {
        if (!active()) return;
        details.append(pre);
        caption?.remove();
        figure.append(details);
      };
      image.onerror = () => {
        image.remove();
        fail();
      };
      // SVG image context disables scripts, embedded document access and click
      // bindings. Do not replace this sink with innerHTML or bindFunctions.
      image.src = url;
      figure.prepend(image);
      cleanups.push(() => {
        image.onload = null;
        image.onerror = null;
        image.remove();
        if (caption) figure.append(caption);
        figure.append(pre);
        details.remove();
        URL.revokeObjectURL(url);
      });
    } catch {
      fail();
    }
  }
}
