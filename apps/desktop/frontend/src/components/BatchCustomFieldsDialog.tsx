import { useEffect, useMemo, useState } from 'react';
import type { FileEntry } from '../store';
import {
  getCustomFieldsSchema,
  updateCustomFieldsBatch,
  type CustomFieldsSchema,
} from '../utils/fs';
import {
  type CustomFields,
  type CustomFieldDefinition,
  type CustomFieldSchema,
  type CustomFieldValue,
  parseCustomFieldInput,
  validateCustomFields,
} from '../utils/customFieldTypes';
import styles from './BatchCustomFieldsDialog.module.css';

interface BatchCustomFieldsDialogProps {
  files: FileEntry[];
  onClose: () => void;
  onApplied?: () => void | Promise<void>;
  /** Pass a schema when the caller already loaded one for every selected file. */
  schema?: CustomFieldSchema | null;
}

function splitFilePath(filePath: string): { dirPath: string; fileName: string } {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const dirPath =
    lastSlash < 0
      ? '.'
      : lastSlash === 0
        ? filePath.slice(0, 1)
        : lastSlash === 2 && filePath[1] === ':'
          ? filePath.slice(0, 3)
          : filePath.slice(0, lastSlash);
  return {
    dirPath,
    fileName: filePath.slice(lastSlash + 1),
  };
}

function inputTypeFor(definition?: CustomFieldDefinition): string {
  switch (definition?.type) {
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'url':
      return 'url';
    default:
      return 'text';
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'The custom field value is invalid';
}

function readSchema(dirPath: string): Promise<CustomFieldSchema | null> {
  // Keep the dialog usable in web-only tests/dev mocks that do not expose
  // native commands; the native app always provides this function.
  return typeof getCustomFieldsSchema === 'function'
    ? getCustomFieldsSchema(dirPath)
    : Promise.resolve(null);
}

export function BatchCustomFieldsDialog({
  files,
  onClose,
  onApplied,
  schema: schemaProp,
}: BatchCustomFieldsDialogProps) {
  const [fieldName, setFieldName] = useState('');
  const [fieldValue, setFieldValue] = useState('');
  const [schemas, setSchemas] = useState<Record<string, CustomFieldSchema | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const directoryPaths = useMemo(
    () => [
      ...new Set(
        files.filter((file) => !file.is_dir).map((file) => splitFilePath(file.path).dirPath)
      ),
    ],
    [files]
  );

  useEffect(() => {
    let cancelled = false;
    if (schemaProp !== undefined) {
      setSchemas(Object.fromEntries(directoryPaths.map((path) => [path, schemaProp])));
      return;
    }

    void Promise.all(directoryPaths.map(async (path) => [path, await readSchema(path)] as const))
      .then((entries) => {
        if (!cancelled) setSchemas(Object.fromEntries(entries));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorMessage(reason));
      });

    return () => {
      cancelled = true;
    };
  }, [directoryPaths, schemaProp]);

  const definitionFor = (name: string): CustomFieldDefinition | undefined => {
    if (schemaProp?.fields[name]) return schemaProp.fields[name];
    return Object.values(schemas).find((candidate) => candidate?.fields[name])?.fields[name];
  };

  const renderValueInput = () => {
    const definition = definitionFor(fieldName.trim());
    if (definition?.type === 'enum' || definition?.type === 'boolean') {
      const values = definition.type === 'enum' ? (definition.values ?? []) : ['true', 'false'];
      return (
        <select
          id="batch-custom-field-value"
          value={fieldValue}
          onChange={(event) => setFieldValue(event.target.value)}
          aria-label="Value"
        >
          <option value="">Select a value</option>
          {values.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
      );
    }

    return (
      <input
        id="batch-custom-field-value"
        type={inputTypeFor(definition)}
        placeholder="Value"
        value={fieldValue}
        onChange={(event) => setFieldValue(event.target.value)}
        aria-label="Value"
      />
    );
  };

  const loadSchemasForApply = async (): Promise<Map<string, CustomFieldSchema | null>> => {
    if (schemaProp !== undefined) {
      return new Map(directoryPaths.map((path) => [path, schemaProp]));
    }

    const entries = await Promise.all(
      directoryPaths.map(async (path) => [path, await readSchema(path)] as const)
    );
    setSchemas(Object.fromEntries(entries));
    return new Map(entries);
  };

  const handleApply = async () => {
    const name = fieldName.trim();
    if (!name) return;

    setSaving(true);
    setError(null);
    try {
      const schemasForDirectory = await loadSchemasForApply();
      const groups = new Map<string, CustomFieldsSchema>();
      const validationErrors: string[] = [];

      for (const file of files) {
        if (file.is_dir) continue;
        const { dirPath, fileName } = splitFilePath(file.path);
        const directorySchema = schemasForDirectory.get(dirPath) ?? null;
        const definition = directorySchema?.fields[name];
        const value = definition
          ? parseCustomFieldInput(fieldValue, definition)
          : name.toLowerCase() === 'tags'
            ? [fieldValue]
            : fieldValue;
        const updatedFields: CustomFields = {
          ...(file.custom || {}),
          [name]: value as CustomFieldValue,
        };

        if (directorySchema) {
          const fieldErrors = validateCustomFields(updatedFields, directorySchema);
          for (const [field, reason] of Object.entries(fieldErrors)) {
            validationErrors.push(`${fileName}.${field}: ${reason}`);
          }
        }

        const updates = groups.get(dirPath) ?? {};
        updates[fileName] = updatedFields;
        groups.set(dirPath, updates);
      }

      if (validationErrors.length > 0) {
        setError(validationErrors.join('; '));
        return;
      }

      // One native write per directory keeps the core cache coherent.
      await Promise.all(
        [...groups.entries()].map(([dirPath, updates]) => updateCustomFieldsBatch(dirPath, updates))
      );
      await onApplied?.();
      onClose();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const inputDefinition = definitionFor(fieldName.trim());
  const inputHint = inputDefinition
    ? `Type: ${inputDefinition.type}${inputDefinition.required ? ' (required)' : ''}`
    : null;

  return (
    <div className={styles.backdrop} role="presentation">
      <section
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="batch-custom-fields-title"
      >
        <h2 id="batch-custom-fields-title">Edit Custom Fields</h2>
        <p className={styles.description}>
          Apply one field to {files.length} selected items. Each folder is written atomically.
        </p>
        <label className={styles.label} htmlFor="batch-custom-field-name">
          Field name
        </label>
        <input
          id="batch-custom-field-name"
          value={fieldName}
          onChange={(event) => setFieldName(event.target.value)}
          autoFocus
        />
        <label className={styles.label} htmlFor="batch-custom-field-value">
          Value
        </label>
        {renderValueInput()}
        {inputHint && <div className={styles.hint}>{inputHint}</div>}
        {error && (
          <div className={styles.error} role="alert" aria-live="polite">
            {error}
          </div>
        )}
        <div className={styles.actions}>
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" onClick={handleApply} disabled={saving || !fieldName.trim()}>
            {saving ? 'Saving…' : 'Apply to Selected'}
          </button>
        </div>
      </section>
    </div>
  );
}
