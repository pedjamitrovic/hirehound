import type { ScreenProps } from "../app.tsx";
import type { IconName } from "../components/Icon.tsx";
import { EmptyState } from "../components/ui.tsx";

/** Screens whose milestone has not landed yet: say what is coming and when, never a dead end. */
export function Placeholder(
  props: ScreenProps & { title: string; icon: IconName; milestone: string; text: string },
) {
  return (
    <>
      {props.frame(props.title)}
      <div class="content">
        <EmptyState icon={props.icon} title={`${props.title} arrives in ${props.milestone}`}>
          {props.text}
        </EmptyState>
      </div>
    </>
  );
}
