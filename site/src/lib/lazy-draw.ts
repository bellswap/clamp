// Lazy drawing of the home's sparklines (spec section 10, rendering 513 cards): one IntersectionObserver for the
// whole page with rootMargin "600px 0px"; an element is reported once, when it first comes within 600 px of the
// viewport, and is then unobserved (a drawn path stays drawn). Without IntersectionObserver in a browser everything
// draws at once; in a server render (bun tests) effects never run, so nothing lazy is drawn.
import { useEffect, useState, type RefObject } from 'react';

export const LAZY_MARGIN = '600px 0px';
/** Elements that carry this attribute are observed instead of the sparkline itself (the card root): a card with
 *  content-visibility: auto skips laying out its children, so the card's own box is the reliable target. */
export const LAZY_ROOT_ATTR = 'data-lazy-root';

type Cb = () => void;

interface Shared {
  io: IntersectionObserver;
  subs: Map<Element, Set<Cb>>;
}

let shared: Shared | null = null;

function observer(): Shared | null {
  if (shared) return shared;
  if (typeof IntersectionObserver === 'undefined') return null;
  const subs = new Map<Element, Set<Cb>>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const set = subs.get(e.target);
        subs.delete(e.target);
        io.unobserve(e.target);
        set?.forEach((cb) => cb());
      }
    },
    { rootMargin: LAZY_MARGIN },
  );
  shared = { io, subs };
  return shared;
}

/** Calls `cb` once when `el` first comes within the margin; returns the unsubscribe. */
export function whenNear(el: Element, cb: Cb): () => void {
  const s = observer();
  if (!s) {
    cb();
    return () => undefined;
  }
  let set = s.subs.get(el);
  if (!set) {
    set = new Set();
    s.subs.set(el, set);
    s.io.observe(el);
  }
  set.add(cb);
  return () => {
    const cur = s.subs.get(el);
    if (!cur) return;
    cur.delete(cb);
    if (cur.size === 0) {
      s.subs.delete(el);
      s.io.unobserve(el);
    }
  };
}

/** Whether the element behind `ref` has come near the viewport (true from the start when `lazy` is false). Once true
 *  it stays true for the component's life. */
export function useNear(ref: RefObject<Element | null>, lazy: boolean): boolean {
  const [near, setNear] = useState(!lazy);
  useEffect(() => {
    if (near) return undefined;
    const el = ref.current;
    if (!el) return undefined;
    const target = el.closest(`[${LAZY_ROOT_ATTR}]`) ?? el;
    return whenNear(target, () => setNear(true));
  }, [near, ref]);
  return near;
}
