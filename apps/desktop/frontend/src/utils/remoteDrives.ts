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
