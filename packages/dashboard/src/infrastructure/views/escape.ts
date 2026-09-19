const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: unknown): string =>
  String(value).replace(/[&<>"']/g, (char) => ENTITIES[char] as string);

export const environmentPath = (environment: string): string => `/env/${encodeURIComponent(environment)}`;
