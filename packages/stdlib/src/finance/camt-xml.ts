import { SaxesParser } from "saxes";
import type { FinanceIssue } from "./common";
import type { CamtParseOptions, CamtXmlElement } from "./camt-types";

export const camtNamespace = "urn:iso:std:iso:20022:tech:xsd:camt.052.001.08";
export class CamtReadError extends Error {
  constructor(readonly issue: FinanceIssue) { super(issue.message); }
}
export type CamtLocation = { path: (string | number)[]; line: number; column: number };

/** Strict XML parsing, with no DTD/entity resolution and bounded tree construction. */
export function readCamtXml(xml: string, options: CamtParseOptions = {}) {
  const limits = { maxCharacters: 10 * 1024 * 1024, maxElements: 250_000, maxDepth: 64, ...options };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new CamtReadError({
      code: "invalid_input", path: ["options", key], message: "Expected a positive safe integer limit.",
    });
  }
  if (typeof xml !== "string") throw new CamtReadError({ code: "invalid_xml", path: ["xml"], message: "Expected XML text." });
  if (xml.length > limits.maxCharacters) throw new CamtReadError({ code: "input_limit", path: ["xml"], message: "XML exceeds maxCharacters." });
  const parser = new SaxesParser({ xmlns: true, defaultXMLVersion: "1.0", forceXMLVersion: true });
  const locations = new WeakMap<CamtXmlElement, CamtLocation>();
  const stack: { node: CamtXmlElement; counts: Map<string, number>; location: CamtLocation }[] = [];
  let root: CamtXmlElement | undefined;
  let elements = 0;
  const fail = (message: string, code: FinanceIssue["code"] = "invalid_xml"): never => {
    throw new CamtReadError({ code, path: stack.at(-1)?.location.path ?? ["xml"], line: parser.line, column: parser.column + 1, message });
  };
  parser.on("error", () => fail("Malformed XML."));
  parser.on("doctype", () => fail("DTD declarations are not supported."));
  parser.on("xmldecl", declaration => { if (declaration.version !== "1.0") fail("Only XML 1.0 is supported."); });
  parser.on("opentag", tag => {
    if (++elements > limits.maxElements || stack.length >= limits.maxDepth) fail("XML exceeds element or depth limits.", "input_limit");
    const node: CamtXmlElement = { name: tag.local, namespace: tag.uri,
      attributes: Object.values(tag.attributes).map(attr => ({ name: attr.local, namespace: attr.uri, value: attr.value })), content: [] };
    const parent = stack.at(-1);
    const key = `${tag.uri}|${tag.local}`;
    const index = parent?.counts.get(key) ?? 0;
    parent?.counts.set(key, index + 1);
    const location = { path: parent ? [...parent.location.path, tag.local, index] : ["xml", tag.local], line: parser.line, column: parser.column + 1 };
    locations.set(node, location);
    if (parent) parent.node.content.push(node);
    else root = node;
    stack.push({ node, counts: new Map(), location });
  });
  const text = (value: string) => {
    const content = stack.at(-1)?.node.content;
    if (!content) return;
    const last = content.at(-1);
    if (typeof last === "string") content[content.length - 1] = last + value;
    else content.push(value);
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => { stack.pop(); });
  parser.write(xml).close();
  const document = root ?? fail("Expected an XML document.");
  if (document.name !== "Document" || document.namespace !== camtNamespace) throw new CamtReadError({
    code: "unsupported_format", ...locations.get(document), path: ["xml", "Document"],
    message: "Expected Document in namespace urn:iso:std:iso:20022:tech:xsd:camt.052.001.08.",
  });
  return { document, locations };
}
