import type { PlatformPermission } from "../contracts/outgoing-mail";

/** Identity of the application started in this process, derived from its declaration. */
let applicationId: string | undefined;
let applicationPackage: string | undefined;
let platformPermissions: readonly PlatformPermission[] = [];
export const getProcessPlatformPermissions = (): readonly PlatformPermission[] => platformPermissions;

export const getProcessApplicationId = (): string | undefined => applicationId;

export const getProcessApplicationPackage = (): string | undefined => applicationPackage;

export const bindProcessApplicationId = (id: string, permissions: readonly PlatformPermission[] = [], packageName = id): void => {
  if (applicationId !== undefined && (applicationId !== id || applicationPackage !== packageName)) {
    throw new Error(`This process already hosts application "${applicationId}"`);
  }
  applicationId = id;
  applicationPackage = packageName;
  platformPermissions = [...permissions];
};

export const clearProcessApplicationId = (): void => {
  applicationId = undefined;
  applicationPackage = undefined;
  platformPermissions = [];
};
