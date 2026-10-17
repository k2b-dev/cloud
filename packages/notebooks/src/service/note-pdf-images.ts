import {
  GotenbergRenderError,
  type MarkdownPdfTemplateId,
  PDF_IMAGE_MAX_INPUT_BYTES,
  type PdfImageBox,
  type PdfImageVariant,
  preparePdfImage,
} from "@k2b/cloud/services/pdf";
import { highlight } from "@k2b/stdlib";
import type { BookImagePlacement } from "../lib/book-renderer";
import { bookRendererMessages } from "../lib/book-renderer-messages";
import { type NotePdfOmission, type NotePdfOmissionCode, notePdfOmissionLabel } from "../lib/pdf-omissions";
import * as attachments from "./attachments";

// A4 minus the named presets' @page margins in packages/cloud/src/services/pdf/markdown.ts.
export const NOTE_PDF_PAGE_BOX_MM = {
  document: { width: 210 - 2 * 20, height: 297 - 22 - 24 },
  report: { width: 210 - 2 * 22, height: 297 - 24 - 26 },
  compact: { width: 210 - 2 * 15, height: 297 - 14 - 16 },
} satisfies Record<MarkdownPdfTemplateId, PdfImageBox>;
const DPI = [300, 200, 150];
const escape = highlight.escape;
const bytes = (value: string) => new TextEncoder().encode(value).byteLength;
const attachmentId = (href: string) => /^attach:\/\/([A-Za-z0-9]{6})$/.exec(href)?.[1];
type ImageCode = Exclude<NotePdfOmissionCode, "invalid_block">;
const IMAGE_CODES: ImageCode[] = [
  "not_found",
  "unsupported_format",
  "unreadable",
  "too_large",
  "over_budget",
  "timed_out",
  "blocked",
  "not_rendered",
  "unreachable",
];

export function notePdfImageBoxes(placements: readonly BookImagePlacement[], preset: MarkdownPdfTemplateId): PdfImageBox[] {
  const page = NOTE_PDF_PAGE_BOX_MM[preset];
  const clamp = (value: number) => Math.max(1, Math.min(16383, Math.round(value)));
  return DPI.map((dpi) => ({
    width: clamp(Math.max(...placements.map(({ width }) => Math.min(width === null ? Infinity : width / 96, page.width / 25.4) * dpi))),
    // With a width, Book keeps `height: auto`, so a height hint does not limit the displayed size.
    height: clamp(
      Math.max(
        ...placements.map(
          ({ width, height }) => Math.min(height === null || width !== null ? Infinity : height / 96, page.height / 25.4) * dpi,
        ),
      ),
    ),
  }));
}

const imageHtml = (image: BookImagePlacement, name: string) =>
  `<img class="notebook-book-image" src="${name}" alt="${escape(image.alt)}"${image.width !== null ? ` width="${image.width}"` : ""}${image.height !== null ? ` height="${image.height}"` : ""}${image.height !== null && image.width === null ? ` style="height: ${image.height}px"` : ""}${image.title !== null ? ` title="${escape(image.title)}"` : ""}>`;

function externalLabel(href: string): string | null {
  if (!/^https?:\/\//i.test(href) || /[\u0000-\u0020\u007f-\u009f\\]/u.test(href)) return null;
  try {
    const url = new URL(href);
    // URL.origin excludes userinfo, and neither pathname nor origin contains query or fragment.
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

export type NotePdfImageDependencies = {
  list: typeof attachments.listByShortIds;
  content: typeof attachments.getContentInNotebook;
  prepare: typeof preparePdfImage;
  now: () => number;
};
const defaults: NotePdfImageDependencies = {
  list: attachments.listByShortIds,
  content: attachments.getContentInNotebook,
  prepare: preparePdfImage,
  now: Date.now,
};

/** Resolve only notebook-owned attachments, and retain at most one input budget per tier. */
export async function prepareNotePdfImages(
  input: {
    html: string;
    images: readonly BookImagePlacement[];
    omissions: readonly NotePdfOmission[];
    notebookId: string;
    preset: MarkdownPdfTemplateId;
    maxHtmlBytes: number;
    maxAttachmentBytes: number;
    deadline: number;
    signal: AbortSignal;
    locale: string;
  },
  dependencies: Partial<NotePdfImageDependencies> = {},
) {
  const deps = { ...defaults, ...dependencies };
  const { t } = bookRendererMessages.resolve([input.locale]);
  const groups = new Map<string, { placements: BookImagePlacement[]; code?: ImageCode; name?: string }>();
  for (const placement of input.images) {
    const group = groups.get(placement.href);
    if (group) group.placements.push(placement);
    else groups.set(placement.href, { placements: [placement] });
  }
  const shortIds = [...groups.keys()].flatMap((href) => {
    const id = attachmentId(href);
    return id ? [id] : [];
  });
  const rows =
    shortIds.length && !input.signal.aborted && deps.now() < input.deadline
      ? await deps.list({ shortIds, notebookId: input.notebookId })
      : [];
  const metadata = new Map(rows.filter((row) => row.notebookId === input.notebookId).map((row) => [row.shortId, row]));
  const label = (image: BookImagePlacement) =>
    notePdfOmissionLabel(image.alt || metadata.get(attachmentId(image.href) ?? "")?.filename || externalLabel(image.href) || "");
  const placeholder = (image: BookImagePlacement, code: ImageCode) => {
    const text = t.imageNotIncluded({ label: label(image), reason: t[`imagePlaceholder_${code}`] });
    return `<span class="notebook-book-image-missing" role="img" aria-label="${escape(text)}">${escape(text)}</span>`;
  };
  // Reserve the larger of an image and every possible localized placeholder at each surviving placement.
  const slots = new Map(input.images.map((image) => [image.token, image]));
  const tokenPattern = new RegExp(input.images.length ? `${input.images[0]!.token.replace(/\d+END$/, "")}\\d+END` : "(?!)", "g");
  let htmlUpperBound = bytes(input.html);
  input.html.replace(tokenPattern, (token) => {
    const image = slots.get(token)!;
    const maximum = Math.max(
      bytes(imageHtml(image, `img-${groups.size}.png`)),
      ...IMAGE_CODES.map((code) => bytes(placeholder(image, code))),
    );
    htmlUpperBound += maximum - bytes(token);
    return token;
  });
  if (htmlUpperBound > input.maxHtmlBytes)
    throw new GotenbergRenderError("html_too_large", "Note HTML exceeds the configured input budget.");
  const remaining = input.maxHtmlBytes - htmlUpperBound;
  const tiers = DPI.map(() => ({ alive: true, total: 0, variants: new Map<string, PdfImageVariant>() }));
  let draftFull = false;
  let peakRetainedBytes = 0;
  // Keep content scoped to this call so it is released before the next attachment is loaded.
  const prepare = async (row: attachments.Attachment, placements: BookImagePlacement[]) => {
    const loaded = await deps.content({ id: row.id, notebookId: input.notebookId });
    if (!loaded) return { ok: false, code: "not_found" } as const;
    if (input.signal.aborted || deps.now() >= input.deadline) return { ok: false, code: "timed_out" } as const;
    return deps.prepare(
      {
        data: loaded.content,
        boxes: notePdfImageBoxes(placements, input.preset),
        maxBytes: Math.min(remaining, PDF_IMAGE_MAX_INPUT_BYTES),
      },
      { signal: input.signal, timeoutMs: Math.max(1, input.deadline - deps.now()) },
    );
  };
  for (const [href, group] of groups) {
    const id = attachmentId(href);
    if (!id) {
      group.code = externalLabel(href) === null ? "blocked" : "not_rendered";
      continue;
    }
    if (input.signal.aborted || deps.now() >= input.deadline) {
      group.code = "timed_out";
      continue;
    }
    const row = metadata.get(id);
    if (!row) {
      group.code = "not_found";
      continue;
    }
    if (!row.mimeType.startsWith("image/") || row.mimeType === "image/svg+xml") {
      group.code = "unsupported_format";
      continue;
    }
    // The image worker rejects larger inputs anyway; never load bytes it cannot take.
    if (row.sizeBytes > Math.min(input.maxAttachmentBytes, PDF_IMAGE_MAX_INPUT_BYTES)) {
      group.code = "too_large";
      continue;
    }
    if (remaining <= 0 || (!tiers[0]!.alive && !tiers[1]!.alive && draftFull)) {
      group.code = "over_budget";
      continue;
    }
    let result: Awaited<ReturnType<typeof prepare>>;
    try {
      result = await prepare(row, group.placements);
    } catch (error) {
      if (!input.signal.aborted && deps.now() < input.deadline) throw error;
      group.code = "timed_out";
      continue;
    }
    if (!result.ok) {
      group.code = result.code;
      continue;
    }
    for (const [index, tier] of tiers.entries()) {
      const variant = result.variants[index];
      if (index === 2) {
        if (draftFull || !variant || tier.total + variant.data.size > remaining) draftFull = true;
        else {
          tier.total += variant.data.size;
          tier.variants.set(href, variant);
        }
      } else if (tier.alive) {
        if (!variant || tier.total + variant.data.size > remaining) {
          tier.alive = false;
          tier.total = 0;
          tier.variants.clear();
        } else {
          tier.total += variant.data.size;
          tier.variants.set(href, variant);
        }
      }
      // The worker result must not keep a discarded tier alive either.
      result.variants[index] = null;
    }
    peakRetainedBytes = Math.max(
      peakRetainedBytes,
      tiers.reduce((sum, tier) => sum + tier.total, 0),
    );
  }
  const selected = tiers.find((tier, index) => index < 2 && tier.alive) ?? tiers[2]!;
  const assets: { name: string; data: Blob }[] = [];
  for (const [href, group] of groups) {
    if (group.code) continue;
    const variant = selected.variants.get(href);
    if (!variant) {
      group.code = "over_budget";
      continue;
    }
    group.name = `img-${assets.length + 1}.${variant.type === "image/jpeg" ? "jpg" : "png"}`;
    assets.push({ name: group.name, data: variant.data });
  }
  for (const tier of tiers) tier.variants.clear();
  const omissions: NotePdfOmission[] = [];
  let rendererIndex = 0;
  const seen = new Set<string>();
  for (const image of input.images) {
    const group = groups.get(image.href)!;
    while (rendererIndex < image.omissionIndex) omissions.push(input.omissions[rendererIndex++]!);
    if (group.code && !seen.has(image.href)) omissions.push({ code: group.code, kind: "image", label: label(image) });
    seen.add(image.href);
  }
  const html = input.html.replace(tokenPattern, (token) => {
    const image = slots.get(token)!;
    const group = groups.get(image.href)!;
    return group.code ? placeholder(image, group.code) : imageHtml(image, group.name!);
  });
  omissions.push(...input.omissions.slice(rendererIndex));
  return { html, assets, omissions, peakRetainedBytes, htmlUpperBound };
}
