import { formatRemoteDriveError } from './errorMessages';
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

export interface RemoteDriveStatus {
  id: string;
  state: RemoteDriveState;
  mountPath?: string | null;
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

export const REMOTE_DRIVE_CONNECT_ATTEMPTS = 3;
export const REMOTE_DRIVE_CONNECT_BACKOFF_MS = [0, 250, 500] as const;

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function isRemoteDriveConnectRetryable(error: unknown, state?: RemoteDriveState): boolean {
  if (state === 'approval-required') return false;
  return formatRemoteDriveError(error).retryable;
}

export async function connectRemoteDriveWithBackoff(
  profileId: string,
  attempt: () => Promise<RemoteDriveStatus>,
  options?: {
    sleep?: (ms: number) => Promise<void>;
    attempts?: number;
    backoffMs?: readonly number[];
  }
): Promise<RemoteDriveStatus> {
  const attempts = options?.attempts ?? REMOTE_DRIVE_CONNECT_ATTEMPTS;
  const backoffMs = options?.backoffMs ?? REMOTE_DRIVE_CONNECT_BACKOFF_MS;
  const wait = options?.sleep ?? sleep;
  let lastError: unknown;

  for (let index = 0; index < attempts; index += 1) {
    const delay = backoffMs[Math.min(index, Math.max(backoffMs.length - 1, 0))] ?? 0;
    if (index > 0 && delay > 0) {
      await wait(delay);
    }
    try {
      const status = await attempt();
      if (status.state !== 'error') {
        return status;
      }
      lastError = status.error;
      if (!isRemoteDriveConnectRetryable(status.error, status.state) || index === attempts - 1) {
        return status;
      }
    } catch (error) {
      lastError = error;
      if (!isRemoteDriveConnectRetryable(error) || index === attempts - 1) {
        return {
          id: profileId,
          state: 'error',
          error: formatRemoteDriveError(error).technical || 'An unexpected error occurred',
        };
      }
    }
  }

  return {
    id: profileId,
    state: 'error',
    error: formatRemoteDriveError(lastError).technical || 'An unexpected error occurred',
  };
}
