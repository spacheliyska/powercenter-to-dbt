/**
 * Raised for anything the converter cannot translate faithfully. Callers turn it into a
 * warning (one port becomes NULL) or an error (the whole target is skipped) instead of guessing.
 */
export class UnsupportedError extends Error {
  override name = 'UnsupportedError';
}

/** Runs `fn`. An UnsupportedError is returned instead of thrown; any other error still propagates. */
export function attempt<T>(fn: () => T): T | UnsupportedError {
  try {
    return fn();
  } catch (error) {
    if (error instanceof UnsupportedError) return error;
    throw error;
  }
}
