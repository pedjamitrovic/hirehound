import { z } from "zod";

/** Every workspace YAML file carries a schema version so files can be migrated later. */
export const Version = z.literal(1).default(1);

export const IsoDate = z.iso.date(); // 2026-11-16
export const IsoDateTime = z.iso.datetime({ offset: true }); // 2026-11-16T10:42:00+01:00
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, "expected an ISO 4217 code like EUR");
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, "expected an ISO 3166 code like RS");
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected a lowercase hex SHA-256");

/** Experience-bank entry id: ROLE-003, ACH-014, SKL-021, EDU-001. */
export const BankId = z.string().regex(/^[A-Z]{2,5}-\d{3,}$/, "expected a bank id like ACH-014");

/** Base profile id = file stem in profile/bases/ (em.md -> "em"). */
export const BaseId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "expected a lowercase id like em or senior-swe");

/** Job id = folder name under jobs/: <found date>_<company slug>_<role slug>. */
export const JOB_ID_PATTERN = /^\d{4}-\d{2}-\d{2}_[a-z0-9-]{1,30}_[a-z0-9-]{1,52}$/;
export const JobId = z.string().regex(JOB_ID_PATTERN, "expected a job id like 2026-11-16_acme_em");

export const Period = z.enum(["year", "month", "day", "hour"]);

export const SalaryRange = z
  .object({
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
    currency: CurrencyCode,
    period: Period.default("year"),
    /** As written in the posting, e.g. "EUR 90-110k + equity". */
    raw: z.string().optional(),
  })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
    message: "min must be <= max",
  });

export type SalaryRange = z.infer<typeof SalaryRange>;
