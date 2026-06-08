import { getCurrentWindow } from '@tauri-apps/api/window';

import './index.css';
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

// If the window starts hidden, show it after first paint
try {
  if (hasTauriInternals()) {
    requestAnimationFrame(() => {
      try {
        getCurrentWindow()
          .show()
          .catch(() => {
            /* ignore if already visible or lacks permission */
          });
      } catch {
        /* ignore outside Tauri */
      }
    });
  }
} catch {}
