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
  "display",
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

/**
 * Properties whose values are limited further. Buttons need `display: inline-block` so their padding
 * takes effect; `none` stays excluded so a message cannot hide content from the reader.
 */
export const EMAIL_INLINE_STYLE_VALUE_RULES: Readonly<Record<string, RegExp>> = {
  display: /^\s*(?:block|inline|inline-block|table|table-row|table-cell|list-item)\s*$/i,
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
