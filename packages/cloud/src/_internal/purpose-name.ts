const PURPOSE_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;

export const isPurposeName = (name: string): boolean => typeof name === "string" && PURPOSE_NAME.test(name);

export const validatePurposeName = (name: string): void => {
  if (!isPurposeName(name)) throw new TypeError("Purpose name must match [a-z0-9][a-z0-9.-]{0,63}");
};
