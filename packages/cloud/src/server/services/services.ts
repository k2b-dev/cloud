import { err, fail, isServiceError, ok, okMany, paginate, password, svg, tryCatch, unwrap } from "@k2b/stdlib";
import * as access from "./access";
import { freeipa } from "./freeipa";

export const services = {
  access,
  freeipa,
  images: { generateFallback: svg.generateAvatar, parseWebpDataUrl: svg.parseWebpDataUrl },
  password,
  result: { ok, okMany, fail, err, unwrap, paginate, tryCatch, isServiceError },
} as const;
