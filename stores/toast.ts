import { create } from 'zustand';

/** Visual style of a toast. `warning` is used for recoverable user-facing
 *  notices (e.g. empty voice transcription). `default` is a neutral info.
 *  `success` renders a green checkmark (e.g. download/save succeeded). */
export type ToastVariant = 'default' | 'warning' | 'success';

export interface Toast {
  /** Stable unique id (returned by showToast so callers can dismiss early). */
  id: string;
  message: string;
  variant: ToastVariant;
}

export interface ShowToastOptions {
  message: string;
  variant?: ToastVariant;
  /** Auto-hide delay in ms. Defaults to 2500. <=0 keeps it until hideToast. */
  durationMs?: number;
}

/** Per-toast auto-hide timers. Keyed by toast id. */
const timers: Record<string, ReturnType<typeof setTimeout>> = {};

const DEFAULT_DURATION_MS = 2500;

let idCounter = 0;
function genId(): string {
  idCounter += 1;
  return `toast_${Date.now()}_${idCounter}`;
}

interface ToastStore {
  toasts: Toast[];
  /** Show a toast. Returns the toast id (can be passed to hideToast). */
  showToast: (options: ShowToastOptions) => string;
  /** Immediately dismiss a toast by id. Safe to call with unknown ids. */
  hideToast: (id: string) => void;
  /** Dismiss every active toast and cancel their timers. */
  clearToasts: () => void;
}

function clearTimer(id: string): void {
  const t = timers[id];
  if (t) {
    clearTimeout(t);
    delete timers[id];
  }
}

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],

  showToast: ({ message, variant = 'default', durationMs = DEFAULT_DURATION_MS }) => {
    const id = genId();
    const toast: Toast = { id, message, variant };
    set((state) => ({ toasts: [...state.toasts, toast] }));

    if (durationMs > 0) {
      // Clear any prior timer for this id (defensive — id is unique so this is a no-op).
      clearTimer(id);
      timers[id] = setTimeout(() => {
        delete timers[id];
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
      }, durationMs);
    }

    return id;
  },

  hideToast: (id) => {
    if (!get().toasts.some((t) => t.id === id)) return;
    clearTimer(id);
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  clearToasts: () => {
    Object.keys(timers).forEach(clearTimer);
    set({ toasts: [] });
  },
}));
