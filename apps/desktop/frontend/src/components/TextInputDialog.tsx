import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { createFocusTrap } from '../utils/accessibility';
import styles from './TextInputDialog.module.css';

type TextInputDialogProps = {
  open: boolean;
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  submitLabel?: string;
  validate?: (value: string) => string | null;
  onSubmit: (value: string) => void | Promise<void>;
  onCancel: () => void;
};

export function TextInputDialog({
  open,
  title,
  label,
  initialValue = '',
  placeholder,
  submitLabel = 'Save',
  validate,
  onSubmit,
  onCancel,
}: TextInputDialogProps) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusTrapRef = useRef<ReturnType<typeof createFocusTrap> | null>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    setValue(initialValue);
    setError(null);
    setSubmitting(false);
    const timer = setTimeout(() => inputRef.current?.select(), 0);
    const trap = dialogRef.current ? createFocusTrap(dialogRef.current) : null;
    focusTrapRef.current = trap;
    trap?.activate();
    return () => {
      clearTimeout(timer);
      focusTrapRef.current = null;
      trap?.deactivate();
    };
  }, [initialValue, open]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const clean = value.trim();
    const nextError = validate?.(clean) ?? (!clean ? `${label} is required` : null);
    if (nextError) {
      setError(nextError);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(clean);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className={styles.backdrop}
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={(event) => {
          focusTrapRef.current?.handleKeyDown(event);
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        <form onSubmit={submit}>
          <label htmlFor={`${id}-input`}>{label}</label>
          <input
            ref={inputRef}
            id={`${id}-input`}
            value={value}
            placeholder={placeholder}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(validate?.(event.target.value.trim()) ?? null);
            }}
            autoComplete="off"
          />
          {error && (
            <p id={`${id}-error`} className={styles.error} role="alert">
              {error}
            </p>
          )}
          <div className={styles.actions}>
            <button type="button" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" className={styles.primary} disabled={submitting}>
              {submitting ? 'Working…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
