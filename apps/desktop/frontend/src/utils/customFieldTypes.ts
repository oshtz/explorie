/**
 * Type definitions for custom file fields in explorie.
 *
 * Custom fields allow users to add metadata to files via .explorie.json files.
 * This module provides type-safe definitions and utilities for working with these fields.
 */

// ============================================================================
// Base Value Types
// ============================================================================

/**
 * Primitive values that can be stored in custom fields
 */
export type CustomFieldPrimitive = string | number | boolean;

/**
 * Array values for custom fields (e.g., tags)
 */
export type CustomFieldArray = string[];

/**
 * All valid custom field value types
 */
export type CustomFieldValue = CustomFieldPrimitive | CustomFieldArray | null;

// ============================================================================
// Predefined Field Types
// ============================================================================

/**
 * Status values for the 'status' field
 */
export type StatusValue = 'Todo' | 'In Progress' | 'Done' | 'Blocked' | 'Pending Review';

/**
 * Priority values for the 'priority' field
 */
export type PriorityValue = 'Low' | 'Medium' | 'High' | 'Urgent';

/**
 * Type values for the 'type' field
 */
export type TypeValue = 'Document' | 'Image' | 'Video' | 'Code' | 'Data' | 'Archive';

/**
 * Category values for the 'category' field
 */
export type CategoryValue = 'Work' | 'Personal' | 'Project' | 'Reference' | 'Template';

/**
 * Known field names that have predefined value suggestions
 */
export type KnownFieldName =
  | 'status'
  | 'priority'
  | 'type'
  | 'category'
  | 'project'
  | 'tags'
  | 'notes'
  | 'dueDate';

/**
 * Map of known field names to their value types
 */
export interface KnownFieldTypes {
  status: StatusValue;
  priority: PriorityValue;
  type: TypeValue;
  category: CategoryValue;
  project: string;
  tags: string[];
  notes: string;
  dueDate: string; // ISO date string
}

// ============================================================================
// Custom Fields Record Type
// ============================================================================

/**
 * A custom fields record where known fields have specific types
 * and unknown fields have a general CustomFieldValue type.
 *
 * This provides type safety for predefined fields while allowing
 * user-defined fields with flexible types.
 *
 * Using a simpler Record type for better compatibility with empty objects
 * and TypeScript's index signature requirements.
 */
export type CustomFields = Record<string, CustomFieldValue | undefined>;

/**
 * Strongly-typed custom fields for when you know you're working with
 * predefined fields. Use this when setting/getting known fields.
 */
export type StrictCustomFields = {
  [K in KnownFieldName]?: KnownFieldTypes[K];
} & Record<string, CustomFieldValue | undefined>;

/**
 * Type guard to check if a value is a valid CustomFieldValue
 */
export function isCustomFieldValue(value: unknown): value is CustomFieldValue {
  if (value === null) return true;
  if (typeof value === 'string') return true;
  if (typeof value === 'number') return true;
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) {
    return value.every((item) => typeof item === 'string');
  }
  return false;
}

/**
 * Type guard to check if a key is a known field name
 */
export function isKnownFieldName(key: string): key is KnownFieldName {
  const knownFields: KnownFieldName[] = [
    'status',
    'priority',
    'type',
    'category',
    'project',
    'tags',
    'notes',
    'dueDate',
  ];
  return knownFields.includes(key as KnownFieldName);
}

/**
 * Type guard to check if a value is a valid status
 */
export function isStatusValue(value: unknown): value is StatusValue {
  const validStatuses: StatusValue[] = ['Todo', 'In Progress', 'Done', 'Blocked', 'Pending Review'];
  return typeof value === 'string' && validStatuses.includes(value as StatusValue);
}

/**
 * Type guard to check if a value is a valid priority
 */
export function isPriorityValue(value: unknown): value is PriorityValue {
  const validPriorities: PriorityValue[] = ['Low', 'Medium', 'High', 'Urgent'];
  return typeof value === 'string' && validPriorities.includes(value as PriorityValue);
}

/**
 * Type guard to check if a value is a valid type
 */
export function isTypeValue(value: unknown): value is TypeValue {
  const validTypes: TypeValue[] = ['Document', 'Image', 'Video', 'Code', 'Data', 'Archive'];
  return typeof value === 'string' && validTypes.includes(value as TypeValue);
}

/**
 * Type guard to check if a value is a valid category
 */
export function isCategoryValue(value: unknown): value is CategoryValue {
  const validCategories: CategoryValue[] = ['Work', 'Personal', 'Project', 'Reference', 'Template'];
  return typeof value === 'string' && validCategories.includes(value as CategoryValue);
}

// ============================================================================
// Validation & Sanitization
// ============================================================================

/**
 * Validates a custom fields object and returns a sanitized version.
 * Removes invalid values and ensures type correctness.
 */
export function sanitizeCustomFields(fields: Record<string, unknown>): CustomFields {
  const result: CustomFields = {};

  for (const [key, value] of Object.entries(fields)) {
    // Skip invalid values
    if (!isCustomFieldValue(value)) {
      // If it's an object (not array), try to stringify it
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        try {
          result[key] = JSON.stringify(value);
        } catch {
          // Skip values that can't be stringified
          continue;
        }
      }
      continue;
    }

    result[key] = value;
  }

  return result;
}

/**
 * Validates that a value matches the expected type for a known field.
 * Returns the value if valid, or undefined if invalid.
 */
export function validateKnownFieldValue<K extends KnownFieldName>(
  field: K,
  value: unknown
): KnownFieldTypes[K] | undefined {
  switch (field) {
    case 'status':
      return isStatusValue(value) ? (value as KnownFieldTypes[K]) : undefined;
    case 'priority':
      return isPriorityValue(value) ? (value as KnownFieldTypes[K]) : undefined;
    case 'type':
      return isTypeValue(value) ? (value as KnownFieldTypes[K]) : undefined;
    case 'category':
      return isCategoryValue(value) ? (value as KnownFieldTypes[K]) : undefined;
    case 'tags':
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        return value as KnownFieldTypes[K];
      }
      return undefined;
    case 'project':
    case 'notes':
    case 'dueDate':
      return typeof value === 'string' ? (value as KnownFieldTypes[K]) : undefined;
    default:
      return undefined;
  }
}

// ============================================================================
// Field Suggestions (for UI)
// ============================================================================

/**
 * Get suggested field names for the custom fields editor
 */
export const FIELD_SUGGESTIONS: KnownFieldName[] = [
  'status',
  'priority',
  'type',
  'category',
  'project',
  'tags',
  'notes',
  'dueDate',
];

/**
 * Get suggested values for known fields
 */
export const VALUE_SUGGESTIONS: {
  [K in KnownFieldName]?: readonly string[];
} = {
  status: ['Todo', 'In Progress', 'Done', 'Blocked', 'Pending Review'] as const,
  priority: ['Low', 'Medium', 'High', 'Urgent'] as const,
  type: ['Document', 'Image', 'Video', 'Code', 'Data', 'Archive'] as const,
  category: ['Work', 'Personal', 'Project', 'Reference', 'Template'] as const,
};

/**
 * Get value suggestions for a field name (case-insensitive)
 */
export function getValueSuggestions(fieldName: string): readonly string[] {
  const key = fieldName.toLowerCase() as KnownFieldName;
  return VALUE_SUGGESTIONS[key] ?? [];
}

// ============================================================================
// Column Display Utilities
// ============================================================================

/**
 * Fields that are suitable for display as columns in list view.
 * These are short, textual values that fit in a table cell.
 */
export const COLUMN_CANDIDATE_FIELDS: readonly string[] = [
  'status',
  'type',
  'category',
  'priority',
];

/**
 * Check if a field is suitable for display as a column
 */
export function isColumnCandidate(key: string, value: unknown): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return false; // arrays better as tags
  if (typeof value === 'object') return false; // skip objects

  if (typeof value === 'string') {
    if (value.length > 50) return false; // keep short textual values
  }

  return COLUMN_CANDIDATE_FIELDS.includes(key.toLowerCase());
}

/**
 * Format a custom field value for display
 */
export function formatFieldValue(value: CustomFieldValue): string {
  if (value === null) return '-';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}
