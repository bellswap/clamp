// Recovery from a lazy chunk that failed to load (App.tsx RouteBoundary): one automatic reload per tab to fetch the new
// build, re-armed when a chunk loads again. Pure apart from the default storage: bun test drives it.
export const RELOAD_KEY = 'bellswap.v2.chunk-reload';
/** A lazy chunk that failed to load: after a redeploy the old hashed file is gone and Pages answers with index.html. */
export function isChunkError(e: unknown): boolean {
  return e instanceof Error && /dynamically imported module|Importing a module script failed|error loading dynamically imported|ChunkLoadError|MIME type/i.test(`${e.name} ${e.message}`);
}
/** True once per tab until a lazy chunk loads again (chunkLoaded): a chunk that still fails after the reload shows the
 * recovery screen instead of reloading in a loop, however long each failed request takes. False without storage. */
export function mayReload(given?: Pick<Storage, 'getItem' | 'setItem'> | null): boolean {
  try {
    const store = given === undefined ? globalThis.sessionStorage : given;
    if (!store || store.getItem(RELOAD_KEY) !== null) return false;
    store.setItem(RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}
/** A lazy chunk loaded: the next failure (a later redeploy) may reload once again. */
export function chunkLoaded(given?: Pick<Storage, 'removeItem'> | null): void {
  try {
    const store = given === undefined ? globalThis.sessionStorage : given;
    store?.removeItem(RELOAD_KEY);
  } catch {
    /* no storage */
  }
}
