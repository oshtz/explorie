import React, { useState, useEffect, useRef } from 'react';
import type { FileEntry } from '../store';
import { updateCustomFields } from '../utils/fs';
import { useToast } from './Toast';
import { reportError } from '../utils/errorReporter';
import styles from './CustomFieldsEditor.module.css';
import {
  type CustomFields,
  type CustomFieldValue,
  FIELD_SUGGESTIONS,
  getValueSuggestions,
} from '../utils/customFieldTypes';

interface CustomFieldsEditorProps {
  file: FileEntry;
  onUpdate?: (updatedFile: FileEntry) => void;
}

export function CustomFieldsEditor({ file, onUpdate }: CustomFieldsEditorProps) {
  const { show: showToast } = useToast();

  // State for the current fields
  const [fields, setFields] = useState<CustomFields>(file.custom || {});

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
    const suggestions = getValueSuggestions(field);
    if (suggestions.length === 0) return [];

    const fieldValue = fields[field];
    const currentValue =
      typeof fieldValue === 'string' ? fieldValue : editingField === field ? newFieldValue : '';

    return suggestions.filter((suggestion) =>
      suggestion.toLowerCase().includes(currentValue.toLowerCase())
    );
  };

  // Add a new field
  const handleAddField = async () => {
    if (!newFieldName.trim()) return;

    // Get directory path and filename
    const filePath = file.path;
    const lastSlashIndex = filePath.lastIndexOf('/');
    const lastBackslashIndex = filePath.lastIndexOf('\\');
    const lastIndex = Math.max(lastSlashIndex, lastBackslashIndex);
    const dirPath = filePath.substring(0, lastIndex);
    const fileName = filePath.substring(lastIndex + 1);

    // Special case handling for tags field
    const newValue =
      newFieldName.toLowerCase() === 'tags' && !Array.isArray(fields[newFieldName])
        ? [newFieldValue] // Make tags an array
        : newFieldValue;

    // Update locally first
    const updatedFields = {
      ...fields,
      [newFieldName]: newValue,
    };

    // Update state
    setFields(updatedFields);
    setNewFieldName('');
    setNewFieldValue('');

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
      reportError('Failed to save custom field', error, { toast: showToast });
      // Revert on error
      setFields(file.custom || {});
    }
  };

  // Update an existing field
  const handleUpdateField = async (field: string, value: CustomFieldValue) => {
    // Get directory path and filename
    const filePath = file.path;
    const lastSlashIndex = filePath.lastIndexOf('/');
    const lastBackslashIndex = filePath.lastIndexOf('\\');
    const lastIndex = Math.max(lastSlashIndex, lastBackslashIndex);
    const dirPath = filePath.substring(0, lastIndex);
    const fileName = filePath.substring(lastIndex + 1);

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

    // Update state
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
      reportError(`Failed to update field "${field}"`, error, { toast: showToast });
      // Revert on error
      setFields(file.custom || {});
    }
  };

  // Remove a field
  const handleRemoveField = async (field: string) => {
    // Get directory path and filename
    const filePath = file.path;
    const lastSlashIndex = filePath.lastIndexOf('/');
    const lastBackslashIndex = filePath.lastIndexOf('\\');
    const lastIndex = Math.max(lastSlashIndex, lastBackslashIndex);
    const dirPath = filePath.substring(0, lastIndex);
    const fileName = filePath.substring(lastIndex + 1);

    // Create a copy without the field
    const { [field]: _, ...updatedFields } = fields;

    // Update state
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
      handleUpdateField(editingField, suggestion);
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
    setNewFieldValue(fieldValue != null ? String(fieldValue) : '');
    setShowValueSuggestions(getValueSuggestions(field).length > 0);
  };

  // Save edited field
  const handleSaveEdit = () => {
    if (!editingField) return;

    handleUpdateField(editingField, newFieldValue);
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
  }, [file]);

  return (
    <div className={styles.container}>
      <h3 className={styles.title}>Custom Fields</h3>

      {/* Existing fields */}
      <div className={styles.fieldsContainer}>
        {Object.entries(fields).map(([field, value]) => (
          <div key={field} className={styles.fieldRow}>
            {editingField === field ? (
              // Edit mode
              <>
                <label className={styles.fieldLabel}>{field}</label>
                <div className={styles.editInputContainer}>
                  <input
                    type="text"
                    value={newFieldValue}
                    onChange={(e) => setNewFieldValue(e.target.value)}
                    onFocus={() => setShowValueSuggestions(getValueSuggestions(field).length > 0)}
                    onBlur={hideValueSuggestionsSoon}
                    className={styles.fieldInput}
                    autoFocus
                  />

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
            <input
              id="new-field-value"
              type="text"
              placeholder="Value"
              value={newFieldValue}
              onChange={(e) => setNewFieldValue(e.target.value)}
              onFocus={() => {
                if (getValueSuggestions(newFieldName).length > 0) {
                  setShowValueSuggestions(true);
                }
              }}
              onBlur={hideValueSuggestionsSoon}
              className={styles.fieldValueInput}
            />

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
      </div>
    </div>
  );
}
