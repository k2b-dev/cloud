import { type CodeContext, codePermission, codePerson, codeSharePermission, readCodeOwner } from "./access";
import { findCode } from "./store";

/** Page entry checks the visitor; execution still uses the Code's own principal. */
export async function canReadCodePage(codeId: string, context: CodeContext): Promise<boolean> {
  const person = codePerson(context);
  const code = await findCode(codeId);
  if (!code) return false;
  if (code.owner.kind === "resource") return (await readCodeOwner(code.owner, context)) !== null;
  if (code.owner.kind === "person")
    return code.owner.userId === person.id || ["read", "write", "admin"].includes(await codeSharePermission(code.id, context));
  return (await codePermission(code, context)) !== null;
}
