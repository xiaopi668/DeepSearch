import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { CircleCheck, CircleX, Info, X } from 'lucide-react';

export type ToastKind = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastContextValue {
  pushToast: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 3200;
const MAX_TOASTS = 4;

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast 必须在 <ToastProvider> 内使用');
  return context;
}

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'success') return <CircleCheck className="toast__icon" size={18} aria-hidden="true" />;
  if (kind === 'error') return <CircleX className="toast__icon" size={18} aria-hidden="true" />;
  return <Info className="toast__icon" size={18} aria-hidden="true" />;
}

function Toasts({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  const reduce = useReducedMotion();
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => (
          <motion.div
            key={toast.id}
            className={`toast toast--${toast.kind}`}
            data-testid="toast"
            role="status"
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: reduce ? 0 : 0.15, ease: 'easeOut' }}
          >
            <ToastIcon kind={toast.kind} />
            <span className="toast__message">{toast.message}</span>
            <button
              type="button"
              className="toast__close"
              aria-label="关闭提示"
              onClick={() => onDismiss(toast.id)}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextIdRef = useRef(1);
  const timersRef = useRef<number[]>([]);

  const dismiss = useCallback((id: number): void => {
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  const pushToast = useCallback(
    (message: string, kind: ToastKind = 'info'): void => {
      const id = nextIdRef.current;
      nextIdRef.current += 1;
      setToasts((previous) => [...previous.slice(-(MAX_TOASTS - 1)), { id, kind, message }]);
      const timer = window.setTimeout(() => dismiss(id), TOAST_DURATION);
      timersRef.current.push(timer);
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers.length = 0;
    };
  }, []);

  return (
    <ToastContext.Provider value={{ pushToast }}>
      {children}
      <Toasts toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}
