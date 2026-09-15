// Cloud-specific server services

export type {
  AccessDb,
  AccessEntry,
  AccessPrincipalColumns,
  AccessPrincipalTierConditions,
  AccessSubject,
  AccessUser,
  AccessUserSource,
  EffectiveGroup,
  PermissionLevel,
  Principal,
  PrincipalType,
  ResourceAccessAdapter,
} from "./access";
export {
  buildAccessPrincipalCondition,
  buildAccessPrincipalTierConditions,
  createAccess,
  deleteAccess,
  getAccess,
  getEffectiveGroupIds,
  getEffectiveGroups,
  getEffectivePermission,
  hasPermission,
  listUsersWithAccess,
  PERMISSION_LEVELS,
  resolveDisplayNames,
  updateAccess,
} from "./access";
export { freeipa } from "./freeipa";
export type { GeoPlace, GeoService } from "./geo";

export { geo, geoService } from "./geo";
export { paginateItems } from "./pagination";
export { services } from "./services";

// Re-export from stdlib for backward compatibility
// Prefer importing directly from @k2b/stdlib
import { password as _password, svg as _svg } from "@k2b/stdlib";

export type { PageParams, Paginated, Result, ServiceError, ServiceErrorCode } from "@k2b/stdlib";
export { crypto, err, fail, isServiceError, ok, okMany, paginate, password, svg, tryCatch, unwrap } from "@k2b/stdlib";

// Compat aliases for old API names
export const images = { generateFallback: _svg.generateAvatar, parseWebpDataUrl: _svg.parseWebpDataUrl };
export const generatePassword = _password.random;
export { accessRevision } from "./access-revision";
