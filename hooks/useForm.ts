import { useCallback, useMemo, useState } from 'react';
import { validateAll, type ErrorKey, type Validator } from '@/utils/schema';

type FormOptions<S extends Record<string, Validator>, V> = {
  schema: S;
  initialValues: V;
  onSubmit: (values: V) => Promise<void> | void;
  validateOn?: 'submit' | 'change' | 'blur';
};

type FormReturn<V> = {
  values: V;
  errors: Partial<Record<keyof V, ErrorKey>>;
  touched: Partial<Record<keyof V, boolean>>;
  isValid: boolean;
  isSubmitting: boolean;
  submitError: string | null;
  register: (name: keyof V) => {
    value: string;
    onChangeText: (v: string) => void;
    onBlur: () => void;
  };
  setValue: (name: keyof V, value: unknown) => void;
  setFieldError: (name: keyof V, error: ErrorKey | undefined) => void;
  setSubmitError: (err: string | null) => void;
  handleSubmit: () => Promise<void>;
  reset: () => void;
};

export function useForm<
  S extends Record<string, Validator>,
  V extends Record<string, unknown>
>(opts: FormOptions<S, V>): FormReturn<V> {
  const { schema, initialValues, onSubmit } = opts;

  const [values, setValues] = useState<V>(initialValues);
  // Errors start empty: the user hasn't interacted yet. Validation runs on
  // input change, blur, and submit. UI should gate error display on `touched`
  // (see report-problem.tsx) so first-render stays clean.
  const [errors, setErrors] = useState<
    Partial<Record<keyof V, ErrorKey>>
  >({});
  const [touched, setTouched] = useState<
    Partial<Record<keyof V, boolean>>
  >({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitErrorState] = useState<string | null>(null);
  const [hasSubmitted, setHasSubmitted] = useState(false);

  const revalidate = useCallback(
    (next: V) => {
      const nextErrors = validateAll(
        schema,
        next as { [K in keyof S]: unknown }
      ) as Partial<Record<keyof V, ErrorKey>>;
      setErrors(nextErrors);
      return nextErrors;
    },
    [schema]
  );

  const setValue = useCallback(
    (name: keyof V, value: unknown) => {
      // Clear the previous submit error as soon as the user starts editing
      // any field after a failed submit. Otherwise the stale banner stays
      // visible alongside new field-level errors (e.g. clearing a password
      // field shows both "incorrect password" and "password required").
      setSubmitErrorState(null);
      setValues((prev) => {
        const next = { ...prev, [name]: value } as V;
        revalidate(next);
        return next;
      });
    },
    [revalidate]
  );

  const setFieldError = useCallback(
    (name: keyof V, error: ErrorKey | undefined) => {
      setErrors((prev) => {
        const next = { ...prev };
        if (error === undefined) delete next[name];
        else next[name] = error;
        return next;
      });
    },
    []
  );

  const setSubmitError = useCallback((err: string | null) => {
    setSubmitErrorState(err);
  }, []);

  const handleSubmit = useCallback(async () => {
    setHasSubmitted(true);
    const allTouched: Partial<Record<keyof V, boolean>> = {};
    for (const key in schema) allTouched[key] = true;
    setTouched(allTouched);

    const nextErrors = revalidate(values);
    if (Object.keys(nextErrors).length > 0) return;

    setIsSubmitting(true);
    setSubmitErrorState(null);
    try {
      await onSubmit(values);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setSubmitErrorState(msg);
    } finally {
      setIsSubmitting(false);
    }
  }, [schema, values, onSubmit, revalidate]);

  const reset = useCallback(() => {
    setValues(initialValues);
    setErrors({});
    setTouched({});
    setIsSubmitting(false);
    setSubmitErrorState(null);
    setHasSubmitted(false);
  }, [initialValues]);

  const register = useCallback(
    (name: keyof V) => ({
      value: String(values[name] ?? ''),
      onChangeText: (v: string) => setValue(name, v),
      onBlur: () => {
        setTouched((prev) => ({ ...prev, [name]: true }));
        revalidate(values);
      },
    }),
    [values, setValue, revalidate]
  );

  const isValid = useMemo(
    () => Object.keys(errors).length === 0,
    [errors]
  );

  return {
    values,
    errors,
    touched,
    isValid,
    isSubmitting,
    submitError,
    register,
    setValue,
    setFieldError,
    setSubmitError,
    handleSubmit,
    reset,
  };
}
