export const EMAIL_INLINE_STYLE_PROPERTIES = [
  // Properties common in generated email templates (MJML, Mailchimp, SendGrid, Outlook-safe table layouts).
  // Positioning (`position`, `z-index`, `inset`), `visibility`, `opacity` and `display: none` stay excluded,
  // and every value passes SAFE_EMAIL_INLINE_STYLE_VALUE, which blocks url(), expression(), var() and attr().
  "background",
  "background-color",
  "border",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-collapse",
  "border-color",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-spacing",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "box-sizing",
  "color",
  "direction",
  "display",
  "float",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "overflow",
  "overflow-wrap",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "table-layout",
  "text-align",
  "text-decoration",
  "text-decoration-color",
  "text-indent",
  "text-shadow",
  "text-transform",
  "vertical-align",
  "white-space",
  "width",
  "word-break",
  "word-spacing",
  "word-wrap",
] as const;

export const EMAIL_INLINE_STYLE_PROPERTY_SET = new Set<string>(EMAIL_INLINE_STYLE_PROPERTIES);

export const SAFE_EMAIL_INLINE_STYLE_VALUE = /^(?!.*(?:url|expression|var|attr)\s*\()[^{}@\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/i;

/**
 * Properties whose values are limited further. Buttons need `display: inline-block` so their padding
 * takes effect; `none` stays excluded so a message cannot hide content from the reader.
 */
export const EMAIL_INLINE_STYLE_VALUE_RULES: Readonly<Record<string, RegExp>> = {
  display: /^\s*(?:block|inline|inline-block|table|table-row|table-cell|list-item)\s*$/i,
  float: /^\s*(?:left|right|none)\s*$/i,
  overflow: /^\s*(?:visible|hidden|auto)\s*$/i,
};

export const allowedEmailInlineStyleValue = (property: string, value: string): boolean =>
  SAFE_EMAIL_INLINE_STYLE_VALUE.test(value) && (EMAIL_INLINE_STYLE_VALUE_RULES[property]?.test(value) ?? true);

export const allowedEmailInlineStyles = (tags: readonly string[]): Record<string, Record<string, RegExp[]>> =>
  Object.fromEntries(
    tags.map((tag) => [
      tag,
      Object.fromEntries(
        EMAIL_INLINE_STYLE_PROPERTIES.map((property) => [
          property,
          [EMAIL_INLINE_STYLE_VALUE_RULES[property] ?? SAFE_EMAIL_INLINE_STYLE_VALUE],
        ]),
      ),
    ]),
  );
