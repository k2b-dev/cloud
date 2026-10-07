import type { PlatformPermission } from "../contracts/outgoing-mail";

/** Identity of the application started in this process, derived from its declaration. */
let applicationId: string | undefined;
let platformPermissions: readonly PlatformPermission[] = [];
export const getProcessPlatformPermissions = (): readonly PlatformPermission[] => platformPermissions;

export const getProcessApplicationId = (): string | undefined => applicationId;

export const bindProcessApplicationId = (id: string, permissions: readonly PlatformPermission[] = []): void => {
  if (applicationId !== undefined && applicationId !== id) {
    throw new Error(`This process already hosts application "${applicationId}"`);
  }
  applicationId = id;
  platformPermissions = [...permissions];
};

export const clearProcessApplicationId = (): void => {
  applicationId = undefined;
  platformPermissions = [];
};
