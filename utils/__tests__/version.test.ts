import { compareVersions } from '../version';

describe('compareVersions', () => {
  it('returns -1 when a < b (major)', () => {
    expect(compareVersions('1.0.0', '2.0.0')).toBe(-1);
  });
  it('returns -1 when a < b (minor)', () => {
    expect(compareVersions('1.0.0', '1.1.0')).toBe(-1);
  });
  it('returns -1 when a < b (patch)', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1);
  });
  it('returns 1 when a > b', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });
  it('returns 0 when a == b', () => {
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
  });
  it('compares numerically not lexically (1.10 > 1.9)', () => {
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });
  it('tolerates short format 1.0 == 1.0.0', () => {
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
  it('tolerates missing patch (1.0 < 1.0.1)', () => {
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
  });
});
