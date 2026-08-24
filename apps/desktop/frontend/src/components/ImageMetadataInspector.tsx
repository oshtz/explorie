import React from 'react';
import { readFile } from '@tauri-apps/plugin-fs';
import { formatLocalDateTime } from '../utils/date';
import {
  formatExifDate,
  formatGps,
  hasPhotoMetadata,
  parseImageMetadata,
  type ImageMetadata,
} from '../utils/imageMetadata';
import styles from './ImageMetadataInspector.module.css';

type ImageMetadataInspectorProps = {
  path: string;
  metadata?: ImageMetadata;
};

function toBytes(data: Uint8Array | ArrayBuffer | number[]): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data);
  return new Uint8Array(data);
}

export function ImageMetadataInspector({ path, metadata }: ImageMetadataInspectorProps) {
  const [loaded, setLoaded] = React.useState<ImageMetadata | null>(metadata ?? null);

  React.useEffect(() => {
    if (metadata) {
      setLoaded(metadata);
      return;
    }

    let cancelled = false;
    setLoaded(null);

    readFile(path)
      .then((data) => {
        if (cancelled) return;
        setLoaded(parseImageMetadata(toBytes(data)));
      })
      .catch(() => {
        if (!cancelled) setLoaded({});
      });

    return () => {
      cancelled = true;
    };
  }, [path, metadata]);

  if (!loaded) return null;

  return (
    <section className={styles.photoSection} aria-label="Photo metadata">
      <h3 className={styles.heading}>Photo</h3>
      {hasPhotoMetadata(loaded) ? (
        <>
          <div className={styles.fields}>
            {loaded.camera && (
              <>
                <div className={styles.label}>Camera:</div>
                <div className={styles.value}>{loaded.camera}</div>
              </>
            )}
            {loaded.date && (
              <>
                <div className={styles.label}>Taken:</div>
                <div className={styles.value}>
                  {formatLocalDateTime(formatExifDate(loaded.date))}
                </div>
              </>
            )}
            {loaded.width && loaded.height && (
              <>
                <div className={styles.label}>Dimensions:</div>
                <div className={styles.value}>
                  {loaded.width} × {loaded.height}
                </div>
              </>
            )}
            {loaded.caption && (
              <>
                <div className={styles.label}>Caption:</div>
                <div className={styles.value}>{loaded.caption}</div>
              </>
            )}
            {loaded.keywords && loaded.keywords.length > 0 && (
              <>
                <div className={styles.label}>Keywords:</div>
                <div className={styles.value}>{loaded.keywords.join(', ')}</div>
              </>
            )}
          </div>
          {loaded.gps && (
            <details className={styles.gps}>
              <summary>Show location</summary>
              <div className={styles.gpsCoords}>{formatGps(loaded.gps)}</div>
            </details>
          )}
        </>
      ) : (
        <div className={styles.empty} role="status">
          No camera or caption metadata
        </div>
      )}
    </section>
  );
}
