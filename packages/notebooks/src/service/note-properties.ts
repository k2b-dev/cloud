import { sql } from "bun";
import { extractNamedDataProperties, type NamedDataProperties } from "../lib/named-blocks";

export const dataPropertiesForContent = (contentMd: string | null | undefined): NamedDataProperties =>
  extractNamedDataProperties(contentMd).properties;

/**
 * Repair the rebuildable projection only if the note still contains the
 * Markdown from which it was derived. A concurrent save therefore always wins.
 */
export const repairNoteDataProperties = async (params: { noteId: string; contentMd: string | null }): Promise<boolean> => {
  const properties = dataPropertiesForContent(params.contentMd);
  const result = await sql`
    UPDATE notebooks.notes
    SET data_properties = ${properties}::jsonb
    WHERE id = ${params.noteId}::uuid
      AND content_md IS NOT DISTINCT FROM ${params.contentMd}
      AND data_properties IS DISTINCT FROM ${properties}::jsonb
  `;
  return result.count > 0;
};
