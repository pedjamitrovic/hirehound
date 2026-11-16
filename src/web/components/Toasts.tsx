import { dismissToast, toasts } from "../state/toasts.ts";
import { Icon } from "./Icon.tsx";

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div class="toast" data-kind={t.kind} key={t.id}>
          <span>{t.message}</span>
          {t.action ? (
            <button
              type="button"
              class="btn small"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : (
            <button
              type="button"
              class="btn ghost icon small"
              aria-label="Dismiss"
              onClick={() => dismissToast(t.id)}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
