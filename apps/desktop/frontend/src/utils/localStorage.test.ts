import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getString,
  getStringWithDefault,
  getBoolean,
  getBooleanWithDefault,
  getNumber,
  getNumberWithDefault,
  getJson,
  getJsonWithDefault,
  setString,
  setBoolean,
  setNumber,
  setJson,
  remove,
  set,
  get,
} from './localStorage';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

describe('localStorage utilities', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
  });

  describe('getString', () => {
    it('should return null for non-existent key', () => {
      const result = getString('explorie:viewMode');
      expect(result).toBeNull();
    });

    it('should return the stored string value', () => {
      localStorageMock.setItem('explorie:viewMode', 'grid');
      const result = getString('explorie:viewMode');
      expect(result).toBe('grid');
    });
  });

  describe('getStringWithDefault', () => {
    it('should return default for non-existent key', () => {
      const result = getStringWithDefault('explorie:viewMode', 'list');
      expect(result).toBe('list');
    });

    it('should return stored value when exists', () => {
      localStorageMock.setItem('explorie:viewMode', 'grid');
      const result = getStringWithDefault('explorie:viewMode', 'list');
      expect(result).toBe('grid');
    });
  });

  describe('getBoolean', () => {
    it('should return null for non-existent key', () => {
      const result = getBoolean('explorie:showHidden');
      expect(result).toBeNull();
    });

    it("should return true for 'true' string", () => {
      localStorageMock.setItem('explorie:showHidden', 'true');
      const result = getBoolean('explorie:showHidden');
      expect(result).toBe(true);
    });

    it("should return false for 'false' string", () => {
      localStorageMock.setItem('explorie:showHidden', 'false');
      const result = getBoolean('explorie:showHidden');
      expect(result).toBe(false);
    });

    it('should return false for other strings', () => {
      localStorageMock.setItem('explorie:showHidden', 'invalid');
      const result = getBoolean('explorie:showHidden');
      expect(result).toBe(false);
    });
  });

  describe('getBooleanWithDefault', () => {
    it('should return default for non-existent key', () => {
      const result = getBooleanWithDefault('explorie:showHidden', true);
      expect(result).toBe(true);
    });

    it('should return stored value when exists', () => {
      localStorageMock.setItem('explorie:showHidden', 'false');
      const result = getBooleanWithDefault('explorie:showHidden', true);
      expect(result).toBe(false);
    });
  });

  describe('getNumber', () => {
    it('should return null for non-existent key', () => {
      const result = getNumber('explorie:uiScale');
      expect(result).toBeNull();
    });

    it('should return parsed number', () => {
      localStorageMock.setItem('explorie:uiScale', '1.2');
      const result = getNumber('explorie:uiScale');
      expect(result).toBe(1.2);
    });

    it('should return null for non-numeric string', () => {
      localStorageMock.setItem('explorie:uiScale', 'invalid');
      const result = getNumber('explorie:uiScale');
      expect(result).toBeNull();
    });

    it('should handle integer values', () => {
      localStorageMock.setItem('explorie:listRowHeight', '34');
      const result = getNumber('explorie:listRowHeight');
      expect(result).toBe(34);
    });
  });

  describe('getNumberWithDefault', () => {
    it('should return default for non-existent key', () => {
      const result = getNumberWithDefault('explorie:uiScale', 1.0);
      expect(result).toBe(1.0);
    });

    it('should return stored value when exists', () => {
      localStorageMock.setItem('explorie:uiScale', '1.2');
      const result = getNumberWithDefault('explorie:uiScale', 1.0);
      expect(result).toBe(1.2);
    });
  });

  describe('getJson', () => {
    it('should return null for non-existent key', () => {
      const result = getJson('explorie:favorites');
      expect(result).toBeNull();
    });

    it('should return parsed JSON array', () => {
      const favorites = [{ path: '/home', name: 'Home' }];
      localStorageMock.setItem('explorie:favorites', JSON.stringify(favorites));
      const result = getJson('explorie:favorites');
      expect(result).toEqual(favorites);
    });

    it('should return parsed JSON object', () => {
      const workspaces = { 'ws-1': { id: 'ws-1', name: 'Work' } };
      localStorageMock.setItem('explorie:workspaces', JSON.stringify(workspaces));
      const result = getJson('explorie:workspaces');
      expect(result).toEqual(workspaces);
    });

    it('should return null for invalid JSON', () => {
      localStorageMock.setItem('explorie:favorites', 'not valid json');
      const result = getJson('explorie:favorites');
      expect(result).toBeNull();
    });
  });

  describe('getJsonWithDefault', () => {
    it('should return default for non-existent key', () => {
      const defaultValue = [{ path: '/default', name: 'Default' }];
      const result = getJsonWithDefault('explorie:favorites', defaultValue);
      expect(result).toEqual(defaultValue);
    });

    it('should return stored value when exists', () => {
      const favorites = [{ path: '/home', name: 'Home' }];
      localStorageMock.setItem('explorie:favorites', JSON.stringify(favorites));
      const result = getJsonWithDefault('explorie:favorites', []);
      expect(result).toEqual(favorites);
    });
  });

  describe('setString', () => {
    it('should store string value', () => {
      const result = setString('explorie:viewMode', 'grid');
      expect(result).toBe(true);
      expect(localStorageMock.getItem('explorie:viewMode')).toBe('grid');
    });
  });

  describe('setBoolean', () => {
    it('should store boolean as string', () => {
      const result = setBoolean('explorie:showHidden', true);
      expect(result).toBe(true);
      expect(localStorageMock.getItem('explorie:showHidden')).toBe('true');
    });

    it("should store false as 'false' string", () => {
      setBoolean('explorie:showHidden', false);
      expect(localStorageMock.getItem('explorie:showHidden')).toBe('false');
    });
  });

  describe('setNumber', () => {
    it('should store number as string', () => {
      const result = setNumber('explorie:uiScale', 1.2);
      expect(result).toBe(true);
      expect(localStorageMock.getItem('explorie:uiScale')).toBe('1.2');
    });
  });

  describe('setJson', () => {
    it('should store object as JSON string', () => {
      const favorites = [{ path: '/home', name: 'Home' }];
      const result = setJson('explorie:favorites', favorites);
      expect(result).toBe(true);
      expect(localStorageMock.getItem('explorie:favorites')).toBe(JSON.stringify(favorites));
    });
  });

  describe('remove', () => {
    it('should remove key from storage', () => {
      localStorageMock.setItem('explorie:viewMode', 'grid');
      const result = remove('explorie:viewMode');
      expect(result).toBe(true);
      expect(localStorageMock.getItem('explorie:viewMode')).toBeNull();
    });
  });

  describe('set (generic)', () => {
    it('should auto-detect string type', () => {
      set('explorie:viewMode', 'grid');
      expect(localStorageMock.getItem('explorie:viewMode')).toBe('grid');
    });

    it('should auto-detect boolean type', () => {
      set('explorie:showHidden', true);
      expect(localStorageMock.getItem('explorie:showHidden')).toBe('true');
    });

    it('should auto-detect number type', () => {
      set('explorie:uiScale', 1.2);
      expect(localStorageMock.getItem('explorie:uiScale')).toBe('1.2');
    });

    it('should auto-detect object type', () => {
      const favorites = [{ path: '/home', name: 'Home' }];
      set('explorie:favorites', favorites);
      expect(localStorageMock.getItem('explorie:favorites')).toBe(JSON.stringify(favorites));
    });
  });

  describe('get (generic)', () => {
    it('should retrieve string with correct type hint', () => {
      localStorageMock.setItem('explorie:viewMode', 'grid');
      const result = get('explorie:viewMode', 'string');
      expect(result).toBe('grid');
    });

    it('should retrieve boolean with correct type hint', () => {
      localStorageMock.setItem('explorie:showHidden', 'true');
      const result = get('explorie:showHidden', 'boolean');
      expect(result).toBe(true);
    });

    it('should retrieve number with correct type hint', () => {
      localStorageMock.setItem('explorie:uiScale', '1.2');
      const result = get('explorie:uiScale', 'number');
      expect(result).toBe(1.2);
    });

    it('should retrieve JSON with correct type hint', () => {
      const favorites = [{ path: '/home', name: 'Home' }];
      localStorageMock.setItem('explorie:favorites', JSON.stringify(favorites));
      const result = get('explorie:favorites', 'json');
      expect(result).toEqual(favorites);
    });
  });
});
