// Modal behaviour for the sheets that declare role="dialog" aria-modal="true" (ticket sheet, share sheet): while the
// dialog is mounted everything outside it is inert (no focus, no pointer, hidden from assistive tech), focus moves into
// the dialog on open and goes back to the opener on close. Live regions (the toast slot) stay out of the inert set so
// the approve and open toasts are still announced.
import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** `focusKey` changes when the dialog swaps its content (the ticket sheet once the catalog loads): focus that fell out
 * of the dialog with the replaced nodes moves back in. */
export function useModal(ref: RefObject<HTMLElement | null>, focusKey: unknown = null): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const made: HTMLElement[] = [];
    for (let n: HTMLElement = el; n.parentElement && n !== document.body; n = n.parentElement) {
      for (const sib of Array.from(n.parentElement.children)) {
        if (sib === n || !(sib instanceof HTMLElement) || sib.inert || sib.matches('[aria-live], script, style, link')) continue;
        sib.inert = true;
        made.push(sib);
      }
    }
    return () => {
      for (const m of made) m.inert = false;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref]);
  useEffect(() => {
    const el = ref.current;
    if (!el || el.contains(document.activeElement)) return;
    // The first control of the sheet itself (the scrim is a full-screen close button and not a useful first stop).
    const target = el.querySelector<HTMLElement>(`.sheet :is(${FOCUSABLE})`) ?? el;
    if (target === el && !el.hasAttribute('tabindex')) el.tabIndex = -1;
    target.focus({ preventScroll: true });
  }, [ref, focusKey]);
}
