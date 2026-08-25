import { invoke } from '@tauri-apps/api/core';
import { useEffect, useMemo, useState } from 'react';
import styles from './Preview.module.css';

type MetadataField = {
  key: string;
  label: string;
  value: string;
  editable: boolean;
};

type ImageMetadata = {
  format: string;
  supported: boolean;
  width: number | null;
  height: number | null;
  exif: MetadataField[];
  iptc: MetadataField[];
};

type MetadataUpdate = {
  key: string;
  value: string;
};

type ImageMetadataEditorProps = {
  path: string;
};

const EDITABLE_FIELDS = [
  { key: 'exif:GENERIC:010E', label: 'Description' },
  { key: 'exif:GENERIC:010F', label: 'Make' },
  { key: 'exif:GENERIC:0110', label: 'Model' },
  { key: 'exif:GENERIC:0131', label: 'Software' },
  { key: 'exif:GENERIC:0132', label: 'Modify Date' },
  { key: 'exif:GENERIC:013B', label: 'Artist' },
  { key: 'exif:GENERIC:8298', label: 'Copyright' },
  { key: 'exif:EXIF:9003', label: 'Date/Time Original' },
  { key: 'exif:EXIF:9004', label: 'Create Date' },
  { key: 'iptc:2:5', label: 'IPTC Object Name' },
  { key: 'iptc:2:25', label: 'IPTC Keywords' },
  { key: 'iptc:2:80', label: 'IPTC Creator' },
  { key: 'iptc:2:105', label: 'IPTC Headline' },
  { key: 'iptc:2:116', label: 'IPTC Copyright Notice' },
  { key: 'iptc:2:120', label: 'IPTC Caption' },
] as const;

function fieldValues(metadata: ImageMetadata): Record<string, string> {
  return Object.fromEntries(
    [...metadata.exif, ...metadata.iptc].map((field) => [field.key, field.value])
  );
}

function MetadataList({ fields }: { fields: MetadataField[] }) {
  if (fields.length === 0) {
    return <div className={styles.imageMetadataEmpty}>No metadata found.</div>;
  }

  return (
    <dl className={styles.imageMetadataList}>
      {fields.map((field) => (
        <div key={field.key} className={styles.imageMetadataRow}>
          <dt>{field.label}</dt>
          <dd>{field.value || '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ImageMetadataEditor({ path }: ImageMetadataEditorProps) {
  const [metadata, setMetadata] = useState<ImageMetadata | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setStatus(null);
    setMetadata(null);

    invoke<ImageMetadata>('read_image_metadata', { path })
      .then((result) => {
        if (cancelled) return;
        setMetadata(result);
        setValues(fieldValues(result));
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [path]);

  const editableUpdates = useMemo<MetadataUpdate[]>(
    () => EDITABLE_FIELDS.map(({ key }) => ({ key, value: values[key] ?? '' })),
    [values]
  );

  const save = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const result = await invoke<ImageMetadata>('write_image_metadata', {
        path,
        updates: editableUpdates,
      });
      setMetadata(result);
      setValues(fieldValues(result));
      setStatus('Metadata saved.');
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className={styles.imageMetadataState}>Loading image metadata…</div>;
  }

  if (error && !metadata) {
    return (
      <div className={styles.imageMetadataState} role="alert">
        Unable to read image metadata: {error}
      </div>
    );
  }

  if (!metadata) return null;

  if (!metadata.supported) {
    return (
      <div className={styles.imageMetadata}>
        <div className={styles.imageMetadataHeader}>
          <span>Image metadata</span>
        </div>
        <div className={styles.imageMetadataEmpty}>
          This image type does not carry EXIF or IPTC metadata.
        </div>
      </div>
    );
  }

  const dimensions =
    metadata.width !== null && metadata.height !== null
      ? `${metadata.width} × ${metadata.height}`
      : 'Unknown';
  const isEmpty = metadata.exif.length === 0 && metadata.iptc.length === 0;

  return (
    <div className={styles.imageMetadata}>
      <div className={styles.imageMetadataHeader}>
        <span>Image metadata</span>
        <span className={styles.imageMetadataFormat}>{metadata.format}</span>
      </div>

      <dl className={styles.imageMetadataList}>
        <div className={styles.imageMetadataRow}>
          <dt>Dimensions</dt>
          <dd>{dimensions}</dd>
        </div>
      </dl>

      {isEmpty && (
        <div className={styles.imageMetadataEmpty}>
          This image has no EXIF or IPTC metadata yet. Fill in a field below to add some.
        </div>
      )}

      <div className={styles.imageMetadataEditor}>
        <div className={styles.imageMetadataGroupTitle}>Editable fields</div>
        {EDITABLE_FIELDS.map(({ key, label }) => (
          <label key={key} className={styles.imageMetadataInputRow}>
            <span>{label}</span>
            <input
              type="text"
              value={values[key] ?? ''}
              onChange={(event) =>
                setValues((current) => ({ ...current, [key]: event.target.value }))
              }
              aria-label={label}
            />
          </label>
        ))}
        <button type="button" className={styles.imageMetadataSave} onClick={save} disabled={saving}>
          {saving ? 'Saving…' : 'Save metadata'}
        </button>
        {status && (
          <div className={styles.imageMetadataStatus} role="status">
            {status}
          </div>
        )}
        {error && (
          <div className={styles.imageMetadataError} role="alert">
            {error}
          </div>
        )}
      </div>

      <section className={styles.imageMetadataGroup} aria-labelledby="image-metadata-exif">
        <h3 id="image-metadata-exif">EXIF</h3>
        <MetadataList fields={metadata.exif} />
      </section>

      <section className={styles.imageMetadataGroup} aria-labelledby="image-metadata-iptc">
        <h3 id="image-metadata-iptc">IPTC</h3>
        <MetadataList fields={metadata.iptc} />
      </section>
    </div>
  );
}
