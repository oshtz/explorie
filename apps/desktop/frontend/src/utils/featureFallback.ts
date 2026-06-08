/* eslint-disable no-console */
/**
 * Feature fallback system for graceful degradation.
 * Tracks which features have failed and provides fallback behavior.
 */

type FeatureName =
  | 'dirSize'
  | 'thumbnail'
  | 'archivePreview'
  | 'quickLook'
  | 'autoUpdate'
  | 'customFields'
  | 'smartFolders'
  | 'pluginHost';

interface FeatureStatus {
  enabled: boolean;
  failureCount: number;
  lastError?: string;
  lastFailureTime?: number;
  disabledReason?: string;
}

interface FeatureFallbackState {
  features: Map<FeatureName, FeatureStatus>;
}

const state: FeatureFallbackState = {
  features: new Map(),
};

// Default all features to enabled
const defaultFeatureStatus: FeatureStatus = {
  enabled: true,
  failureCount: 0,
};

// Maximum failures before auto-disabling a feature
const MAX_FAILURES_BEFORE_DISABLE = 3;

// Time in ms before a disabled feature can be re-enabled (5 minutes)
const RECOVERY_COOLDOWN = 5 * 60 * 1000;

/**
 * Get the status of a feature
 */
export function getFeatureStatus(feature: FeatureName): FeatureStatus {
  return state.features.get(feature) || { ...defaultFeatureStatus };
}

/**
 * Check if a feature is currently enabled
 */
export function isFeatureEnabled(feature: FeatureName): boolean {
  const status = getFeatureStatus(feature);
  return status.enabled;
}

/**
 * Record a feature failure. If failures exceed threshold, the feature is auto-disabled.
 */
export function recordFeatureFailure(feature: FeatureName, error?: unknown): void {
  const current = getFeatureStatus(feature);
  const errorMessage = error instanceof Error ? error.message : String(error || 'Unknown error');

  const newStatus: FeatureStatus = {
    ...current,
    failureCount: current.failureCount + 1,
    lastError: errorMessage,
    lastFailureTime: Date.now(),
  };

  // Auto-disable if too many failures
  if (newStatus.failureCount >= MAX_FAILURES_BEFORE_DISABLE) {
    newStatus.enabled = false;
    newStatus.disabledReason = `Auto-disabled after ${newStatus.failureCount} failures. Last error: ${errorMessage}`;
    console.warn(`Feature "${feature}" auto-disabled:`, newStatus.disabledReason);
  }

  state.features.set(feature, newStatus);
}

/**
 * Record a successful use of a feature, reducing failure count.
 */
export function recordFeatureSuccess(feature: FeatureName): void {
  const current = getFeatureStatus(feature);
  if (current.failureCount > 0) {
    state.features.set(feature, {
      ...current,
      failureCount: Math.max(0, current.failureCount - 1),
    });
  }
}

/**
 * Attempt to re-enable a disabled feature.
 */
export function tryReenableFeature(feature: FeatureName): boolean {
  const current = getFeatureStatus(feature);

  if (current.enabled) {
    return true; // Already enabled
  }

  // Check if enough time has passed
  const timeSinceLastFailure = current.lastFailureTime
    ? Date.now() - current.lastFailureTime
    : Infinity;

  if (timeSinceLastFailure >= RECOVERY_COOLDOWN) {
    state.features.set(feature, {
      ...current,
      enabled: true,
      failureCount: 0, // Reset failure count on re-enable
      disabledReason: undefined,
    });
    console.info(`Feature "${feature}" re-enabled after cooldown`);
    return true;
  }

  return false;
}

/**
 * Manually disable a feature (e.g., user preference or detected incompatibility)
 */
export function disableFeature(feature: FeatureName, reason: string): void {
  const current = getFeatureStatus(feature);
  state.features.set(feature, {
    ...current,
    enabled: false,
    disabledReason: reason,
  });
  console.info(`Feature "${feature}" manually disabled:`, reason);
}

/**
 * Manually enable a feature (override auto-disable)
 */
export function enableFeature(feature: FeatureName): void {
  const current = getFeatureStatus(feature);
  state.features.set(feature, {
    ...current,
    enabled: true,
    failureCount: 0,
    disabledReason: undefined,
  });
  console.info(`Feature "${feature}" manually enabled`);
}

/**
 * Get a list of all disabled features
 */
export function getDisabledFeatures(): Array<{ name: FeatureName; reason: string }> {
  const disabled: Array<{ name: FeatureName; reason: string }> = [];
  for (const [name, status] of state.features) {
    if (!status.enabled) {
      disabled.push({ name, reason: status.disabledReason || 'Unknown' });
    }
  }
  return disabled;
}

/**
 * Wrap an async function with fallback behavior.
 * If the function fails repeatedly, it will stop being called and use the fallback instead.
 */
export async function withFallback<T>(
  feature: FeatureName,
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  // Check if feature is disabled
  if (!isFeatureEnabled(feature)) {
    // Try to re-enable if cooldown passed
    tryReenableFeature(feature);
    if (!isFeatureEnabled(feature)) {
      return fallback;
    }
  }

  try {
    const result = await fn();
    recordFeatureSuccess(feature);
    return result;
  } catch (error) {
    recordFeatureFailure(feature, error);
    return fallback;
  }
}

/**
 * Sync version of withFallback for synchronous operations
 */
export function withFallbackSync<T>(feature: FeatureName, fn: () => T, fallback: T): T {
  if (!isFeatureEnabled(feature)) {
    tryReenableFeature(feature);
    if (!isFeatureEnabled(feature)) {
      return fallback;
    }
  }

  try {
    const result = fn();
    recordFeatureSuccess(feature);
    return result;
  } catch (error) {
    recordFeatureFailure(feature, error);
    return fallback;
  }
}

/**
 * Reset all feature states (useful for testing or user-triggered reset)
 */
export function resetAllFeatures(): void {
  state.features.clear();
  console.info('All feature states reset');
}

export default {
  isFeatureEnabled,
  recordFeatureFailure,
  recordFeatureSuccess,
  disableFeature,
  enableFeature,
  getDisabledFeatures,
  withFallback,
  withFallbackSync,
  resetAllFeatures,
};
