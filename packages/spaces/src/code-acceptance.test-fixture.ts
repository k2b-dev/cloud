import { acceptanceProvider } from "../../../scripts/fixtures/code-acceptance-provider";
import { spacesCapabilities } from "./capabilities";
import { getSpacePermission, listSpaceAccess } from "./service/access";

/** Load this app with its own aliases; Core never substitutes a reduced Spaces declaration. */
export const provider = {
  ...acceptanceProvider("spaces", spacesCapabilities),
  permission: getSpacePermission,
  accessList: listSpaceAccess,
};
