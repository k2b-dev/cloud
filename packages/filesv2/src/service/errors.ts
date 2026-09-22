export class FilesError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 403 | 404 | 409 | 503 = 400,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "FilesError";
  }
}
