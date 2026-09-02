/**
 * 链式 schema 验证 — 返回语义错误 key（与 utils/validation.ts 风格一致）。
 * 调用方负责用 i18n t() 翻译语义 key。
 */

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ErrorKey =
  | 'required'
  | 'invalidEmail'
  | 'tooShort'
  | 'tooLong'
  | 'mismatch'
  | 'invalidPattern';

// ── Rule factories ──

export const required = { _rule: 'required' as const };

export const email = { _rule: 'email' as const };

export const minLength = (n: number) => ({ _rule: 'minLength' as const, n });

export const maxLength = (n: number) => ({ _rule: 'maxLength' as const, n });

export const match = (field: string) => ({ _rule: 'match' as const, field });

export const pattern = (re: RegExp) => ({ _rule: 'pattern' as const, re });

// ── Discriminated union ──

export type Rule =
  | typeof required
  | typeof email
  | ReturnType<typeof minLength>
  | ReturnType<typeof maxLength>
  | ReturnType<typeof match>
  | ReturnType<typeof pattern>;

// ── Validator factory ──

export type Validator<T = unknown> = {
  _validator: true;
  rules: Rule[];
};

export function v<T = string>(...rules: Rule[]): Validator<T> {
  return { _validator: true, rules };
}

// ── Field validation ──

function validateField(
  validator: Validator,
  value: unknown,
  allValues: Record<string, unknown>
): ErrorKey | undefined {
  const raw = typeof value === 'string' ? value : '';

  for (const rule of validator.rules) {
    const err = checkRule(rule, raw, allValues);
    if (err) return err;
  }
  return undefined;
}

function checkRule(
  rule: Rule,
  value: string,
  allValues: Record<string, unknown>
): ErrorKey | undefined {
  switch (rule._rule) {
    case 'required':
      return value.trim().length === 0 ? 'required' : undefined;
    case 'email':
      return !EMAIL_REGEX.test(value.trim()) ? 'invalidEmail' : undefined;
    case 'minLength':
      return value.length < rule.n ? 'tooShort' : undefined;
    case 'maxLength':
      return value.length > rule.n ? 'tooLong' : undefined;
    case 'match': {
      const target = allValues[rule.field];
      const targetStr = typeof target === 'string' ? target : '';
      // 目标字段为空时不触发 mismatch（避免与 required 重复）
      if (targetStr.trim().length === 0) return undefined;
      return value !== targetStr ? 'mismatch' : undefined;
    }
    case 'pattern':
      return !rule.re.test(value) ? 'invalidPattern' : undefined;
  }
}

// ── Schema validation ──

export function validateAll<S extends Record<string, Validator>>(
  schema: S,
  values: { [K in keyof S]: unknown }
): { [K in keyof S]?: ErrorKey } {
  const errors: Record<string, ErrorKey> = {};
  for (const key in schema) {
    const err = validateField(schema[key], values[key], values);
    if (err) errors[key] = err;
  }
  return errors;
}
