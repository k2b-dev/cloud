/** Cache only successful publications; verify advertised sources without renewing a SQL lease. */
export const createCatalogPublication = () => {
  let publishedHash: string | undefined;
  let pending: Promise<void> = Promise.resolve();
  return (
    hash: string,
    write: () => Promise<void | boolean>,
    options: { force?: boolean; verify?: () => Promise<boolean>; onMissing?: () => void } = {},
  ): Promise<void> => {
    if (hash === publishedHash && !options.force && !options.verify) return Promise.resolve();
    const operation = pending
      .catch(() => undefined)
      .then(async () => {
        if (hash === publishedHash && !options.force) {
          if (!options.verify || (await options.verify())) return;
          options.onMissing?.();
        }
        publishedHash = undefined;
        if ((await write()) !== false) publishedHash = hash;
      });
    pending = operation;
    return operation;
  };
};
