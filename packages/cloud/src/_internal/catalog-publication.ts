/** Cache only successful publications. Startup failures remain retryable through the app heartbeat. */
export const createCatalogPublication = () => {
  let publishedHash: string | undefined;
  let pending: Promise<void> = Promise.resolve();
  return (hash: string, write: () => Promise<void | boolean>): Promise<void> => {
    if (hash === publishedHash) return Promise.resolve();
    const operation = pending
      .catch(() => undefined)
      .then(async () => {
        if (hash !== publishedHash && (await write()) !== false) publishedHash = hash;
      });
    pending = operation;
    return operation;
  };
};
