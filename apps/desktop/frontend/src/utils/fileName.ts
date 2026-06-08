const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WINDOWS_INVALID_CHARS = /[<>:"/\\|?*\x00-\x1F]/;

export type FileNameValidation = { valid: true } | { valid: false; reason: string };

export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /windows/i.test(navigator.userAgent);
}

export function validateFileName(name: string): FileNameValidation {
  const trimmed = name.trim();

  if (!trimmed) {
    return { valid: false, reason: 'Name cannot be empty' };
  }

  if (trimmed === '.' || trimmed === '..') {
    return { valid: false, reason: 'Name cannot be . or ..' };
  }

  if (trimmed.includes('\0')) {
    return { valid: false, reason: 'Name cannot contain null characters' };
  }

  if (/[\\/]/.test(trimmed)) {
    return { valid: false, reason: 'Name cannot contain path separators' };
  }

  if (isWindowsPlatform()) {
    if (WINDOWS_INVALID_CHARS.test(trimmed)) {
      return { valid: false, reason: 'Name contains invalid characters' };
    }

    if (/[. ]$/.test(trimmed)) {
      return { valid: false, reason: 'Name cannot end with a period or space' };
    }

    if (WINDOWS_RESERVED_NAMES.test(trimmed)) {
      return { valid: false, reason: 'Name is reserved on Windows' };
    }
  }

  return { valid: true };
}
