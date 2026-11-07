import { createHmac, timingSafeEqual } from "node:crypto";
/** The authenticated session token remains server-only. Anonymous forms bind to a separate HttpOnly cookie. */
export const codeCsrf = (binding: string, codeId: string): string =>
  createHmac("sha256", binding).update(`cloud-code-page:v1:${codeId}`).digest("hex");
export function checkCodeCsrf(binding: string | undefined, codeId: string, received: string | undefined): boolean {
  if (!binding || !received || !/^[a-f0-9]{64}$/.test(received)) return false;
  return timingSafeEqual(Buffer.from(codeCsrf(binding, codeId), "hex"), Buffer.from(received, "hex"));
}
