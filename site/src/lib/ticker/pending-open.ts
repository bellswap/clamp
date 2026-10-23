// One ticket open at a time per tab. The approve and open of a submitted ticket keep running when the form that started
// them unmounts (the phone sheet closed, the page left), so the guard lives here instead of in the form's state: a
// form mounted while an open is in flight shows its step and stays disabled until it ends.
import { useSyncExternalStore } from 'react';

export type OpenStep = 'idle' | 'approving' | 'opening';

let step: OpenStep = 'idle';
const subs = new Set<() => void>();

export function openStep(): OpenStep {
  return step;
}

export function setOpenStep(next: OpenStep): void {
  if (next === step) return;
  step = next;
  subs.forEach((f) => f());
}

/** Claims the guard for a new open: true and 'approving' when idle, false while another open is in flight. */
export function claimOpen(): boolean {
  if (step !== 'idle') return false;
  setOpenStep('approving');
  return true;
}

function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

export function useOpenStep(): OpenStep {
  return useSyncExternalStore(subscribe, openStep, openStep);
}
