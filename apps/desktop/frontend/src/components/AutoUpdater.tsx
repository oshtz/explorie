import React from 'react';
import { useUpdateStore } from '../updateStore';
import { isTauriRuntime } from '../services/updater';
import { ConfirmDialog } from './ConfirmDialog';
import { useToast } from './Toast';

export function AutoUpdater() {
  const loadCurrentVersion = useUpdateStore((s) => s.loadCurrentVersion);
  const checkNow = useUpdateStore((s) => s.checkNow);
  const downloadNow = useUpdateStore((s) => s.downloadNow);
  const installNow = useUpdateStore((s) => s.installNow);
  const status = useUpdateStore((s) => s.status);
  const updateInfo = useUpdateStore((s) => s.updateInfo);
  const error = useUpdateStore((s) => s.error);
  const clearError = useUpdateStore((s) => s.clearError);
  const { show: showToast } = useToast();

  const [promptOpen, setPromptOpen] = React.useState(false);
  const promptedVersionRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    loadCurrentVersion().catch(() => undefined);
  }, [loadCurrentVersion]);

  React.useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;

    const run = async () => {
      const info = await checkNow();
      if (!info || cancelled) return;
      await downloadNow(info);
    };

    run().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [checkNow, downloadNow]);

  React.useEffect(() => {
    if (status !== 'ready' || !updateInfo) return;
    if (promptedVersionRef.current === updateInfo.version) return;
    promptedVersionRef.current = updateInfo.version;
    setPromptOpen(true);
  }, [status, updateInfo]);

  React.useEffect(() => {
    if (status !== 'error' || !error) return;
    showToast(`Update failed: ${error}`, { type: 'error' });
    clearError();
  }, [status, error, showToast, clearError]);

  if (!updateInfo) return null;

  return (
    <ConfirmDialog
      open={promptOpen}
      title="Update ready"
      message={`explorie ${updateInfo.version} is ready to install. Restart to apply the update?`}
      confirmLabel="Restart now"
      cancelLabel="Later"
      onConfirm={() => {
        setPromptOpen(false);
        installNow().catch(() => undefined);
      }}
      onCancel={() => setPromptOpen(false)}
    />
  );
}
