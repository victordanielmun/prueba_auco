const DOCUMENT_NUMBER_PATTERN = /^[A-Z0-9-]{5,20}$/;

/** Normaliza el número de documento: sin espacios y en mayúsculas. */
export function normalizeDocumentNumber(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

/** true si el número (ya normalizado) cumple el formato: 5-20 caracteres A-Z, 0-9 o guion. */
export function isDocumentNumberValid(documentNumber: string): boolean {
  return DOCUMENT_NUMBER_PATTERN.test(documentNumber);
}
