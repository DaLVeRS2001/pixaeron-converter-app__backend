import { normalizeEmail } from './normalize-email';

describe('normalizeEmail', () => {
  it('trims and lowercases an email without side effects', () => {
    expect(normalizeEmail(' USER@Example.COM ')).toBe('user@example.com');
  });
});
