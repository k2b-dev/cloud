import { renderLiquidTemplate } from "@k2b/cloud/shared";
import { err, fail, ok, type Result } from "@k2b/stdlib";
import { DOMParser, onWarningStopParsing } from "@xmldom/xmldom";
import { documentLiquidFilters, validateDocumentLiquidTemplate } from "./document-liquid";
import { documentServiceText } from "./document-messages";

const xmlRoots = new Set(["rows", "columns", "document"]);
const invalidXmlCharacter = /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u;

export const escapeXmlValue = (value: unknown): string => {
  const text = String(value);
  if (invalidXmlCharacter.test(text)) throw new Error("Invalid XML character");
  return text.replace(/[&<>"'\t\r\n]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      // Preserve whitespace even in attributes, where literal whitespace is normalized.
      case "\t":
        return "&#9;";
      case "\r":
        return "&#13;";
      default:
        return "&#10;";
    }
  });
};

/** This scanner only limits interpolation contexts. The XML parser owns XML
 * grammar; Liquid owns expressions and control flow. Neither is reimplemented. */
export const validateDocumentXmlTemplate = (source: string, locale?: string): Result<void> => {
  const t = documentServiceText(locale);
  const liquid = validateDocumentLiquidTemplate(source, "body", xmlRoots, locale);
  if (!liquid.ok) return liquid;
  let inTag = false;
  let quote: string | null = null;
  let tagStart = 0;
  let attribute = "";
  for (let index = 0; index < source.length; ) {
    if (source.startsWith("{{", index) || source.startsWith("{%", index)) {
      const isValue = source.startsWith("{{", index);
      const end = source.indexOf(isValue ? "}}" : "%}", index + 2);
      if (end < 0 || (inTag && (!isValue || !quote || attribute === "xmlns" || attribute.startsWith("xmlns:"))))
        return fail(err.badInput(t.xmlTemplateContextInvalid));
      const token = source.slice(index, end + 2);
      // Raw/captured markup would make lexical XML contexts differ from rendered
      // contexts. Ordinary loops, conditions and scalar assignments remain available.
      if (!isValue && /^{%-?\s*(?:raw|endraw|capture|endcapture|comment|endcomment)\b/.test(token))
        return fail(err.badInput(t.xmlTemplateContextInvalid));
      index = end + 2;
      continue;
    }
    if (!inTag && source.startsWith("<!--", index)) {
      const end = source.indexOf("-->", index + 4);
      if (end < 0 || /{{|{%/.test(source.slice(index, end))) return fail(err.badInput(t.xmlTemplateContextInvalid));
      index = end + 3;
      continue;
    }
    if (!inTag && source.startsWith("<!", index)) return fail(err.badInput(t.xmlTemplateContextInvalid));
    if (!inTag && source.startsWith("<?", index)) {
      const end = source.indexOf("?>", index + 2);
      if (index !== 0 || end < 0 || !/^<\?xml\s/.test(source) || /{{|{%/.test(source.slice(index, end)))
        return fail(err.badInput(t.xmlTemplateContextInvalid));
      index = end + 2;
      continue;
    }
    const character = source[index];
    if (!inTag && character === "<") {
      inTag = true;
      tagStart = index;
    } else if (inTag) {
      if (quote && character === quote) quote = null;
      else if (!quote && (character === '"' || character === "'")) {
        const match = source.slice(tagStart, index).match(/([^\s<>=/'"]+)\s*=\s*$/);
        if (!match) return fail(err.badInput(t.xmlTemplateContextInvalid));
        attribute = match[1]!;
        quote = character;
      } else if (!quote && character === ">") inTag = false;
    }
    index++;
  }
  if (inTag || quote) return fail(err.badInput(t.xmlTemplateContextInvalid));
  return ok();
};

export const validateDocumentXml = (xml: string, locale?: string): Result<void> => {
  const invalid = () => fail(err.badInput(documentServiceText(locale).xmlOutputInvalid));
  if (invalidXmlCharacter.test(xml) || /<!DOCTYPE|<!ENTITY/i.test(xml)) return invalid();
  const declaration = xml.match(/^\s*<\?xml\s([\s\S]*?)\?>/);
  if (
    declaration &&
    (!/\bversion\s*=\s*(['"])1\.0\1/.test(declaration[1]!) ||
      (/\bencoding\s*=/.test(declaration[1]!) && !/\bencoding\s*=\s*(['"])UTF-8\1/i.test(declaration[1]!)))
  )
    return invalid();
  // xmldom decodes numeric references without rejecting every forbidden XML
  // code point. Check them before parsing; never allow a decoded NUL/surrogate.
  for (const match of xml.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);/g)) {
    const token = match[1]!;
    const code = token.startsWith("x") ? Number.parseInt(token.slice(1), 16) : Number(token);
    if (!Number.isSafeInteger(code) || code > 0x10ffff || invalidXmlCharacter.test(String.fromCodePoint(code))) return invalid();
  }
  try {
    const document = new DOMParser({ onError: onWarningStopParsing }).parseFromString(xml, "application/xml");
    if (!document.documentElement || document.doctype) return invalid();
    return ok();
  } catch {
    return invalid();
  }
};

export const renderDocumentXml = (source: string, data: Record<string, unknown>, locale?: string): Result<string> => {
  const valid = validateDocumentXmlTemplate(source, locale);
  if (!valid.ok) return valid;
  try {
    const rendered = renderLiquidTemplate(source, data, { filters: documentLiquidFilters, escapeOutput: escapeXmlValue });
    const xml = validateDocumentXml(rendered, locale);
    return xml.ok ? ok(rendered) : xml;
  } catch {
    return fail(err.badInput(documentServiceText(locale).xmlOutputInvalid));
  }
};
