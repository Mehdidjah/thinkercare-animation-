export const UNAVAILABLE = 'Le serveur est momentanément indisponible. Réessayez dans un instant.';
export const OFFLINE = 'Connexion impossible. Vérifiez votre réseau puis réessayez.';

/** An error whose outcome is unknown or temporary (network, unreadable answer). */
export const unsure = (message: string) => Object.assign(new Error(message), {retry: true});

/** Reads an API answer. A proxy error page (HTML 502/504) or a cut-off body
 * becomes a readable message instead of a raw SyntaxError; API errors keep
 * their {error} text and HTTP status. */
export async function readJson(response: Response): Promise<any> {
  const json = (response.headers.get('content-type') || '').includes('application/json');
  const data = json ? await response.json().catch(() => undefined) : undefined;
  if (!response.ok) {
    throw Object.assign(new Error(typeof data?.error === 'string' && data.error ? data.error : UNAVAILABLE), {status: response.status});
  }
  if (!data || typeof data !== 'object') throw unsure(UNAVAILABLE);
  return data;
}

/** Network failures and 5xx may succeed if the same request is sent again;
 * 4xx answers and local checks will not change on retry. */
export function retryable(error: unknown): boolean {
  const e = error as {status?: unknown; retry?: unknown} | null;
  return e?.retry === true || typeof e?.status === 'number' && e.status >= 500;
}
