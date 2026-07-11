import React, { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import styles from './ErrorBoundary.module.css';
import { Icon } from './Icon';

interface Props {
  children: ReactNode;
  /** Optional fallback UI to show when an error occurs */
  fallback?: ReactNode;
  /** Name of the section (for error reporting) */
  name?: string;
  /** Called when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

interface RootErrorBoundaryProps {
  children: ReactNode;
  onRestart?: () => void;
}

export class RootErrorBoundary extends Component<RootErrorBoundaryProps, State> {
  constructor(props: RootErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('RootErrorBoundary caught an app error:', error, errorInfo);
  }

  handleRestart = (): void => {
    if (this.props.onRestart) {
      this.props.onRestart();
      return;
    }
    window.location.reload();
  };

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children;

    return (
      <main className={styles.rootErrorContainer} role="alert">
        <Icon name="alert" size={32} />
        <h1 className={styles.rootErrorTitle}>Explorie couldn’t start</h1>
        <p className={styles.rootErrorMessage}>
          {this.state.error?.message || 'An unexpected error occurred while loading the app.'}
        </p>
        <button className={styles.retryButton} onClick={this.handleRestart}>
          <Icon name="reload" size={14} />
          <span>Restart Explorie</span>
        </button>
      </main>
    );
  }
}

/**
 * Error Boundary component that catches JavaScript errors anywhere in its
 * child component tree, logs those errors, and displays a fallback UI.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log error to console
    console.error(
      `ErrorBoundary caught error in ${this.props.name || 'component'}:`,
      error,
      errorInfo
    );

    // Call optional error handler
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // Custom fallback UI
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI
      return (
        <div className={styles.errorContainer}>
          <div className={styles.errorIcon}>
            <Icon name="alert" size={24} />
          </div>
          <div className={styles.errorTitle}>Something went wrong</div>
          <div className={styles.errorMessage}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </div>
          <button className={styles.retryButton} onClick={this.handleRetry}>
            <Icon name="reload" size={14} />
            <span>Try again</span>
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

/**
 * Minimal error boundary that just shows a simple inline error message.
 * Use this for smaller components where a full error UI would be too intrusive.
 */
export class InlineErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(`InlineErrorBoundary caught error:`, error, errorInfo);
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div className={styles.inlineError}>
          <span className={styles.inlineErrorText}>Error loading content</span>
          <button className={styles.inlineRetryButton} onClick={this.handleRetry}>
            Retry
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
