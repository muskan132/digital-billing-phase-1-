import { BadRequestException } from '@nestjs/common';
import { parseBillType, parseIsoDate, parseLimit, parseSource } from './portal-bills-filters.util';

describe('portal-bills-filters.util (H-1 / E-2 shared)', () => {
  describe('parseIsoDate', () => {
    it('undefined → undefined; a valid ISO date → Date', () => {
      expect(parseIsoDate(undefined, 'dateFrom')).toBeUndefined();
      expect(parseIsoDate('2026-08-01', 'dateFrom')).toEqual(new Date('2026-08-01'));
    });
    it('a garbage value → 400', () => {
      expect(() => parseIsoDate('not-a-date', 'dateFrom')).toThrow(BadRequestException);
      expect(() => parseIsoDate('not-a-date', 'dateFrom')).toThrow(/dateFrom must be a valid ISO 8601 date/);
    });
  });

  describe('parseBillType', () => {
    it('undefined → undefined; a valid enum → the value', () => {
      expect(parseBillType(undefined)).toBeUndefined();
      expect(parseBillType('RECEIPT')).toBe('RECEIPT');
      expect(parseBillType('TAX_INVOICE')).toBe('TAX_INVOICE');
    });
    it('an unknown value → 400', () => {
      expect(() => parseBillType('INVOICE')).toThrow(BadRequestException);
    });
  });

  describe('parseSource', () => {
    it('undefined → undefined; a valid enum → the value', () => {
      expect(parseSource(undefined)).toBeUndefined();
      expect(parseSource('PG_CALLBACK')).toBe('PG_CALLBACK');
      expect(parseSource('DIRECT_API')).toBe('DIRECT_API');
    });
    it('an unknown value → 400', () => {
      expect(() => parseSource('WEBHOOK')).toThrow(BadRequestException);
    });
  });

  describe('parseLimit', () => {
    it('undefined → undefined; an integer string → the number', () => {
      expect(parseLimit(undefined)).toBeUndefined();
      expect(parseLimit('25')).toBe(25);
    });
    it('a non-integer → 400', () => {
      expect(() => parseLimit('2.5')).toThrow(BadRequestException);
      expect(() => parseLimit('abc')).toThrow(BadRequestException);
    });
  });
});
