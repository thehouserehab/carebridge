export class RepositoryError extends Error {
  constructor(code) {
    super(code);
    this.name = 'RepositoryError';
    this.code = code;
  }
}
export function fail(code) { throw new RepositoryError(code); }
