/**
 * URL-safe slug from a human name/title: strip accents, lowercase, collapse
 * non-alphanumerics to hyphens, trim edges, cap length.
 */
export function slugify(value: string, maxLength = 200): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength);
}
