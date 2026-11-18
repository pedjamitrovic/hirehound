import { Fragment } from "preact";
import { activeHotkeys, type Hotkey } from "../hotkeys.ts";
import { Dialog } from "./Dialog.tsx";
import { Kbd } from "./ui.tsx";

/** Lists the shortcuts active on the current screen, grouped. Opened with "?". */
export function ShortcutSheet(props: { onClose: () => void }) {
  const groups = new Map<string, Hotkey[]>();
  for (const hotkey of activeHotkeys()) {
    const list = groups.get(hotkey.group) ?? [];
    list.push(hotkey);
    groups.set(hotkey.group, list);
  }
  return (
    <Dialog title="Keyboard shortcuts" onClose={props.onClose} wide>
      <div class="shortcuts">
        {[...groups].map(([group, hotkeys]) => (
          <section key={group}>
            <h3>{group}</h3>
            <dl>
              {hotkeys.map((h) => (
                <Fragment key={h.keys}>
                  <dt>{h.description}</dt>
                  <dd>
                    <Kbd keys={h.keys} />
                  </dd>
                </Fragment>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
