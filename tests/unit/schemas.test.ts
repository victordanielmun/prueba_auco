import { describe, expect, it } from 'vitest';
import { isDocumentNumberValid } from '../../src/domain/rules/document-rules';
import {
  createValidationSchema,
  validationIdParamSchema,
} from '../../src/domain/schemas/validation.schema';

describe('createValidationSchema', () => {
  it('normaliza documentNumber y countryCode', () => {
    const parsed = createValidationSchema.parse({
      name: '  Ada Lovelace ',
      documentNumber: ' ab 123-456 ',
      countryCode: 'co',
    });
    expect(parsed).toEqual({ name: 'Ada Lovelace', documentNumber: 'AB123-456', countryCode: 'CO' });
  });

  it('countryCode es opcional', () => {
    const parsed = createValidationSchema.parse({ name: 'Ada', documentNumber: 'AB12345' });
    expect(parsed.countryCode).toBeUndefined();
  });

  it.each([
    [{}, 'name'],
    [{ name: 'A', documentNumber: 'AB12345' }, 'name'],
    [{ name: 'Ada' }, 'documentNumber'],
    [{ name: 'Ada', documentNumber: '   ' }, 'documentNumber'],
    [{ name: 'Ada', documentNumber: 'AB12345', countryCode: 'COL' }, 'countryCode'],
    [{ name: 'Ada', documentNumber: 'AB12345', countryCode: '12' }, 'countryCode'],
  ])('rechaza %j (campo %s)', (input, field) => {
    const result = createValidationSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some((i) => i.path[0] === field)).toBe(true);
  });

  it('rechaza campos desconocidos (strict)', () => {
    const result = createValidationSchema.safeParse({ name: 'Ada', documentNumber: 'AB12345', admin: true });
    expect(result.success).toBe(false);
  });

  it('rechaza tipos incorrectos', () => {
    expect(createValidationSchema.safeParse({ name: 123, documentNumber: 456 }).success).toBe(false);
  });
});

describe('validationIdParamSchema', () => {
  it('acepta un UUID', () => {
    expect(validationIdParamSchema.safeParse({ id: 'e241464f-a6c9-405f-9b99-aad2ff231bdb' }).success).toBe(true);
  });
  it.each(['abc', '123', '', "' OR 1=1 --"])('rechaza id inválido %j', (id) => {
    expect(validationIdParamSchema.safeParse({ id }).success).toBe(false);
  });
});

describe('isDocumentNumberValid', () => {
  it.each(['AB123', 'AB-123456', 'A'.repeat(20)])('acepta %s', (v) => {
    expect(isDocumentNumberValid(v)).toBe(true);
  });
  it.each(['X1', 'A'.repeat(21), 'AB 123', 'AB_123', 'ÁB123'])('rechaza %s', (v) => {
    expect(isDocumentNumberValid(v)).toBe(false);
  });
});
