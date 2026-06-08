import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { Icon } from './Icon';
import styles from './Toast.module.css';

// Toast types
export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  action?: ToastAction;
  duration?: number; // ms, 0 = no auto-dismiss
}

interface ToastContextValue {
  toasts: Toast[];
  show: (message: string, options?: Partial<Omit<Toast, 'id' | 'message'>>) => string;
  dismiss: (id: string) => void;
  dismissAll: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// Default durations based on type
const DEFAULT_DURATIONS: Record<ToastType, number> = {
  info: 4000,
  success: 4000,
  warning: 5000,
  error: 6000,
};

// Duration extension when toast has an action (like Undo)
const ACTION_DURATION_BONUS = 2000;

let toastIdCounter = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const show = useCallback(
    (message: string, options?: Partial<Omit<Toast, 'id' | 'message'>>): string => {
      const id = `toast-${++toastIdCounter}`;
      const type = options?.type ?? 'info';
      const baseDuration = options?.duration ?? DEFAULT_DURATIONS[type];
      const duration = options?.action ? baseDuration + ACTION_DURATION_BONUS : baseDuration;

      const toast: Toast = {
        id,
        message,
        type,
        action: options?.action,
        duration,
      };

      setToasts((prev) => [...prev, toast]);
      return id;
    },
    []
  );

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    setToasts([]);
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, show, dismiss, dismissAll }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}

// Individual toast item component
function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);
  const remainingRef = useRef(toast.duration ?? 0);
  const startTimeRef = useRef(Date.now());

  const handleDismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => onDismiss(toast.id), 200); // Match animation duration
  }, [toast.id, onDismiss]);

  const handleAction = useCallback(() => {
    if (toast.action) {
      toast.action.onClick();
      handleDismiss();
    }
  }, [toast.action, handleDismiss]);

  // Auto-dismiss timer
  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return;

    const startTimer = () => {
      startTimeRef.current = Date.now();
      timerRef.current = setTimeout(() => {
        handleDismiss();
      }, remainingRef.current);
    };

    startTimer();

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, [toast.duration, handleDismiss]);

  // Pause timer on hover
  const handleMouseEnter = useCallback(() => {
    if (!toast.duration || toast.duration <= 0) return;
    pausedRef.current = true;
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      remainingRef.current -= Date.now() - startTimeRef.current;
    }
  }, [toast.duration]);

  const handleMouseLeave = useCallback(() => {
    if (!toast.duration || toast.duration <= 0 || !pausedRef.current) return;
    pausedRef.current = false;
    if (remainingRef.current > 0) {
      startTimeRef.current = Date.now();
      timerRef.current = setTimeout(() => {
        handleDismiss();
      }, remainingRef.current);
    }
  }, [toast.duration, handleDismiss]);

  const iconName = {
    info: 'info-box',
    success: 'checkbox-on',
    warning: 'alert',
    error: 'close-box',
  }[toast.type];

  return (
    <div
      className={`${styles.toast} ${exiting ? styles.exiting : ''}`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      role="alert"
      aria-live="polite"
    >
      <span className={`${styles.icon} ${styles[toast.type]}`}>
        <Icon name={iconName} size={18} />
      </span>
      <div className={styles.content}>
        <span className={styles.message}>{toast.message}</span>
      </div>
      <div className={styles.actions}>
        {toast.action && (
          <button className={styles.actionButton} onClick={handleAction}>
            {toast.action.label}
          </button>
        )}
        <button className={styles.dismissButton} onClick={handleDismiss} aria-label="Dismiss">
          <Icon name="close" size={14} />
        </button>
      </div>
    </div>
  );
}

// Toast container component
function ToastContainer({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className={styles.toastContainer} aria-label="Notifications">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

export default ToastProvider;
