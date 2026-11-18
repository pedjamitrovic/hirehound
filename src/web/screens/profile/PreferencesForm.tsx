import type { Preferences } from "../../../shared/schemas/preferences.ts";
import { api } from "../../api.ts";
import {
  Check,
  errorAt,
  type FieldErrors,
  FileProblems,
  listValue,
  ProfileLoading,
  SaveBar,
  TextField,
  useProfileFile,
  within,
} from "./profile-form.tsx";

const PREFERENCES_FILE = "profile/preferences.yaml";

type Seniority = Preferences["roles"]["seniority"][number];
type CompanySize = Preferences["company"]["sizes"][number];
type Remote = Preferences["location"]["remote"];
type Period = NonNullable<Preferences["compensation"]["floor"]>["period"];
type CoverPolicy = Preferences["cover_letter"]["policy"];
type ApplyMode = Preferences["apply"]["mode"];
type Paper = Preferences["cv"]["paper"];

// Literal copies of the schema enums: the schemas are Zod values and stay out of the bundle.
const SENIORITY: { value: Seniority; label: string }[] = [
  { value: "mid", label: "Mid" },
  { value: "senior", label: "Senior" },
  { value: "staff", label: "Staff" },
  { value: "principal", label: "Principal" },
  { value: "manager", label: "Manager" },
  { value: "senior-manager", label: "Senior manager" },
  { value: "director", label: "Director" },
  { value: "vp", label: "VP" },
];

const SENIORITY_VALUES = SENIORITY.map((s) => s.value);

const SIZES: CompanySize[] = ["1-10", "11-50", "51-200", "201-1000", "1001-5000", "5000+"];

const REMOTE: { value: Remote; label: string }[] = [
  { value: "remote-only", label: "Remote only" },
  { value: "hybrid-ok", label: "Hybrid is fine" },
  { value: "onsite-ok", label: "On site is fine" },
];

const PERIODS: { value: Period; label: string }[] = [
  { value: "year", label: "Per year" },
  { value: "month", label: "Per month" },
  { value: "day", label: "Per day" },
  { value: "hour", label: "Per hour" },
];

const COVER_POLICIES: { value: CoverPolicy; label: string }[] = [
  { value: "always", label: "Always" },
  { value: "when-requested", label: "Only when the posting asks" },
  { value: "never", label: "Never" },
];

const APPLY_MODES: { value: ApplyMode; label: string }[] = [
  { value: "manual", label: "Manual" },
  { value: "assisted", label: "Assisted" },
];

const PAPERS: { value: Paper; label: string }[] = [
  { value: "a4", label: "A4" },
  { value: "letter", label: "US Letter" },
];

const PAGES = [1, 2, 3, 4] as const;

const TIME_ZONES: string[] =
  typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];

type PrefsDraft = {
  country: string;
  city: string;
  timezone: string;
  remote: Remote;
  locations: string;
  authorization: string;
  sponsorship: boolean;
  relocation: boolean;
  seniority: Seniority[];
  excludeTitles: string;
  floorMin: string;
  floorCurrency: string;
  floorPeriod: Period;
  sizes: CompanySize[];
  excludeIndustries: string;
  excludeCompanies: string;
  dealBreakers: string;
  threshold: string;
  coverLetter: CoverPolicy;
  applyMode: ApplyMode;
  maxPages: number;
  paper: Paper;
};

function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
}

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** "90 000" or "90,000" -> 90000; empty -> null; anything else -> NaN. */
function parseAmount(text: string): number | null {
  const cleaned = text.replace(/[\s,_]/g, "");
  if (cleaned === "") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : Number.NaN;
}

function prefsDraft(v: Preferences | null): PrefsDraft {
  const floor = v?.compensation.floor;
  return {
    country: v?.location.based_in.country ?? "",
    city: v?.location.based_in.city ?? "",
    timezone: v?.location.timezone ?? localTimeZone(),
    remote: v?.location.remote ?? "hybrid-ok",
    locations: (v?.location.acceptable_locations ?? []).join(", "),
    authorization: (v?.location.work_authorization ?? []).join(", "),
    sponsorship: v?.location.needs_sponsorship_elsewhere ?? true,
    relocation: v?.location.open_to_relocation ?? false,
    seniority: v?.roles.seniority ?? [],
    excludeTitles: (v?.roles.exclude_title_keywords ?? []).join(", "),
    floorMin: floor?.min === undefined ? "" : String(floor.min),
    floorCurrency: floor?.currency ?? "",
    floorPeriod: floor?.period ?? "year",
    sizes: v?.company.sizes ?? [],
    excludeIndustries: (v?.company.exclude_industries ?? []).join(", "),
    excludeCompanies: (v?.company.exclude_companies ?? []).join(", "),
    dealBreakers: (v?.deal_breakers ?? []).join("\n"),
    threshold: String(v?.scoring.threshold ?? 70),
    coverLetter: v?.cover_letter.policy ?? "when-requested",
    applyMode: v?.apply.mode ?? "manual",
    maxPages: v?.cv.max_pages ?? 2,
    paper: v?.cv.paper ?? "a4",
  };
}

function prefsErrors(d: PrefsDraft): FieldErrors {
  const errors: FieldErrors = {};
  const country = d.country.trim().toUpperCase();
  if (!country) errors["location.based_in.country"] = "Enter the country you live in";
  else if (!/^[A-Z]{2}$/.test(country)) {
    errors["location.based_in.country"] = "Use a 2-letter code, like RS or DE";
  }
  const timezone = d.timezone.trim();
  if (!timezone) errors["location.timezone"] = "Enter your time zone";
  else if (!isTimeZone(timezone)) {
    errors["location.timezone"] = "Unknown time zone. Use a name like Europe/Berlin";
  }
  if (d.floorMin.trim() !== "") {
    if (Number.isNaN(parseAmount(d.floorMin))) {
      errors["compensation.floor.min"] = "Enter a number, like 90000";
    }
    if (!/^[A-Z]{3}$/.test(d.floorCurrency.trim().toUpperCase())) {
      errors["compensation.floor.currency"] = "Use a 3-letter code, like EUR";
    }
  }
  const threshold = Number(d.threshold);
  if (
    d.threshold.trim() === "" ||
    !Number.isInteger(threshold) ||
    threshold < 0 ||
    threshold > 100
  ) {
    errors["scoring.threshold"] = "Enter a whole number from 0 to 100";
  }
  return errors;
}

/** Starts from the loaded value and overwrites only what this form edits. */
function prefsValue(d: PrefsDraft, base: Preferences | null): unknown {
  const floorMin = parseAmount(d.floorMin);
  return {
    ...base,
    version: 1,
    roles: {
      ...base?.roles,
      seniority: SENIORITY_VALUES.filter((s) => d.seniority.includes(s)),
      exclude_title_keywords: listValue(d.excludeTitles, base?.roles.exclude_title_keywords),
    },
    location: {
      ...base?.location,
      based_in: {
        ...base?.location.based_in,
        country: d.country.trim().toUpperCase(),
        city: d.city.trim() || undefined,
      },
      timezone: d.timezone.trim(),
      remote: d.remote,
      acceptable_locations: listValue(d.locations, base?.location.acceptable_locations),
      work_authorization: listValue(d.authorization, base?.location.work_authorization),
      needs_sponsorship_elsewhere: d.sponsorship,
      open_to_relocation: d.relocation,
    },
    compensation: {
      ...base?.compensation,
      floor:
        floorMin === null
          ? undefined
          : {
              ...base?.compensation.floor,
              min: floorMin,
              currency: d.floorCurrency.trim().toUpperCase(),
              period: d.floorPeriod,
            },
    },
    company: {
      ...base?.company,
      sizes: SIZES.filter((s) => d.sizes.includes(s)),
      exclude_industries: listValue(d.excludeIndustries, base?.company.exclude_industries),
      exclude_companies: listValue(d.excludeCompanies, base?.company.exclude_companies),
    },
    deal_breakers: listValue(d.dealBreakers, base?.deal_breakers, "\n"),
    scoring: { ...base?.scoring, threshold: Number(d.threshold) },
    cover_letter: { ...base?.cover_letter, policy: d.coverLetter },
    apply: { ...base?.apply, mode: d.applyMode },
    cv: { ...base?.cv, max_pages: d.maxPages, paper: d.paper },
  };
}

const SHOWN = [
  "location.based_in.country",
  "location.based_in.city",
  "location.timezone",
  "location.remote",
  "location.acceptable_locations",
  "location.work_authorization",
  "roles.seniority",
  "roles.exclude_title_keywords",
  "compensation.floor",
  "company.sizes",
  "company.exclude_industries",
  "company.exclude_companies",
  "deal_breakers",
  "scoring.threshold",
  "cover_letter.policy",
  "apply.mode",
  "cv.max_pages",
  "cv.paper",
];

const showsPrefs = (path: string) => SHOWN.some((prefix) => within(path, prefix));

/** Checks or unchecks `value`, keeping the order of `all` so toggling back is not a change. */
function toggle<V>(all: readonly V[], list: readonly V[], value: V, on: boolean): V[] {
  return all.filter((v) => (v === value ? on : list.includes(v)));
}

function FieldError(props: { id: string; message: string | undefined }) {
  return props.message ? (
    <span class="error" id={props.id}>
      {props.message}
    </span>
  ) : null;
}

/** What you are looking for (profile/preferences.yaml), in short grouped cards. */
export function PreferencesForm(props: { onSaved?: () => void }) {
  const form = useProfileFile<Preferences, PrefsDraft>({
    fileName: PREFERENCES_FILE,
    load: api.preferences,
    save: api.savePreferences,
    toDraft: prefsDraft,
    toValue: prefsValue,
    validate: prefsErrors,
    shows: showsPrefs,
    onSaved: props.onSaved,
  });

  if (!form.file) {
    return (
      <ProfileLoading
        title="Preferences"
        fileName={PREFERENCES_FILE}
        error={form.loadError}
        onRetry={form.retry}
      />
    );
  }

  const d = form.draft;
  const e = form.errors;
  const set = (patch: Partial<PrefsDraft>, path: string) => form.update({ ...d, ...patch }, path);
  const floorMinError =
    errorAt(e, "compensation.floor.min") ?? e["compensation.floor"] ?? e["compensation.floor.max"];

  return (
    <form
      class="form-stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.save();
      }}
    >
      <FileProblems file={form.file} fileName={PREFERENCES_FILE} />

      <section class="card">
        <header class="card-header">
          <h2>Location</h2>
        </header>
        <div class="card-body form-body">
          <p class="muted">Where you live and where you can work.</p>
          <div class="form-grid">
            <TextField
              id="pref-country"
              label="Country"
              value={d.country}
              placeholder="RS"
              maxlength={2}
              autocomplete="country"
              hint="2-letter code"
              error={errorAt(e, "location.based_in.country")}
              onInput={(v) => set({ country: v.toUpperCase() }, "location.based_in.country")}
            />
            <TextField
              id="pref-city"
              label="City (optional)"
              value={d.city}
              autocomplete="address-level2"
              error={errorAt(e, "location.based_in.city")}
              onInput={(v) => set({ city: v }, "location.based_in.city")}
            />
            <TextField
              id="pref-timezone"
              label="Time zone"
              value={d.timezone}
              list="pref-timezones"
              placeholder="Europe/Berlin"
              hint="Used to judge how well a team's working hours overlap with yours."
              error={errorAt(e, "location.timezone")}
              onInput={(v) => set({ timezone: v }, "location.timezone")}
            />
            <datalist id="pref-timezones">
              {TIME_ZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <div class="field span-2">
              <span class="label">Remote work</span>
              <fieldset class="btn-group">
                <legend class="visually-hidden">Remote work</legend>
                {REMOTE.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    class="btn"
                    aria-pressed={d.remote === r.value}
                    onClick={() => set({ remote: r.value }, "location.remote")}
                  >
                    {r.label}
                  </button>
                ))}
              </fieldset>
              <FieldError id="pref-remote-error" message={errorAt(e, "location.remote")} />
            </div>
            <TextField
              id="pref-locations"
              class="span-2"
              label="Acceptable locations"
              value={d.locations}
              placeholder="Remote (EU), Berlin"
              hint="Where you would work from, separated by commas."
              error={errorAt(e, "location.acceptable_locations")}
              onInput={(v) => set({ locations: v }, "location.acceptable_locations")}
            />
            <TextField
              id="pref-authorization"
              class="span-2"
              label="Work authorization"
              value={d.authorization}
              placeholder="RS, EU"
              hint="Countries or regions where you can work without a visa, separated by commas."
              error={errorAt(e, "location.work_authorization")}
              onInput={(v) => set({ authorization: v }, "location.work_authorization")}
            />
            <div class="field span-2 check-stack">
              <Check
                label="I need visa sponsorship to work anywhere else"
                checked={d.sponsorship}
                onChange={(on) => set({ sponsorship: on }, "location.needs_sponsorship_elsewhere")}
              />
              <Check
                label="Open to relocation"
                checked={d.relocation}
                onChange={(on) => set({ relocation: on }, "location.open_to_relocation")}
              />
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <header class="card-header">
          <h2>Roles</h2>
        </header>
        <div class="card-body form-body">
          <fieldset class="field fieldset">
            <legend class="label">Seniority</legend>
            <div class="check-list">
              {SENIORITY.map((s) => (
                <Check
                  key={s.value}
                  label={s.label}
                  checked={d.seniority.includes(s.value)}
                  onChange={(on) =>
                    set(
                      { seniority: toggle(SENIORITY_VALUES, d.seniority, s.value, on) },
                      "roles.seniority",
                    )
                  }
                />
              ))}
            </div>
            <span class="hint">The levels you are aiming for. Leave all unchecked for any.</span>
            <FieldError id="pref-seniority-error" message={errorAt(e, "roles.seniority")} />
          </fieldset>
          <TextField
            id="pref-exclude-titles"
            label="Skip titles with"
            value={d.excludeTitles}
            placeholder="intern, sales"
            hint="Jobs with any of these words in the title are skipped. Separate with commas."
            error={errorAt(e, "roles.exclude_title_keywords")}
            onInput={(v) => set({ excludeTitles: v }, "roles.exclude_title_keywords")}
          />
        </div>
      </section>

      <section class="card">
        <header class="card-header">
          <h2>Compensation</h2>
        </header>
        <div class="card-body form-body">
          <p class="muted">
            Roles that pay less than your floor are flagged in evaluations. Leave the minimum empty
            for no floor.
          </p>
          <div class="form-grid three">
            <TextField
              id="pref-floor-min"
              label="Minimum"
              value={d.floorMin}
              inputmode="numeric"
              placeholder="90000"
              error={floorMinError}
              onInput={(v) => set({ floorMin: v }, "compensation.floor.min")}
            />
            <TextField
              id="pref-floor-currency"
              label="Currency"
              value={d.floorCurrency}
              maxlength={3}
              placeholder="EUR"
              error={errorAt(e, "compensation.floor.currency")}
              onInput={(v) =>
                set({ floorCurrency: v.toUpperCase() }, "compensation.floor.currency")
              }
            />
            <div class="field">
              <label for="pref-floor-period">Period</label>
              <select
                id="pref-floor-period"
                class="select"
                value={d.floorPeriod}
                onChange={(ev) =>
                  set(
                    { floorPeriod: ev.currentTarget.value as Period },
                    "compensation.floor.period",
                  )
                }
              >
                {PERIODS.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <FieldError
                id="pref-floor-period-error"
                message={errorAt(e, "compensation.floor.period")}
              />
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <header class="card-header">
          <h2>Companies</h2>
        </header>
        <div class="card-body form-body">
          <fieldset class="field fieldset">
            <legend class="label">Company size (employees)</legend>
            <div class="check-list">
              {SIZES.map((size) => (
                <Check
                  key={size}
                  label={size}
                  checked={d.sizes.includes(size)}
                  onChange={(on) =>
                    set({ sizes: toggle(SIZES, d.sizes, size, on) }, "company.sizes")
                  }
                />
              ))}
            </div>
            <span class="hint">Leave all unchecked for any size.</span>
            <FieldError id="pref-sizes-error" message={errorAt(e, "company.sizes")} />
          </fieldset>
          <div class="form-grid">
            <TextField
              id="pref-exclude-industries"
              label="Skip industries"
              value={d.excludeIndustries}
              placeholder="gambling, tobacco"
              hint="Separate with commas."
              error={errorAt(e, "company.exclude_industries")}
              onInput={(v) => set({ excludeIndustries: v }, "company.exclude_industries")}
            />
            <TextField
              id="pref-exclude-companies"
              label="Skip companies"
              value={d.excludeCompanies}
              hint="Separate with commas."
              error={errorAt(e, "company.exclude_companies")}
              onInput={(v) => set({ excludeCompanies: v }, "company.exclude_companies")}
            />
          </div>
        </div>
      </section>

      <section class="card">
        <header class="card-header">
          <h2>Deal-breakers</h2>
        </header>
        <div class="card-body form-body">
          <div class="field">
            <label for="pref-deal-breakers">Deal-breakers</label>
            <textarea
              id="pref-deal-breakers"
              class="textarea"
              rows={4}
              value={d.dealBreakers}
              aria-invalid={errorAt(e, "deal_breakers") ? "true" : undefined}
              aria-describedby="pref-deal-breakers-hint"
              onInput={(ev) => set({ dealBreakers: ev.currentTarget.value }, "deal_breakers")}
            />
            <FieldError id="pref-deal-breakers-error" message={errorAt(e, "deal_breakers")} />
            <span class="hint" id="pref-deal-breakers-hint">
              Anything that rules a job out, one per line. Evaluations check every posting against
              them.
            </span>
          </div>
        </div>
      </section>

      <section class="card">
        <header class="card-header">
          <h2>Decisions</h2>
        </header>
        <div class="card-body form-body">
          <div class="form-grid">
            <TextField
              id="pref-threshold"
              label="Fit score threshold"
              type="number"
              min={0}
              max={100}
              inputmode="numeric"
              value={d.threshold}
              hint="You are warned before approving a job that scores below this."
              error={errorAt(e, "scoring.threshold")}
              onInput={(v) => set({ threshold: v }, "scoring.threshold")}
            />
            <div class="field">
              <label for="pref-cover-letter">Cover letters</label>
              <select
                id="pref-cover-letter"
                class="select"
                value={d.coverLetter}
                onChange={(ev) =>
                  set({ coverLetter: ev.currentTarget.value as CoverPolicy }, "cover_letter.policy")
                }
              >
                {COVER_POLICIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
              <FieldError
                id="pref-cover-letter-error"
                message={errorAt(e, "cover_letter.policy")}
              />
            </div>
            <div class="field">
              <label for="pref-apply-mode">Applying</label>
              <select
                id="pref-apply-mode"
                class="select"
                value={d.applyMode}
                aria-describedby="pref-apply-mode-hint"
                onChange={(ev) =>
                  set({ applyMode: ev.currentTarget.value as ApplyMode }, "apply.mode")
                }
              >
                {APPLY_MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
              <FieldError id="pref-apply-mode-error" message={errorAt(e, "apply.mode")} />
              <span class="hint" id="pref-apply-mode-hint">
                Assisted fills in application forms for you and always stops before Submit.
              </span>
            </div>
            <div class="form-grid" style={{ gap: "8px" }}>
              <div class="field">
                <label for="pref-max-pages">CV length</label>
                <select
                  id="pref-max-pages"
                  class="select"
                  value={String(d.maxPages)}
                  onChange={(ev) =>
                    set({ maxPages: Number(ev.currentTarget.value) }, "cv.max_pages")
                  }
                >
                  {PAGES.map((n) => (
                    <option key={n} value={String(n)}>
                      {n === 1 ? "1 page" : `Up to ${n} pages`}
                    </option>
                  ))}
                </select>
                <FieldError id="pref-max-pages-error" message={errorAt(e, "cv.max_pages")} />
              </div>
              <div class="field">
                <label for="pref-paper">Paper</label>
                <select
                  id="pref-paper"
                  class="select"
                  value={d.paper}
                  onChange={(ev) => set({ paper: ev.currentTarget.value as Paper }, "cv.paper")}
                >
                  {PAPERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
                <FieldError id="pref-paper-error" message={errorAt(e, "cv.paper")} />
              </div>
            </div>
          </div>
        </div>
      </section>

      <p class="muted">
        More settings live in <code>{PREFERENCES_FILE}</code>.
      </p>
      <SaveBar form={form} fileName={PREFERENCES_FILE} standalone />
    </form>
  );
}
