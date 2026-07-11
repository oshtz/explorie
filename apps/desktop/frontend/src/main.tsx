import React from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';

import App from './App';
import { RootErrorBoundary } from './components/ErrorBoundary';
import './index.css';

function hasTauriInternals(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export async function bootstrap() {
  let platform = 'web';
  if (hasTauriInternals()) {
    try {
      platform = await invoke<string>('get_platform');
    } catch {
      platform = 'unknown';
    }
  }

  document.documentElement.dataset.platform = platform;
  const rootElement = document.getElementById('root');
  if (!rootElement) throw new Error('Explorie root element was not found');

  createRoot(rootElement).render(
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  );

  if (hasTauriInternals()) {
    requestAnimationFrame(() => {
      void getCurrentWindow()
        .show()
        .catch(() => {});
    });
  }
}

export function renderBootstrapFailure(error: unknown): void {
  const rootElement = document.getElementById('root');
  if (!rootElement) return;

  const container = document.createElement('main');
  container.className = 'bootstrapError';
  container.setAttribute('role', 'alert');

  const title = document.createElement('h1');
  title.textContent = 'Explorie couldn’t start';

  const detail = document.createElement('p');
  detail.textContent =
    error instanceof Error ? error.message : 'An unexpected startup error occurred.';

  const restart = document.createElement('button');
  restart.type = 'button';
  restart.textContent = 'Restart Explorie';
  restart.addEventListener('click', () => window.location.reload());

  container.append(title, detail, restart);
  rootElement.replaceChildren(container);
}

void bootstrap().catch(renderBootstrapFailure);
