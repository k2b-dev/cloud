import { mermaidConfig } from "../../browser/mermaid";

/**
 * Initialize Mermaid diagrams within a container element.
 * Call this in onMount() of your client-side component.
 *
 * @param container - The container element containing rendered markdown
 */
export async function initMermaid(container: HTMLElement): Promise<void> {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize(mermaidConfig({ dark: document.documentElement.classList.contains("dark") }));

  // Find mermaid blocks (rendered with fixed-height container from server)
  const mermaidBlocks = container.querySelectorAll(".md-mermaid-block");
  if (mermaidBlocks.length === 0) return;

  const renderPromises = Array.from(mermaidBlocks).map(async (block, index) => {
    const codeElement = block.querySelector("code.language-mermaid");
    const innerContainer = block.querySelector(".h-full.w-full.flex") as HTMLElement;
    if (!codeElement || !innerContainer) return;

    const code = codeElement.textContent || "";
    const mermaidId = `mermaid-${index}-${Date.now()}`;

    try {
      // Render mermaid to SVG
      const { svg } = await mermaid.render(mermaidId, code);

      // Remove loading indicator and hidden pre
      const loading = innerContainer.querySelector(".md-mermaid-loading");
      const pre = innerContainer.querySelector("pre");
      loading?.remove();
      pre?.remove();

      // Create container for SVG with scaling
      const svgContainer = document.createElement("div");
      svgContainer.className = "flex items-center justify-center w-full h-full";
      svgContainer.innerHTML = svg;

      // Scale SVG to fit container
      const svgElement = svgContainer.querySelector("svg");
      if (svgElement) {
        svgElement.style.maxWidth = "100%";
        svgElement.style.maxHeight = "100%";
        svgElement.style.width = "auto";
        svgElement.style.height = "auto";
      }

      innerContainer.appendChild(svgContainer);
    } catch (error) {
      // Show error
      const loading = innerContainer.querySelector(".md-mermaid-loading");
      if (loading) {
        loading.innerHTML = `
            <div class="flex flex-col items-center gap-2 text-red-500">
              <i class="ti ti-alert-circle text-xl"></i>
              <span class="text-sm">Invalid mermaid syntax</span>
            </div>
          `;
      }
    }
  });

  await Promise.all(renderPromises);
}

/**
 * Set external links to open in new tab.
 * Call this in onMount() of your client-side component.
 *
 * @param container - The container element containing rendered markdown
 */
export function initExternalLinks(container: HTMLElement): void {
  const links = container.querySelectorAll("a");
  links.forEach((link) => {
    if (link.href && !link.href.startsWith(window.location.origin)) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  });
}

/**
 * Initialize all markdown enhancements (Mermaid + external links).
 * KaTeX is rendered server-side and doesn't need client initialization.
 * Call this in onMount() of your client-side component.
 *
 * @param container - The container element containing rendered markdown
 */
export async function initMarkdownEnhancements(container: HTMLElement): Promise<void> {
  await initMermaid(container);
  initExternalLinks(container);
}

export const markdownClient = {
  initMermaid,
  initExternalLinks,
  initEnhancements: initMarkdownEnhancements,
  initMarkdownEnhancements,
} as const;
