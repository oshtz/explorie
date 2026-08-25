import { getJsonWithDefault, setJson } from './localStorage';

export interface RemoteDriveProfile {
  id: string;
  name: string;
  remote: string;
  remotePath: string;
  mountTarget: string;
}

export type RemoteDriveState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'disconnecting'
  | 'approval-required'
  | 'error';

export type RemoteDriveLifecycleState = RemoteDriveState | 'hung';

export interface RemoteDriveStatus {
  id: string;
  state: RemoteDriveState;
  mountPath?: string | null;
  message?: string | null;
  error?: string | null;
}

export interface RemoteDriveEnvironment {
  platform: string;
  rcloneAvailable: boolean;
  rcloneVersion?: string | null;
  winfspAvailable?: boolean | null;
  helperStatus?: string | null;
  occupiedMountTargets: string[];
  error?: string | null;
}

export interface DisconnectResult {
  status: RemoteDriveStatus;
  pendingUploads: number;
  erroredFiles: number;
  blocked: boolean;
}

export interface RemoteDriveExitBlocker {
  pendingUploads: number;
  erroredFiles: number;
  error?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const REMOTE_DRIVE_CONNECTING_HUNG_AFTER_MS = 30_000;

const DEFAULT_STATUS_MESSAGES: Record<RemoteDriveState, string> = {
  disconnected: 'Disconnected. Select the drive to try the mount again.',
  connecting:
    'Connecting to the remote. Transient mount failures will be retried; select the drive again if it still fails.',
  connected:
    'Connected. Select the drive to browse its files, or use Disconnect to stop the mount.',
  disconnecting: 'Disconnecting and checking pending remote writes. Please wait.',
  'approval-required':
    'Approve the Explorie Remote Drives helper in macOS System Settings, then try again.',
  error:
    'Remote drive mount failed. Check the remote configuration and network connection, then try again.',
};

const LIFECYCLE_LABELS: Record<RemoteDriveLifecycleState, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting',
  connected: 'Connected',
  disconnecting: 'Disconnecting',
  'approval-required': 'Approval required',
  error: 'Failed',
  hung: 'Still connecting',
};

export function getRemoteDriveStatusMessage(
  status: Pick<RemoteDriveStatus, 'state' | 'message' | 'error'>
): string {
  if (status.message?.trim()) return status.message;
  if (status.state === 'error' && status.error?.trim()) return status.error;
  return DEFAULT_STATUS_MESSAGES[status.state];
}

export interface RemoteDriveLifecycle {
  state: RemoteDriveLifecycleState;
  label: string;
  message: string;
}

export function getRemoteDriveLifecycle(
  status: RemoteDriveStatus,
  connectingSince?: number,
  now = Date.now()
): RemoteDriveLifecycle {
  if (
    status.state === 'connecting' &&
    connectingSince !== undefined &&
    now - connectingSince >= REMOTE_DRIVE_CONNECTING_HUNG_AFTER_MS
  ) {
    return {
      state: 'hung',
      label: LIFECYCLE_LABELS.hung,
      message:
        'The remote is taking longer than expected. Check the remote configuration and network, wait for the bounded retries to finish, then select the drive to try again.',
    };
  }
  return {
    state: status.state,
    label: LIFECYCLE_LABELS[status.state],
    message: getRemoteDriveStatusMessage(status),
  };
}

const sanitizeProfile = (value: unknown): RemoteDriveProfile | null => {
  if (!value || typeof value !== 'object') return null;
  const profile = value as Partial<RemoteDriveProfile>;
  const remotePath = profile.remotePath ?? '';
  if (
    typeof profile.id !== 'string' ||
    !UUID.test(profile.id) ||
    typeof profile.name !== 'string' ||
    typeof profile.remote !== 'string' ||
    typeof remotePath !== 'string' ||
    typeof profile.mountTarget !== 'string' ||
    profile.name.trim().length === 0 ||
    profile.remote.trim().length === 0
  ) {
    return null;
  }
  return {
    id: profile.id,
    name: profile.name,
    remote: profile.remote,
    remotePath,
    mountTarget: profile.mountTarget,
  };
};

export function loadRemoteDrives(): RemoteDriveProfile[] {
  return (getJsonWithDefault('explorie:remoteDrives', []) as unknown[])
    .map(sanitizeProfile)
    .filter((profile): profile is RemoteDriveProfile => profile !== null);
}

export function saveRemoteDrives(profiles: RemoteDriveProfile[]): boolean {
  return setJson(
    'explorie:remoteDrives',
    profiles
      .map(sanitizeProfile)
      .filter((profile): profile is RemoteDriveProfile => profile !== null)
  );
}
