/** A provider failure the chooser explains; `status` 0 means the browser is offline. */
export class FileProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FileProviderError";
  }
}
