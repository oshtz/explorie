import { describe, it, expect } from 'vitest';
import {
  isCustomFieldValue,
  isKnownFieldName,
  isStatusValue,
  isPriorityValue,
  isTypeValue,
  isCategoryValue,
  sanitizeCustomFields,
  validateKnownFieldValue,
  getValueSuggestions,
  isColumnCandidate,
  formatFieldValue,
  FIELD_SUGGESTIONS,
  VALUE_SUGGESTIONS,
} from './customFieldTypes';

describe('customFieldTypes', () => {
  describe('isCustomFieldValue', () => {
    it('should return true for null', () => {
      expect(isCustomFieldValue(null)).toBe(true);
    });

    it('should return true for strings', () => {
      expect(isCustomFieldValue('hello')).toBe(true);
      expect(isCustomFieldValue('')).toBe(true);
    });

    it('should return true for numbers', () => {
      expect(isCustomFieldValue(42)).toBe(true);
      expect(isCustomFieldValue(0)).toBe(true);
      expect(isCustomFieldValue(-1.5)).toBe(true);
    });

    it('should return true for booleans', () => {
      expect(isCustomFieldValue(true)).toBe(true);
      expect(isCustomFieldValue(false)).toBe(true);
    });

    it('should return true for string arrays', () => {
      expect(isCustomFieldValue(['tag1', 'tag2'])).toBe(true);
      expect(isCustomFieldValue([])).toBe(true);
    });

    it('should return false for non-string arrays', () => {
      expect(isCustomFieldValue([1, 2, 3])).toBe(false);
      expect(isCustomFieldValue([{ key: 'value' }])).toBe(false);
    });

    it('should return false for objects', () => {
      expect(isCustomFieldValue({ key: 'value' })).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isCustomFieldValue(undefined)).toBe(false);
    });
  });

  describe('isKnownFieldName', () => {
    it('should return true for known field names', () => {
      expect(isKnownFieldName('status')).toBe(true);
      expect(isKnownFieldName('priority')).toBe(true);
      expect(isKnownFieldName('type')).toBe(true);
      expect(isKnownFieldName('category')).toBe(true);
      expect(isKnownFieldName('project')).toBe(true);
      expect(isKnownFieldName('tags')).toBe(true);
      expect(isKnownFieldName('notes')).toBe(true);
      expect(isKnownFieldName('dueDate')).toBe(true);
    });

    it('should return false for unknown field names', () => {
      expect(isKnownFieldName('custom')).toBe(false);
      expect(isKnownFieldName('Status')).toBe(false); // case-sensitive
      expect(isKnownFieldName('')).toBe(false);
    });
  });

  describe('isStatusValue', () => {
    it('should return true for valid status values', () => {
      expect(isStatusValue('Todo')).toBe(true);
      expect(isStatusValue('In Progress')).toBe(true);
      expect(isStatusValue('Done')).toBe(true);
      expect(isStatusValue('Blocked')).toBe(true);
      expect(isStatusValue('Pending Review')).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isStatusValue('invalid')).toBe(false);
      expect(isStatusValue('todo')).toBe(false); // case-sensitive
      expect(isStatusValue(123)).toBe(false);
    });
  });

  describe('isPriorityValue', () => {
    it('should return true for valid priority values', () => {
      expect(isPriorityValue('Low')).toBe(true);
      expect(isPriorityValue('Medium')).toBe(true);
      expect(isPriorityValue('High')).toBe(true);
      expect(isPriorityValue('Urgent')).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isPriorityValue('Critical')).toBe(false);
      expect(isPriorityValue('low')).toBe(false);
    });
  });

  describe('isTypeValue', () => {
    it('should return true for valid type values', () => {
      expect(isTypeValue('Document')).toBe(true);
      expect(isTypeValue('Image')).toBe(true);
      expect(isTypeValue('Video')).toBe(true);
      expect(isTypeValue('Code')).toBe(true);
      expect(isTypeValue('Data')).toBe(true);
      expect(isTypeValue('Archive')).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isTypeValue('File')).toBe(false);
    });
  });

  describe('isCategoryValue', () => {
    it('should return true for valid category values', () => {
      expect(isCategoryValue('Work')).toBe(true);
      expect(isCategoryValue('Personal')).toBe(true);
      expect(isCategoryValue('Project')).toBe(true);
      expect(isCategoryValue('Reference')).toBe(true);
      expect(isCategoryValue('Template')).toBe(true);
    });

    it('should return false for invalid values', () => {
      expect(isCategoryValue('Other')).toBe(false);
    });
  });

  describe('sanitizeCustomFields', () => {
    it('should pass through valid values', () => {
      const input = {
        status: 'Done',
        priority: 'High',
        tags: ['tag1', 'tag2'],
        notes: 'Some notes',
        count: 42,
        enabled: true,
      };
      const result = sanitizeCustomFields(input);
      expect(result).toEqual(input);
    });

    it('should stringify objects', () => {
      const input = {
        nested: { key: 'value' },
      };
      const result = sanitizeCustomFields(input);
      expect(result.nested).toBe('{"key":"value"}');
    });

    it('should skip invalid array types', () => {
      const input = {
        validTags: ['a', 'b'],
        invalidTags: [1, 2, 3],
      };
      const result = sanitizeCustomFields(input);
      expect(result.validTags).toEqual(['a', 'b']);
      expect(result.invalidTags).toBeUndefined();
    });

    it('should handle empty object', () => {
      const result = sanitizeCustomFields({});
      expect(result).toEqual({});
    });
  });

  describe('validateKnownFieldValue', () => {
    it('should validate status values', () => {
      expect(validateKnownFieldValue('status', 'Done')).toBe('Done');
      expect(validateKnownFieldValue('status', 'invalid')).toBeUndefined();
    });

    it('should validate priority values', () => {
      expect(validateKnownFieldValue('priority', 'High')).toBe('High');
      expect(validateKnownFieldValue('priority', 'invalid')).toBeUndefined();
    });

    it('should validate type values', () => {
      expect(validateKnownFieldValue('type', 'Document')).toBe('Document');
      expect(validateKnownFieldValue('type', 'invalid')).toBeUndefined();
    });

    it('should validate category values', () => {
      expect(validateKnownFieldValue('category', 'Work')).toBe('Work');
      expect(validateKnownFieldValue('category', 'invalid')).toBeUndefined();
    });

    it('should validate tags as string array', () => {
      expect(validateKnownFieldValue('tags', ['a', 'b'])).toEqual(['a', 'b']);
      expect(validateKnownFieldValue('tags', 'not an array')).toBeUndefined();
      expect(validateKnownFieldValue('tags', [1, 2])).toBeUndefined();
    });

    it('should validate string fields', () => {
      expect(validateKnownFieldValue('project', 'My Project')).toBe('My Project');
      expect(validateKnownFieldValue('notes', 'Some notes')).toBe('Some notes');
      expect(validateKnownFieldValue('dueDate', '2024-01-01')).toBe('2024-01-01');
      expect(validateKnownFieldValue('project', 123)).toBeUndefined();
    });
  });

  describe('getValueSuggestions', () => {
    it('should return suggestions for known fields', () => {
      expect(getValueSuggestions('status')).toContain('Done');
      expect(getValueSuggestions('priority')).toContain('High');
      expect(getValueSuggestions('type')).toContain('Document');
      expect(getValueSuggestions('category')).toContain('Work');
    });

    it('should be case-insensitive', () => {
      expect(getValueSuggestions('Status')).toContain('Done');
      expect(getValueSuggestions('STATUS')).toContain('Done');
    });

    it('should return empty array for unknown fields', () => {
      expect(getValueSuggestions('unknown')).toEqual([]);
      expect(getValueSuggestions('tags')).toEqual([]);
    });
  });

  describe('isColumnCandidate', () => {
    it('should return true for column-friendly fields with short values', () => {
      expect(isColumnCandidate('status', 'Done')).toBe(true);
      expect(isColumnCandidate('priority', 'High')).toBe(true);
      expect(isColumnCandidate('type', 'Document')).toBe(true);
      expect(isColumnCandidate('category', 'Work')).toBe(true);
    });

    it('should return false for null/undefined values', () => {
      expect(isColumnCandidate('status', null)).toBe(false);
      expect(isColumnCandidate('status', undefined)).toBe(false);
    });

    it('should return false for arrays', () => {
      expect(isColumnCandidate('tags', ['a', 'b'])).toBe(false);
    });

    it('should return false for objects', () => {
      expect(isColumnCandidate('nested', { key: 'value' })).toBe(false);
    });

    it('should return false for long strings', () => {
      const longString = 'a'.repeat(51);
      expect(isColumnCandidate('status', longString)).toBe(false);
    });

    it('should return false for non-column fields', () => {
      expect(isColumnCandidate('notes', 'Short note')).toBe(false);
      expect(isColumnCandidate('unknown', 'value')).toBe(false);
    });
  });

  describe('formatFieldValue', () => {
    it('should format null as dash', () => {
      expect(formatFieldValue(null)).toBe('-');
    });

    it('should format arrays as comma-separated', () => {
      expect(formatFieldValue(['a', 'b', 'c'])).toBe('a, b, c');
    });

    it('should convert other values to string', () => {
      expect(formatFieldValue('text')).toBe('text');
      expect(formatFieldValue(42)).toBe('42');
      expect(formatFieldValue(true)).toBe('true');
    });
  });

  describe('exports', () => {
    it('should export FIELD_SUGGESTIONS array', () => {
      expect(Array.isArray(FIELD_SUGGESTIONS)).toBe(true);
      expect(FIELD_SUGGESTIONS.length).toBeGreaterThan(0);
    });

    it('should export VALUE_SUGGESTIONS object', () => {
      expect(typeof VALUE_SUGGESTIONS).toBe('object');
      expect(VALUE_SUGGESTIONS.status).toBeDefined();
    });
  });
});
