export function parseApiDate(value) {
  if (value instanceof Date) return new Date(value);
  const text = String(value || '');
  return new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && !/(Z|[+-]\d{2}:?\d{2})$/i.test(text) ? `${text}Z` : text);
}
