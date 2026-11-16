import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "./Icon.tsx";

/**
 * Native modal <dialog>: focus trapping, Escape and the backdrop come from the platform.
 * Render it only while open; closing (Escape, close button, backdrop) calls onClose.
 */
export function Dialog(props: {
  title: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
  /** Submit handler for mod+Enter anywhere in the dialog. */
  onSubmit?: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const onClose = useRef(props.onClose);
  onClose.current = props.onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    dialog.showModal();
    const handleClose = () => onClose.current();
    dialog.addEventListener("close", handleClose);
    return () => {
      dialog.removeEventListener("close", handleClose);
      if (dialog.open) dialog.close();
      opener?.focus?.();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      class={`dialog${props.wide ? " wide" : ""}`}
      onClick={(event) => {
        // A click on the backdrop targets the dialog element itself.
        if (event.target === ref.current) ref.current?.close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && props.onSubmit) {
          event.preventDefault();
          props.onSubmit();
        }
      }}
    >
      <div class="dialog-header">
        <h2>{props.title}</h2>
        <button
          type="button"
          class="btn ghost icon"
          aria-label="Close"
          onClick={() => ref.current?.close()}
        >
          <Icon name="close" />
        </button>
      </div>
      <div class="dialog-body">{props.children}</div>
      {props.footer ? <div class="dialog-footer">{props.footer}</div> : null}
    </dialog>
  );
}
