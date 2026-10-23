// One toast at a time (STYLE-SPEC component 13): one line, a status dot, auto-dismiss after 4 s, optional "View" link.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { COPY } from '../copy';
import { Link } from './router';

export type ToastKind = 'ok' | 'fail' | 'info';
interface Toast { id: number; kind: ToastKind; text: string; href?: string }
type Push = (kind: ToastKind, text: string, href?: string) => void;

const Ctx = createContext<Push>(() => undefined);
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const seq = useRef(0);
  const push = useCallback<Push>((kind, text, href) => {
    seq.current += 1;
    setToast(href === undefined ? { id: seq.current, kind, text } : { id: seq.current, kind, text, href });
  }, []);
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toast-slot" role="status" aria-live="polite">
        {toast && (
          <div className="toast" key={toast.id}>
            <span className={`dot dot-${toast.kind}`} aria-hidden="true" />
            <span className="toast-text">{toast.text}</span>
            {toast.href && <Link to={toast.href} className="toast-link">{COPY.toast.view}</Link>}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
