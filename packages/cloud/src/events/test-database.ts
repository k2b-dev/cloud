/** Refuse every database except an explicitly named test database. */
export const assertTestDatabase = (name: string | undefined): void => {
  if (!name?.endsWith("_test")) {
    throw new Error('installLiveOutbox requires a database whose name ends with "_test"');
  }
};
