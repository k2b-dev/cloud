export type EmailDesignPreviewText = {
  heading: string;
  greeting: string;
  body: string;
  quote: string;
  closing: string;
  team: string;
};

/**
 * The page of the email design preview. Its policy lets the CSS style the sample message but load nothing, so a
 * stored or half-typed value such as `image-set("https://…" 1x)` never reaches the network from this browser.
 */
export const emailDesignPreviewDocument = (css: string, text: EmailDesignPreviewText): string =>
  `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
  body { margin: 0; padding: 24px; color: #18181b; background: #fff; font: 15px/1.55 system-ui, sans-serif; }
  .mail-content { max-width: 640px; margin: 0 auto; }
  .mail-signature { margin-top: 16px; }
  h1 { margin: 0 0 16px; font-size: 22px; }
  p { margin: 0 0 14px; }
  a { color: #0f766e; }
  blockquote { margin: 16px 0; padding-left: 14px; border-left: 3px solid #d4d4d8; color: #52525b; }
  ${css.replaceAll("<", "\\3C ")}
</style></head><body><main class="mail-content">
  <h1>${text.heading}</h1>
  <p>${text.greeting}</p>
  <p>${text.body}</p>
  <blockquote>${text.quote}</blockquote>
  <div class="mail-signature">${text.closing}<br>${text.team}</div>
</main></body></html>`;
