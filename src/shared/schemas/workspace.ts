import { z } from "zod";
import { IsoDateTime, Version } from "./common.ts";

/** hirehound.yaml at the workspace root: marks a folder as a Hirehound workspace. */
export const WorkspaceManifest = z.object({
  version: Version,
  created_at: IsoDateTime,
});

export type WorkspaceManifest = z.infer<typeof WorkspaceManifest>;
