/** Identity of the application started in this process, derived from its declaration. */
let applicationId: string | undefined;

export const getProcessApplicationId = (): string | undefined => applicationId;

export const bindProcessApplicationId = (id: string): void => {
  if (applicationId !== undefined && applicationId !== id) {
    throw new Error(`This process already hosts application "${applicationId}"`);
  }
  applicationId = id;
};

export const clearProcessApplicationId = (): void => {
  applicationId = undefined;
};
