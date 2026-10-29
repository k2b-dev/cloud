import { getProcessApplicationPackage } from "./process-identity";

/** The single application-to-area mapping. No caller-supplied application or area ID. */
export const objectStoreArea = (visibility: "private" | "public" = "private"): string => {
  const packageName = getProcessApplicationPackage();
  if (!packageName) throw new Error("Start the application before using the object store.");
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(packageName)) throw new Error("Invalid object-store application package.");
  return `${visibility}/${packageName}/`;
};
