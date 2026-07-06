const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

/**
 * Normalize text for accent- and case-insensitive comparison:
 * NFD-decompose, strip combining marks, uppercase, collapse whitespace.
 */
export function normalizeText(value) {
  if (value == null) return '';
  return String(value)
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split a phrase into normalized words (alphanumeric runs). */
export function normalizedWords(value) {
  return normalizeText(value).split(/[^A-Z0-9]+/).filter(Boolean);
}
