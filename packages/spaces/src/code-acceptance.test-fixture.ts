import { acceptanceProvider } from "../../../scripts/fixtures/code-acceptance-provider";
import { spacesCapabilities } from "./capabilities";
import { getSpacePermission, grantSpaceAccess, listSpaceAccess, revokeSpaceAccess } from "./service/access";

/** Load this app with its own aliases; Core never substitutes a reduced Spaces declaration. */
export const provider = {
  ...acceptanceProvider("spaces", spacesCapabilities),
  grant: grantSpaceAccess,
  revoke: revokeSpaceAccess,
  permission: getSpacePermission,
  accessList: listSpaceAccess,
};
