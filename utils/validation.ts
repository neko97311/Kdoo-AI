/**
 * Pure validation utilities — no i18n dependency.
 * Callers decide how to display errors (i18n keys, inline text, etc.).
 *
 * Usage:
 *   if (!isNotEmpty(email)) { setEmailError(t('login.errorEmailRequired')); }
 *   if (!isValidEmail(email)) { setEmailError(t('login.errorInvalidEmail')); }
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Value is not empty after trimming whitespace */
export function isNotEmpty(value: string): boolean {
  return value.trim().length > 0;
}

/** Value meets minimum length requirement (checks raw length, not trimmed) */
export function hasMinLength(value: string, min: number): boolean {
  return value.length >= min;
}

/** Email format is valid (RFC 5322 simplified) */
export function isValidEmail(email: string): boolean {
  return EMAIL_REGEX.test(email.trim());
}

/** Two values are strictly equal */
export function isMatch(a: string, b: string): boolean {
  return a === b;
}

// ── Composite validators (return error key or null) ──

export type EmailError = 'required' | 'invalid' | null;

/** Validate email: non-empty + format. Returns error semantic or null if valid. */
export function validateEmail(email: string): EmailError {
  if (!isNotEmpty(email)) return 'required';
  if (!isValidEmail(email)) return 'invalid';
  return null;
}

export type PasswordError = 'required' | 'tooShort' | 'tooLong' | null;

/** Validate password: non-empty + min/max length. Returns error semantic or null if valid. */
export function validatePassword(password: string, minLength = 6, maxLength = 50): PasswordError {
  if (!isNotEmpty(password)) return 'required';
  if (!hasMinLength(password, minLength)) return 'tooShort';
  if (password.length > maxLength) return 'tooLong';
  return null;
}
