import { Icon } from './Icon';
import styles from './LocationRecoveryState.module.css';

type CommonProps = {
  choosingFolder: boolean;
  pickerError: string | null;
  onChooseFolder: () => void;
};

type StartupLocationStateProps = CommonProps & {
  initializationError: string | null;
  onEnterPath: () => void;
  onRetryInitialization: () => void;
};

type FolderLoadErrorStateProps = CommonProps & {
  path: string;
  error: string;
  onRetry: () => void;
};

export function StartupLocationState({
  initializationError,
  choosingFolder,
  pickerError,
  onChooseFolder,
  onEnterPath,
  onRetryInitialization,
}: StartupLocationStateProps) {
  return (
    <section className={styles.state} aria-labelledby="startup-location-title">
      <Icon name="folder" size={28} className={styles.icon} />
      <h1 id="startup-location-title" className={styles.title}>
        Choose a folder to get started
      </h1>
      <p className={styles.description}>Explorie needs a folder before it can show your files.</p>
      {initializationError && (
        <div className={styles.notice} role="alert">
          <span>{initializationError}</span>
          <button type="button" className={styles.linkButton} onClick={onRetryInitialization}>
            Retry locations
          </button>
        </div>
      )}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.primaryButton}
          onClick={onChooseFolder}
          disabled={choosingFolder}
          autoFocus
        >
          <Icon name="folder" size={14} />
          {choosingFolder ? 'Opening…' : 'Choose folder'}
        </button>
        <button type="button" className={styles.secondaryButton} onClick={onEnterPath}>
          Enter a path
        </button>
      </div>
      {pickerError && (
        <p className={styles.pickerError} role="alert">
          Couldn’t open the folder picker: {pickerError}
        </p>
      )}
    </section>
  );
}

export function FolderLoadErrorState({
  path,
  error,
  choosingFolder,
  pickerError,
  onRetry,
  onChooseFolder,
}: FolderLoadErrorStateProps) {
  return (
    <section
      className={`${styles.state} ${styles.errorState}`}
      role="alert"
      aria-labelledby="folder-error-title"
    >
      <Icon name="alert" size={28} className={styles.errorIcon} />
      <h1 id="folder-error-title" className={styles.title}>
        Couldn’t load this folder
      </h1>
      <p className={styles.path} title={path}>
        {path}
      </p>
      <p className={styles.description}>{error}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.primaryButton} onClick={onRetry}>
          <Icon name="reload" size={14} />
          Try again
        </button>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={onChooseFolder}
          disabled={choosingFolder}
        >
          {choosingFolder ? 'Opening…' : 'Choose another folder'}
        </button>
      </div>
      {pickerError && (
        <p className={styles.pickerError} role="alert">
          Couldn’t open the folder picker: {pickerError}
        </p>
      )}
    </section>
  );
}
