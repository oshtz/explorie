import React, { useCallback } from 'react';
import { useFileStore } from '../store';
import styles from './ThumbnailSizeSlider.module.css';

// Preset sizes with labels
const PRESETS = [
  { label: 'S', value: 120, title: 'Small (120px)' },
  { label: 'M', value: 160, title: 'Medium (160px)' },
  { label: 'L', value: 200, title: 'Large (200px)' },
  { label: 'XL', value: 260, title: 'Extra Large (260px)' },
];

const MIN_SIZE = 120;
const MAX_SIZE = 260;
const STEP = 10;

interface ThumbnailSizeSliderProps {
  compact?: boolean; // Show only slider without presets
}

export function ThumbnailSizeSlider({ compact = false }: ThumbnailSizeSliderProps) {
  const gridMinWidth = useFileStore((s) => s.gridMinWidth);
  const setGridMinWidth = useFileStore((s) => s.setGridMinWidth);

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = parseInt(e.target.value, 10);
      setGridMinWidth(value);
    },
    [setGridMinWidth]
  );

  const handlePresetClick = useCallback(
    (value: number) => {
      setGridMinWidth(value);
    },
    [setGridMinWidth]
  );

  // Find active preset (if any)
  const activePreset = PRESETS.find((p) => p.value === gridMinWidth);

  return (
    <div className={styles.container}>
      {!compact && (
        <div className={styles.presets}>
          {PRESETS.map((preset) => (
            <button
              key={preset.value}
              className={`${styles.presetButton} ${
                activePreset?.value === preset.value ? styles.presetActive : ''
              }`}
              onClick={() => handlePresetClick(preset.value)}
              title={preset.title}
            >
              {preset.label}
            </button>
          ))}
        </div>
      )}
      <div className={styles.sliderContainer}>
        <span className={styles.sizeIcon}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <rect x="4" y="4" width="6" height="6" rx="1" />
            <rect x="14" y="4" width="6" height="6" rx="1" />
            <rect x="4" y="14" width="6" height="6" rx="1" />
            <rect x="14" y="14" width="6" height="6" rx="1" />
          </svg>
        </span>
        <input
          type="range"
          className={styles.slider}
          min={MIN_SIZE}
          max={MAX_SIZE}
          step={STEP}
          value={gridMinWidth}
          onChange={handleSliderChange}
          title={`Thumbnail size: ${gridMinWidth}px`}
        />
        <span className={styles.sizeIcon}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <rect x="3" y="3" width="8" height="8" rx="1" />
            <rect x="13" y="3" width="8" height="8" rx="1" />
            <rect x="3" y="13" width="8" height="8" rx="1" />
            <rect x="13" y="13" width="8" height="8" rx="1" />
          </svg>
        </span>
      </div>
      {!compact && <span className={styles.sizeLabel}>{gridMinWidth}px</span>}
    </div>
  );
}

// Hook for keyboard shortcuts to adjust thumbnail size
export function useThumbnailSizeShortcuts() {
  const gridMinWidth = useFileStore((s) => s.gridMinWidth);
  const setGridMinWidth = useFileStore((s) => s.setGridMinWidth);

  const increase = useCallback(() => {
    const newValue = Math.min(MAX_SIZE, gridMinWidth + STEP);
    setGridMinWidth(newValue);
  }, [gridMinWidth, setGridMinWidth]);

  const decrease = useCallback(() => {
    const newValue = Math.max(MIN_SIZE, gridMinWidth - STEP);
    setGridMinWidth(newValue);
  }, [gridMinWidth, setGridMinWidth]);

  return { increase, decrease };
}

export default ThumbnailSizeSlider;
