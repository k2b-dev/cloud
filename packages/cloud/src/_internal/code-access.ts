import type { CapabilityDefinitions } from "../contracts/capabilities";

/** Validate the owner/page lifecycle contract independently of ordinary target grants. */
export const validateCodeOwners = (definitions: CapabilityDefinitions): void => {
  const code = definitions.code;
  if (code) {
    for (const key of Object.keys(code)) if (!["owners", "pages"].includes(key)) throw new Error(`code: unsupported field ${key}`);
    if (code.owners && !Array.isArray(code.owners)) throw new Error("code.owners must be a list of declared types");
    for (const [type, page] of Object.entries(code.pages ?? {})) {
      if (!code.owners?.includes(type)) throw new Error(`code.pages: ${type} is not a declared owner`);
      if (!/^\/[^\\\u0000-\u001f\u007f]*\{id\}/.test(page)) throw new Error(`code.pages: ${type} needs a path with {id}`);
    }
  }
  for (const [id, type] of Object.entries(definitions.types ?? {})) {
    for (const [key, value] of Object.entries(type.access ?? {})) {
      if (key !== "readable") throw new Error(`Resource type ${id} access: unsupported function ${key}`);
      if (typeof value !== "function") throw new Error(`Resource type ${id} access.readable must be a function`);
    }
  }
  for (const id of code?.owners ?? []) {
    const type = Object.hasOwn(definitions.types ?? {}, id) ? definitions.types?.[id] : undefined;
    if (!type?.reader) throw new Error(`Code lifecycle: ${id} must be a declared type with a reader`);
    const reader = definitions.queries?.[type.reader];
    if (reader && typeof reader.codeResourceTitle !== "function")
      throw new Error(`Code lifecycle: ${id} reader must supply codeResourceTitle for lifecycle checks`);
  }
};
