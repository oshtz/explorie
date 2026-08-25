import React, { useState, useEffect, useRef } from 'react';
import type { FileEntry } from '../store';
import { getCustomFieldsSchema, updateCustomFields } from '../utils/fs';
import { useToast } from './Toast';
import { reportError } from '../utils/errorReporter';
import styles from './CustomFieldsEditor.module.css';
import {
  type CustomFields,
  type CustomFieldDefinition,
  type CustomFieldSchema,
  type CustomFieldValue,
  FIELD_SUGGESTIONS,
  formatCustomFieldInput,
  getValueSuggestions,
  parseCustomFieldInput,
  validateCustomFields,
} from '../utils/customFieldTypes';

interface CustomFieldsEditorProps {
  file: FileEntry;
  onUpdate?: (updatedFile: FileEntry) => void;
  /** Pass a schema when the caller already loaded the directory metadata. */
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
  return { dirPath, fileName: filePath.slice(lastSlash + 1) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'The custom field value is invalid';
}

function validationSummary(errors: Record<string, string>): string {
  const [field, reason] = Object.entries(errors)[0] ?? [];
  return field && reason ? `${field}: ${reason}` : 'The custom field values are invalid';
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

function readSchema(dirPath: string): Promise<CustomFieldSchema | null> {
  // Keep the editor usable in web-only tests/dev mocks that do not expose
  // native commands; the native app always provides this function.
  return typeof getCustomFieldsSchema === 'function'
    ? getCustomFieldsSchema(dirPath)
    : Promise.resolve(null);
}

export function CustomFieldsEditor({
  file,
  onUpdate,
  schema: schemaProp,
}: CustomFieldsEditorProps) {
  const { show: showToast } = useToast();

  // State for the current fields
  const [fields, setFields] = useState<CustomFields>(file.custom || {});
  const [schema, setSchema] = useState<CustomFieldSchema | null>(schemaProp ?? null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // State for a new field being added
  const [newFieldName, setNewFieldName] = useState('');
  const [newFieldValue, setNewFieldValue] = useState('');

  // State for showing field suggestions
  const [showFieldSuggestions, setShowFieldSuggestions] = useState(false);
  const [showValueSuggestions, setShowValueSuggestions] = useState(false);
  const [editingField, setEditingField] = useState<string | null>(null);
  const fieldSuggestionsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const valueSuggestionsTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hideFieldSuggestionsSoon = () => {
    if (fieldSuggestionsTimeoutRef.current) {
      clearTimeout(fieldSuggestionsTimeoutRef.current);
    }

    fieldSuggestionsTimeoutRef.current = setTimeout(() => {
      setShowFieldSuggestions(false);
      fieldSuggestionsTimeoutRef.current = null;
    }, 200);
  };

  const hideValueSuggestionsSoon = () => {
    if (valueSuggestionsTimeoutRef.current) {
      clearTimeout(valueSuggestionsTimeoutRef.current);
    }

    valueSuggestionsTimeoutRef.current = setTimeout(() => {
      setShowValueSuggestions(false);
      valueSuggestionsTimeoutRef.current = null;
    }, 200);
  };

  useEffect(() => {
    return () => {
      if (fieldSuggestionsTimeoutRef.current) {
        clearTimeout(fieldSuggestionsTimeoutRef.current);
      }

      if (valueSuggestionsTimeoutRef.current) {
        clearTimeout(valueSuggestionsTimeoutRef.current);
      }
    };
  }, []);

  // Filtered suggestions based on input
  const filteredFieldSuggestions = FIELD_SUGGESTIONS.filter((suggestion) =>
    suggestion.toLowerCase().includes(newFieldName.toLowerCase())
  );

  const filteredValueSuggestions = (field: string): readonly string[] => {
    const definition = fieldDefinition(field);
    if (definition?.type === 'enum' || definition?.type === 'boolean') return [];
    const suggestions = definition?.values ?? getValueSuggestions(field);
    if (suggestions.length === 0) return [];

    const fieldValue = fields[field];
    const currentValue =
      typeof fieldValue === 'string' ? fieldValue : editingField === field ? newFieldValue : '';

    return suggestions.filter((suggestion) =>
      suggestion.toLowerCase().includes(currentValue.toLowerCase())
    );
  };

  const clearFieldError = (field: string) => {
    setValidationError(null);
    setFieldErrors((current) => {
      if (!(field in current)) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const validateBeforeSave = (updatedFields: Record<string, unknown>): boolean => {
    if (!schema) return true;
    const errors = validateCustomFields(updatedFields, schema);
    if (Object.keys(errors).length === 0) return true;
    setFieldErrors(errors);
    setValidationError(validationSummary(errors));
    return false;
  };

  const fieldDefinition = (field: string): CustomFieldDefinition | undefined =>
    schema?.fields[field];

  const inputValueFor = (value: unknown): string => formatCustomFieldInput(value);

  const valueForInput = (
    field: string,
    value: string,
    existingValue?: unknown
  ): CustomFieldValue => {
    const definition = fieldDefinition(field);
    if (definition) return parseCustomFieldInput(value, definition) as CustomFieldValue;
    if (field.toLowerCase() === 'tags' && !Array.isArray(existingValue)) {
      return [value];
    }
    return value;
  };

  useEffect(() => {
    let cancelled = false;
    const { dirPath } = splitFilePath(file.path);
    setSchema(schemaProp ?? null);
    if (schemaProp !== undefined) return;

    void readSchema(dirPath)
      .then((loadedSchema) => {
        if (!cancelled) setSchema(loadedSchema);
      })
      .catch((error: unknown) => {
        if (!cancelled) setValidationError(errorMessage(error));
      });

    return () => {
      cancelled = true;
    };
  }, [file.path, schemaProp]);

  // Add a new field
  const handleAddField = async () => {
    if (!newFieldName.trim()) return;
    const fieldName = newFieldName.trim();

    const { dirPath, fileName } = splitFilePath(file.path);

    const newValue = valueForInput(fieldName, newFieldValue, fields[fieldName]);

    const updatedFields: CustomFields = {
      ...fields,
      [fieldName]: newValue,
    };
    clearFieldError(fieldName);
    if (!validateBeforeSave(updatedFields)) return;

    setFields(updatedFields);

    try {
      await updateCustomFields(dirPath, fileName, updatedFields);
      setNewFieldName('');
      setNewFieldValue('');

      if (onUpdate) {
        onUpdate({
          ...file,
          custom: updatedFields,
        });
      }
    } catch (error) {
      reportError('Failed to save custom field', error, { toast: showToast });
      setValidationError(errorMessage(error));
      setFieldErrors((current) => ({ ...current, [fieldName]: errorMessage(error) }));
      // Revert on error
      setFields(file.custom || {});
    }
  };

  // Update an existing field
  const handleUpdateField = async (field: string, value: CustomFieldValue) => {
    clearFieldError(field);
    const { dirPath, fileName } = splitFilePath(file.path);

    // Special case handling for adding to tags array
    const existingTags = fields[field];
    if (field.toLowerCase() === 'tags' && Array.isArray(existingTags)) {
      // If the incoming value is a string and not already in the array, add it
      if (typeof value === 'string' && !existingTags.includes(value)) {
        value = [...existingTags, value];
      }
    }

    // Update locally first
    const updatedFields: CustomFields = {
      ...fields,
      [field]: value,
    };
    if (!validateBeforeSave(updatedFields)) return;

    setFields(updatedFields);

    try {
      await updateCustomFields(dirPath, fileName, updatedFields);

      // Notify parent if needed
      if (onUpdate) {
        onUpdate({
          ...file,
          custom: updatedFields,
        });
      }
    } catch (error) {
      reportError(`Failed to update field "${field}"`, error, { toast: showToast });
      setValidationError(errorMessage(error));
      setFieldErrors((current) => ({ ...current, [field]: errorMessage(error) }));
      // Revert on error
      setFields(file.custom || {});
    }
  };

  // Remove a field
  const handleRemoveField = async (field: string) => {
    clearFieldError(field);
    const { dirPath, fileName } = splitFilePath(file.path);

    // Create a copy without the field
    const { [field]: _, ...updatedFields } = fields;
    if (!validateBeforeSave(updatedFields)) return;

    setFields(updatedFields);

    try {
      // Update in the filesystem
      await updateCustomFields(dirPath, fileName, updatedFields);

      // Notify parent if needed
      if (onUpdate) {
        onUpdate({
          ...file,
          custom: updatedFields,
        });
      }
    } catch (error) {
      reportError(`Failed to remove field "${field}"`, error, { toast: showToast });
      setValidationError(errorMessage(error));
      setFieldErrors((current) => ({ ...current, [field]: errorMessage(error) }));
      // Revert on error
      setFields(file.custom || {});
    }
  };

  // Remove a tag from a tags array
  const handleRemoveTag = async (tag: string) => {
    const tags = fields.tags;
    if (!tags || !Array.isArray(tags)) return;

    const updatedTags = tags.filter((t: string) => t !== tag);

    // Update via the existing update field handler
    await handleUpdateField('tags', updatedTags);
  };

  // Choose a field suggestion
  const handleFieldSuggestion = (suggestion: string) => {
    setNewFieldName(suggestion);
    setShowFieldSuggestions(false);
    // Focus the value input
    document.getElementById('new-field-value')?.focus();
  };

  // Choose a value suggestion
  const handleValueSuggestion = (suggestion: string) => {
    if (editingField) {
      // Updating existing field
      void handleUpdateField(
        editingField,
        valueForInput(editingField, suggestion, fields[editingField])
      );
      setEditingField(null);
    } else {
      // Adding new field
      setNewFieldValue(suggestion);
    }
    setShowValueSuggestions(false);
  };

  // Edit an existing field
  const handleEditField = (field: string) => {
    setEditingField(field);
    const fieldValue = fields[field];
    setNewFieldValue(inputValueFor(fieldValue));
    setShowValueSuggestions(filteredValueSuggestions(field).length > 0);
  };

  // Save edited field
  const handleSaveEdit = () => {
    if (!editingField) return;

    const value = valueForInput(editingField, newFieldValue, fields[editingField]);
    void handleUpdateField(editingField, value);
    setEditingField(null);
    setNewFieldValue('');
  };

  // Cancel editing
  const handleCancelEdit = () => {
    setEditingField(null);
    setNewFieldValue('');
    setShowValueSuggestions(false);
  };

  // Update fields when file changes
  useEffect(() => {
    setFields(file.custom || {});
    setValidationError(null);
    setFieldErrors({});
  }, [file]);

  const renderValueInput = (
    field: string,
    value: string,
    onChange: (value: string) => void,
    options: {
      id?: string;
      placeholder?: string;
      autoFocus?: boolean;
      onFocus?: () => void;
      onBlur?: () => void;
      className: string;
    }
  ) => {
    const definition = fieldDefinition(field);
    if (definition?.type === 'enum' || definition?.type === 'boolean') {
      const values = definition.type === 'enum' ? (definition.values ?? []) : ['true', 'false'];
      return (
        <select
          id={options.id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={options.onFocus}
          onBlur={options.onBlur}
          className={options.className}
          autoFocus={options.autoFocus}
        >
          <option value="">Select a value</option>
          {values.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    }

    return (
      <input
        id={options.id}
        type={inputTypeFor(definition)}
        placeholder={options.placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onFocus={options.onFocus}
        onBlur={options.onBlur}
        className={options.className}
        autoFocus={options.autoFocus}
      />
    );
  };

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>Custom Fields</h3>
      {validationError && (
        <div className={styles.validationError} role="alert" aria-live="polite">
          {validationError}
        </div>
      )}

      {/* Existing fields */}
      <div className={styles.fieldsContainer}>
        {Object.entries(fields).map(([field, value]) => (
          <div key={field} className={styles.fieldRow}>
            {editingField === field ? (
              // Edit mode
              <>
                <label className={styles.fieldLabel}>{field}</label>
                <div className={styles.editInputContainer}>
                  {renderValueInput(field, newFieldValue, setNewFieldValue, {
                    onFocus: () =>
                      setShowValueSuggestions(filteredValueSuggestions(field).length > 0),
                    onBlur: hideValueSuggestionsSoon,
                    className: styles.fieldInput,
                    autoFocus: true,
                  })}

                  {/* Value suggestions */}
                  {showValueSuggestions && filteredValueSuggestions(field).length > 0 && (
                    <div className={styles.suggestions}>
                      {filteredValueSuggestions(field).map((suggestion) => (
                        <div
                          key={suggestion}
                          className={styles.suggestion}
                          onMouseDown={() => handleValueSuggestion(suggestion)}
                        >
                          {suggestion}
                        </div>
                      ))}
                    </div>
                  )}

                  <div className={styles.editButtons}>
                    <button onClick={handleSaveEdit} className={styles.saveButton}>
                      Save
                    </button>
                    <button onClick={handleCancelEdit} className={styles.cancelButton}>
                      Cancel
                    </button>
                  </div>
                </div>
              </>
            ) : (
              // Display mode
              <>
                <span className={styles.fieldLabel}>{field}</span>

                {/* Tags require special rendering */}
                {field.toLowerCase() === 'tags' && Array.isArray(value) ? (
                  <div className={styles.tagsContainer}>
                    {value.map((tag: string) => (
                      <div key={tag} className={styles.tag}>
                        {tag}
                        <button
                          onClick={() => handleRemoveTag(tag)}
                          className={styles.removeTagButton}
                        >
                          ×
                        </button>
                      </div>
                    ))}

                    {/* Add new tag button */}
                    <button onClick={() => handleEditField(field)} className={styles.addTagButton}>
                      + Add
                    </button>
                  </div>
                ) : (
                  // Regular field value display
                  <div className={styles.fieldValueContainer}>
                    <span className={styles.fieldValue}>
                      {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </span>
                    <div className={styles.fieldActions}>
                      <button onClick={() => handleEditField(field)} className={styles.editButton}>
                        Edit
                      </button>
                      <button
                        onClick={() => handleRemoveField(field)}
                        className={styles.removeButton}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
            {fieldErrors[field] && (
              <div className={styles.fieldError} role="alert" aria-live="polite">
                {fieldErrors[field]}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add new field */}
      <div className={styles.addFieldContainer}>
        <div className={styles.addFieldInputGroup}>
          <div className={styles.fieldNameContainer}>
            <input
              type="text"
              placeholder="Field name"
              value={newFieldName}
              onChange={(e) => setNewFieldName(e.target.value)}
              onFocus={() => setShowFieldSuggestions(true)}
              onBlur={hideFieldSuggestionsSoon}
              className={styles.fieldNameInput}
            />

            {/* Field name suggestions */}
            {showFieldSuggestions && filteredFieldSuggestions.length > 0 && (
              <div className={styles.suggestions}>
                {filteredFieldSuggestions.map((suggestion) => (
                  <div
                    key={suggestion}
                    className={styles.suggestion}
                    onMouseDown={() => handleFieldSuggestion(suggestion)}
                  >
                    {suggestion}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className={styles.fieldValueContainer}>
            {renderValueInput(newFieldName, newFieldValue, setNewFieldValue, {
              id: 'new-field-value',
              placeholder: 'Value',
              onFocus: () => {
                if (filteredValueSuggestions(newFieldName).length > 0) {
                  setShowValueSuggestions(true);
                }
              },
              onBlur: hideValueSuggestionsSoon,
              className: styles.fieldValueInput,
            })}

            {/* Value suggestions for new field */}
            {!editingField &&
              showValueSuggestions &&
              filteredValueSuggestions(newFieldName).length > 0 && (
                <div className={styles.suggestions}>
                  {filteredValueSuggestions(newFieldName).map((suggestion) => (
                    <div
                      key={suggestion}
                      className={styles.suggestion}
                      onMouseDown={() => handleValueSuggestion(suggestion)}
                    >
                      {suggestion}
                    </div>
                  ))}
                </div>
              )}
          </div>
        </div>

        <button
          onClick={handleAddField}
          disabled={!newFieldName.trim()}
          className={styles.addButton}
        >
          Add Field
        </button>
        {fieldErrors[newFieldName.trim()] && (
          <div className={styles.fieldError} role="alert" aria-live="polite">
            {fieldErrors[newFieldName.trim()]}
          </div>
        )}
      </div>
    </div>
  );
}
