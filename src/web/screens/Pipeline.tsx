import type { ScreenProps } from "../app.tsx";
import { EmptyState } from "../components/ui.tsx";

export function PipelineScreen(props: ScreenProps) {
  return (
    <>
      {props.frame("Pipeline")}
      <div class="content">
        <EmptyState icon="pipeline" title="No jobs yet">
          The board and table views arrive with M1, together with adding jobs.
        </EmptyState>
      </div>
    </>
  );
}
