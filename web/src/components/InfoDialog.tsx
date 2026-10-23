import { useRef } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { classNames } from '../lib/utils';

interface InfoDialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  className?: string;
}

/** 首页「更多」菜单里的小型信息弹窗（键盘快捷键 / 关于），沿用 Material 深色样式。 */
export function InfoDialog({ open, title, onClose, children, testId, className }: InfoDialogProps) {
  const reduce = useReducedMotion();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useDialogA11y({ open, onClose, panelRef, initialFocusRef: closeButtonRef });

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="m-layer"
          key="info-dialog-layer"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reduce ? 0 : 0.15, ease: 'easeOut' }}
        >
          <div className="m-scrim" onClick={onClose} aria-hidden="true" />
          <motion.div
            ref={panelRef}
            className={classNames('m-dialog', 'info-dialog', className)}
            role="dialog"
            aria-modal="true"
            aria-labelledby="info-dialog-title"
            data-testid={testId}
            tabIndex={-1}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: reduce ? 0 : 0.2, ease: 'easeOut' }}
          >
            <header className="m-dialog__header">
              <h2 id="info-dialog-title" className="m-dialog__title">
                {title}
              </h2>
              <button
                ref={closeButtonRef}
                type="button"
                className="icon-btn"
                onClick={onClose}
                aria-label="关闭"
                title="关闭"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </header>
            <div className="info-dialog__body">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
