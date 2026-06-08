// Utilities to robustly parse and format modified dates coming from the backend.

// Try to parse various inputs to a millisecond timestamp.
export function parseToMs(input: unknown): number | null {
  if (input == null) return null;

  // If it's already a Date
  if (input instanceof Date) {
    const t = input.getTime();
    return Number.isFinite(t) ? t : null;
  }

  // If it's a number (seconds or milliseconds)
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return null;
    // Heuristic: if less than 10^12, treat as seconds
    const ms = input < 1_000_000_000_000 ? input * 1000 : input;
    return Number.isFinite(ms) ? ms : null;
  }

  // If it's a string
  if (typeof input === 'string') {
    const s = input.trim();
    if (!s) return null;

    // Pure digits: treat as epoch (seconds or ms)
    if (/^\d+$/.test(s)) {
      const n = Number(s);
      if (!Number.isFinite(n)) return null;
      const ms = n < 1_000_000_000_000 ? n * 1000 : n;
      return Number.isFinite(ms) ? ms : null;
    }

    // Common non-ISO "YYYY-MM-DD HH:mm:ss" -> convert to ISO-ish
    // Add 'T' between date and time if missing
    let candidate = s;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) {
      candidate = s.replace(' ', 'T');
    }

    // Attempt Date.parse
    const t = Date.parse(candidate);
    if (Number.isFinite(t)) return t;

    // As a last resort, try appending 'Z' (treat as UTC) if there's a time but no timezone
    if (/T\d{2}:\d{2}/.test(candidate) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(candidate)) {
      const t2 = Date.parse(candidate + 'Z');
      if (Number.isFinite(t2)) return t2;
    }
  }

  // If it's an object, try common wire formats
  if (typeof input === 'object') {
    try {
      const obj = input as Record<string, unknown>;

      // Direct millis fields
      if (typeof obj.ms === 'number' && Number.isFinite(obj.ms)) return obj.ms;
      if (typeof obj.millis === 'number' && Number.isFinite(obj.millis)) return obj.millis;

      // Rust std::time::SystemTime via serde usually serializes as secs_since_epoch/nanos_since_epoch
      // Handle both top-level and one-level nested (e.g., { Positive: { secs_since_epoch, nanos_since_epoch } })
      const tryFromEpochFields = (o: unknown): number | null => {
        if (!o || typeof o !== 'object') return null;
        const record = o as Record<string, unknown>;
        const secs = record.secs_since_epoch ?? record.secs ?? record.seconds ?? record.sec;
        const nanos =
          record.nanos_since_epoch ?? record.nanos ?? record.nanoseconds ?? record.nsec ?? 0;
        const s = typeof secs === 'string' ? Number(secs) : secs;
        const n = typeof nanos === 'string' ? Number(nanos) : nanos;
        if (typeof s === 'number' && Number.isFinite(s)) {
          const ms = s * 1000 + (typeof n === 'number' && Number.isFinite(n) ? n / 1_000_000 : 0);
          return Number.isFinite(ms) ? ms : null;
        }
        return null;
      };

      // Top-level epoch fields
      const top = tryFromEpochFields(obj);
      if (top != null) return top;

      // One-level nested object with epoch fields
      for (const k of Object.keys(obj)) {
        const nested = tryFromEpochFields(obj[k]);
        if (nested != null) return nested;
      }

      // Fall back: if object has a toString that yields a parseable date
      const str = String(obj);
      const t = Date.parse(str);
      if (Number.isFinite(t)) return t;
    } catch {
      // ignore object parsing errors
    }
  }

  return null;
}

export function formatLocalDateTime(input: unknown): string {
  const ms = parseToMs(input);
  if (ms == null) return '-';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleString();
}

export function formatLocalDate(input: unknown): string {
  const ms = parseToMs(input);
  if (ms == null) return '-';
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '-';
  return d.toLocaleDateString();
}
