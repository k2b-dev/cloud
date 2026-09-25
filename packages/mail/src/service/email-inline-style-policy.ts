export const EMAIL_INLINE_STYLE_PROPERTIES = [
  // Email templates set button and cell colours with the `background` shorthand; url() stays blocked by the value rule.
  "background",
  "background-color",
  "border",
  "border-bottom",
  "border-color",
  "border-left",
  "border-radius",
  "border-right",
  "border-style",
  "border-top",
  "border-width",
  "border-collapse",
  "color",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "letter-spacing",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-width",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration",
  "vertical-align",
  "white-space",
  "width",
] as const;

export const EMAIL_INLINE_STYLE_PROPERTY_SET = new Set<string>(EMAIL_INLINE_STYLE_PROPERTIES);

export const SAFE_EMAIL_INLINE_STYLE_VALUE = /^(?!.*(?:url|expression|var|attr)\s*\()[^{}@\u0000-\u0008\u000b\u000c\u000e-\u001f]*$/i;

export const allowedEmailInlineStyles = (tags: readonly string[]): Record<string, Record<string, RegExp[]>> =>
  Object.fromEntries(
    tags.map((tag) => [
      tag,
      Object.fromEntries(EMAIL_INLINE_STYLE_PROPERTIES.map((property) => [property, [SAFE_EMAIL_INLINE_STYLE_VALUE]])),
    ]),
  );
