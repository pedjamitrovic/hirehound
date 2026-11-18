import { z } from "zod";
import { ATS_PROVIDERS } from "../enums.ts";
import { Version } from "./common.ts";

/** One company job board to watch: sources/portals.yaml, under `portals`. */
export const Portal = z.object({
  /** Stable key, lowercase: "acme". */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "expected a lowercase id like acme"),
  company: z.string().trim().min(1),
  provider: z.enum(ATS_PROVIDERS),
  /** The board's name in its public URL: boards.greenhouse.io/<board>, jobs.lever.co/<board>. */
  board: z.string().regex(/^[A-Za-z0-9._-]+$/, "expected the board name from its URL"),
  /** Lever only: boards hosted in the EU live on jobs.eu.lever.co. */
  region: z.enum(["global", "eu"]).default("global"),
  /** Keep postings whose title contains any of these (empty: all titles). */
  titles: z.array(z.string().trim().min(1)).default([]),
  /** Drop postings whose title contains any of these. */
  exclude_titles: z.array(z.string().trim().min(1)).default([]),
  /** Keep postings whose location contains any of these (empty: anywhere). */
  locations: z.array(z.string().trim().min(1)).default([]),
  enabled: z.boolean().default(true),
});

export const PortalsFile = z
  .object({
    version: Version,
    schedule: z
      .object({
        /** Scan every N hours while Hirehound runs; 0 turns scheduled scans off. */
        every_hours: z.number().int().min(0).max(168).default(12),
      })
      .prefault({}),
    portals: z.array(Portal).default([]),
  })
  .refine((f) => new Set(f.portals.map((p) => p.id)).size === f.portals.length, {
    message: "portal ids must be unique",
    path: ["portals"],
  });

export type Portal = z.infer<typeof Portal>;
export type PortalsFile = z.infer<typeof PortalsFile>;
