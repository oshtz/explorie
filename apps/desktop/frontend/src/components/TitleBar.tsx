import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon } from './Icon';
import styles from './TitleBar.module.css';

export function getTitleBarState(platform: string | undefined, tauri: boolean) {
  const showTitleBar = platform !== 'macos';
  return { showTitleBar, showWindowControls: showTitleBar && tauri };
}

export function TitleBar({ showWindowControls = true }: { showWindowControls?: boolean }) {
  const appWindow = showWindowControls ? getCurrentWindow() : null;

  return (
    <header
      className={styles.titleBar}
      data-tauri-drag-region
      onDoubleClick={(event) => {
        if (appWindow && !(event.target as HTMLElement).closest('button')) {
          void appWindow.toggleMaximize();
        }
      }}
    >
      <img
        src="/icon-face.png"
        alt=""
        aria-hidden="true"
        draggable="false"
        className={styles.appIcon}
        data-tauri-drag-region
      />
      <span className={styles.appName} data-tauri-drag-region>
        explorie
      </span>
      <span className={styles.dragRegion} data-tauri-drag-region />
      {appWindow && (
        <div className={styles.windowControls}>
          <button
            type="button"
            className={styles.windowButton}
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => void appWindow.minimize()}
          >
            <Icon name="minus" />
          </button>
          <button
            type="button"
            className={styles.windowButton}
            aria-label="Maximize or restore window"
            title="Maximize or restore"
            onClick={() => void appWindow.toggleMaximize()}
          >
            <Icon name="frame" />
          </button>
          <button
            type="button"
            className={`${styles.windowButton} ${styles.closeButton}`}
            aria-label="Close window"
            title="Close"
            onClick={() => void appWindow.close()}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
    </header>
  );
}
