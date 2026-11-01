export class NotesError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: 400 | 401 | 403 | 404 | 408 | 409 | 410 | 413 | 415 | 423 | 429 | 451 | 503 | 507 = 400,
    public readonly reason?: string,
  ) {
    super(code);
  }
}
