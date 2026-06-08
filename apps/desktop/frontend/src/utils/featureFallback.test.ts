import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isFeatureEnabled,
  recordFeatureFailure,
  recordFeatureSuccess,
  disableFeature,
  enableFeature,
  getDisabledFeatures,
  withFallback,
  withFallbackSync,
  resetAllFeatures,
  getFeatureStatus,
} from './featureFallback';

describe('featureFallback', () => {
  beforeEach(() => {
    resetAllFeatures();
  });

  describe('isFeatureEnabled', () => {
    it('returns true for features that have not failed', () => {
      expect(isFeatureEnabled('dirSize')).toBe(true);
      expect(isFeatureEnabled('thumbnail')).toBe(true);
    });

    it('returns false after feature is manually disabled', () => {
      disableFeature('dirSize', 'Test reason');
      expect(isFeatureEnabled('dirSize')).toBe(false);
    });
  });

  describe('recordFeatureFailure', () => {
    it('tracks failure count', () => {
      recordFeatureFailure('dirSize', new Error('Test error'));
      expect(getFeatureStatus('dirSize').failureCount).toBe(1);

      recordFeatureFailure('dirSize', new Error('Another error'));
      expect(getFeatureStatus('dirSize').failureCount).toBe(2);
    });

    it('auto-disables feature after 3 failures', () => {
      expect(isFeatureEnabled('dirSize')).toBe(true);

      recordFeatureFailure('dirSize', 'Error 1');
      recordFeatureFailure('dirSize', 'Error 2');
      expect(isFeatureEnabled('dirSize')).toBe(true);

      recordFeatureFailure('dirSize', 'Error 3');
      expect(isFeatureEnabled('dirSize')).toBe(false);
    });

    it('stores the last error message', () => {
      recordFeatureFailure('dirSize', new Error('The actual error'));
      expect(getFeatureStatus('dirSize').lastError).toBe('The actual error');
    });
  });

  describe('recordFeatureSuccess', () => {
    it('decrements failure count on success', () => {
      recordFeatureFailure('dirSize', 'Error');
      recordFeatureFailure('dirSize', 'Error');
      expect(getFeatureStatus('dirSize').failureCount).toBe(2);

      recordFeatureSuccess('dirSize');
      expect(getFeatureStatus('dirSize').failureCount).toBe(1);
    });

    it('does not go below zero', () => {
      recordFeatureSuccess('dirSize');
      recordFeatureSuccess('dirSize');
      expect(getFeatureStatus('dirSize').failureCount).toBe(0);
    });
  });

  describe('disableFeature/enableFeature', () => {
    it('can manually disable and enable features', () => {
      disableFeature('thumbnail', 'User disabled');
      expect(isFeatureEnabled('thumbnail')).toBe(false);
      expect(getFeatureStatus('thumbnail').disabledReason).toBe('User disabled');

      enableFeature('thumbnail');
      expect(isFeatureEnabled('thumbnail')).toBe(true);
      expect(getFeatureStatus('thumbnail').failureCount).toBe(0);
    });
  });

  describe('getDisabledFeatures', () => {
    it('returns empty array when no features disabled', () => {
      expect(getDisabledFeatures()).toEqual([]);
    });

    it('returns all disabled features', () => {
      disableFeature('dirSize', 'Reason 1');
      disableFeature('thumbnail', 'Reason 2');

      const disabled = getDisabledFeatures();
      expect(disabled).toHaveLength(2);
      expect(disabled).toContainEqual({ name: 'dirSize', reason: 'Reason 1' });
      expect(disabled).toContainEqual({ name: 'thumbnail', reason: 'Reason 2' });
    });
  });

  describe('withFallback', () => {
    it('returns function result on success', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await withFallback('dirSize', fn, 'fallback');

      expect(result).toBe('success');
      expect(fn).toHaveBeenCalled();
    });

    it('returns fallback on failure', async () => {
      const fn = vi.fn().mockRejectedValue(new Error('fail'));
      const result = await withFallback('dirSize', fn, 'fallback');

      expect(result).toBe('fallback');
    });

    it('returns fallback without calling fn when feature is disabled and not recovered', async () => {
      // Disable with a recent failure to prevent recovery
      recordFeatureFailure('dirSize', 'Error 1');
      recordFeatureFailure('dirSize', 'Error 2');
      recordFeatureFailure('dirSize', 'Error 3'); // This will auto-disable

      const fn = vi.fn().mockResolvedValue('success');
      const result = await withFallback('dirSize', fn, 'fallback');

      // Feature was just disabled, so cooldown hasn't passed - should use fallback
      expect(result).toBe('fallback');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('withFallbackSync', () => {
    it('returns function result on success', () => {
      const fn = vi.fn().mockReturnValue('success');
      const result = withFallbackSync('dirSize', fn, 'fallback');

      expect(result).toBe('success');
    });

    it('returns fallback on failure', () => {
      const fn = vi.fn().mockImplementation(() => {
        throw new Error('fail');
      });
      const result = withFallbackSync('dirSize', fn, 'fallback');

      expect(result).toBe('fallback');
    });
  });

  describe('resetAllFeatures', () => {
    it('clears all feature states', () => {
      disableFeature('dirSize', 'Test');
      recordFeatureFailure('thumbnail', 'Error');

      resetAllFeatures();

      expect(isFeatureEnabled('dirSize')).toBe(true);
      expect(getFeatureStatus('thumbnail').failureCount).toBe(0);
    });
  });
});
