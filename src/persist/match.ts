// Conservative application matching for restored float rectangles (T27, Q06, CONFIGURATION §8).
// A saved float belongs to an application identity, never to a window: session window ids do
// not survive a restart. It is restored only when exactly one live window has that identity;
// with two or more instances nobody can say which one it was, so ordinary insertion applies.

/** What identifies an application across sessions: id, resource name and window role (never the title). */
export interface AppIdentity {
  readonly appId: string;
  readonly resourceName: string;
  readonly role: string;
}

/** Map key of an identity, or null when there is no application id to match on. */
export function identityKey(a: AppIdentity): string | null {
  return a.appId === "" ? null : JSON.stringify([a.appId, a.resourceName, a.role]);
}

export type FloatMatch<E> =
  | { readonly kind: "restore"; readonly entry: E }
  | { readonly kind: "ambiguous"; readonly count: number }
  | { readonly kind: "none" };

/**
 * Decide a restore for one window: `key` is its identity key and `live` the number of live
 * windows (itself included) with that key.
 */
export function matchFloat<E>(saved: ReadonlyMap<string, E>, key: string | null, live: number): FloatMatch<E> {
  if (key === null) return { kind: "none" };
  const entry = saved.get(key);
  if (entry === undefined) return { kind: "none" };
  if (live !== 1) return live > 1 ? { kind: "ambiguous", count: live } : { kind: "none" };
  return { kind: "restore", entry };
}
