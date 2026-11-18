import { useState } from "preact/hooks";
import type { Contact } from "../../../shared/schemas/contact.ts";
import type { ContactSuggestion } from "../../../shared/schemas/onboarding.ts";
import { api } from "../../api.ts";
import { Icon } from "../../components/Icon.tsx";
import { Notice } from "../../components/ui.tsx";

import {
  type FieldErrors,
  FileProblems,
  ProfileLoading,
  SaveBar,
  TextField,
  useProfileFile,
} from "./profile-form.tsx";

const CONTACT_FILE = "profile/contact.yaml";

type LinkRow = { label: string; url: string };

type ContactDraft = {
  name: string;
  email: string;
  phone: string;
  location: string;
  links: LinkRow[];
};

type SingleField = "name" | "email" | "phone" | "location";

const FIELD_LABELS: Record<SingleField, string> = {
  name: "Name",
  email: "Email",
  phone: "Phone",
  location: "Location",
};

function contactDraft(value: Contact | null): ContactDraft {
  return {
    name: value?.name ?? "",
    email: value?.email ?? "",
    phone: value?.phone ?? "",
    location: value?.location ?? "",
    links: (value?.links ?? []).map((l) => ({ label: l.label, url: l.url })),
  };
}

/** "github.com/you" -> "https://github.com/you"; anything with a scheme stays as typed. */
function withScheme(url: string): string {
  const trimmed = url.trim();
  if (trimmed === "" || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function normalizeContact(d: ContactDraft): ContactDraft {
  return {
    name: d.name.trim(),
    email: d.email.trim(),
    phone: d.phone.trim(),
    location: d.location.trim(),
    links: d.links
      .filter((l) => l.label.trim() !== "" || l.url.trim() !== "")
      .map((l) => ({ label: l.label.trim(), url: withScheme(l.url) })),
  };
}

function contactErrors(d: ContactDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (!d.name) errors.name = "Enter your name";
  if (!d.email) errors.email = "Enter your email address";
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email))
    errors.email = "Enter a valid email address";
  d.links.forEach((link, i) => {
    if (!link.label) errors[`links[${i}].label`] = "Add a label, like LinkedIn";
    if (!link.url) errors[`links[${i}].url`] = "Add the link";
    else if (!URL.canParse(link.url)) {
      errors[`links[${i}].url`] = "Enter a full link, like https://github.com/you";
    }
  });
  return errors;
}

function contactValue(d: ContactDraft): unknown {
  return {
    version: 1,
    name: d.name.trim(),
    email: d.email.trim(),
    phone: d.phone.trim() || undefined,
    location: d.location.trim() || undefined,
    links: d.links.map((l) => ({ label: l.label.trim(), url: l.url.trim() })),
  };
}

const showsContact = (path: string) =>
  /^(name|email|phone|location)$/.test(path) || /^links\[\d+\]\.(label|url)$/.test(path);

/** What the suggestion can fill without touching anything the user already entered. */
function suggestionFills(
  suggestion: ContactSuggestion | null | undefined,
  d: ContactDraft,
): { fields: { key: SingleField; value: string }[]; links: LinkRow[] } {
  if (!suggestion) return { fields: [], links: [] };
  const fields = (["name", "email", "phone", "location"] as const).flatMap((key) => {
    const value = suggestion[key]?.trim();
    return value && d[key].trim() === "" ? [{ key, value }] : [];
  });
  const hasLinks = d.links.some((l) => l.label.trim() !== "" || l.url.trim() !== "");
  const links = hasLinks
    ? []
    : (suggestion.links ?? [])
        .filter((l) => l.url.trim() !== "")
        .map((l) => ({ label: l.label.trim() || "Link", url: l.url.trim() }));
  return { fields, links };
}

/** Name, email, phone, location and links for the CV header (profile/contact.yaml). */
export function ContactForm(props: {
  onSaved?: () => void;
  suggestion?: ContactSuggestion | null;
}) {
  const form = useProfileFile<Contact, ContactDraft>({
    fileName: CONTACT_FILE,
    load: api.contact,
    save: api.saveContact,
    toDraft: contactDraft,
    toValue: contactValue,
    normalize: normalizeContact,
    validate: contactErrors,
    shows: showsContact,
    onSaved: props.onSaved,
  });
  const [dismissed, setDismissed] = useState(false);

  if (!form.file) {
    return (
      <ProfileLoading
        title="Contact"
        fileName={CONTACT_FILE}
        error={form.loadError}
        onRetry={form.retry}
      />
    );
  }

  const d = form.draft;
  const e = form.errors;
  const set = (patch: Partial<ContactDraft>, path: string) => form.update({ ...d, ...patch }, path);
  const setLink = (index: number, patch: Partial<LinkRow>, path: string) =>
    form.update(
      { ...d, links: d.links.map((l, i) => (i === index ? { ...l, ...patch } : l)) },
      path,
    );

  const fills = suggestionFills(props.suggestion, d);
  const canFill = !dismissed && fills.fields.length + fills.links.length > 0;
  const applySuggestion = () => {
    const next = { ...d };
    for (const fill of fills.fields) next[fill.key] = fill.value;
    if (fills.links.length > 0) {
      next.links = [...d.links.filter((l) => l.label.trim() || l.url.trim()), ...fills.links];
    }
    form.update(next, ...fills.fields.map((f) => f.key), "links");
  };

  return (
    <form
      class="form-stack"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.save();
      }}
    >
      <section class="card">
        <header class="card-header">
          <h2>Contact</h2>
        </header>
        <div class="card-body form-body">
          <p class="muted">Your CV header is built from these details.</p>
          <FileProblems file={form.file} fileName={CONTACT_FILE} />
          {canFill ? (
            <Notice>
              <div class="suggestion">
                <span>Found in your files:</span>
                <ul class="suggestion-list">
                  {fills.fields.map((f) => (
                    <li key={f.key}>
                      <span class="muted">{FIELD_LABELS[f.key]}</span> {f.value}
                    </li>
                  ))}
                  {fills.links.map((l) => (
                    <li key={l.url}>
                      <span class="muted">{l.label}</span> {l.url}
                    </li>
                  ))}
                </ul>
                <div class="suggestion-actions">
                  <button type="button" class="btn small" onClick={applySuggestion}>
                    Use these
                  </button>
                  <button type="button" class="btn ghost small" onClick={() => setDismissed(true)}>
                    Dismiss
                  </button>
                </div>
              </div>
            </Notice>
          ) : null}
          <div class="form-grid">
            <TextField
              id="contact-name"
              label="Name"
              value={d.name}
              autocomplete="name"
              error={e.name}
              onInput={(v) => set({ name: v }, "name")}
            />
            <TextField
              id="contact-email"
              label="Email"
              type="email"
              value={d.email}
              autocomplete="email"
              error={e.email}
              onInput={(v) => set({ email: v }, "email")}
            />
            <TextField
              id="contact-phone"
              label="Phone (optional)"
              type="tel"
              value={d.phone}
              autocomplete="tel"
              error={e.phone}
              onInput={(v) => set({ phone: v }, "phone")}
            />
            <TextField
              id="contact-location"
              label="Location (optional)"
              value={d.location}
              placeholder="City, Country"
              error={e.location}
              onInput={(v) => set({ location: v }, "location")}
            />
          </div>
          <div class="field">
            <span class="label" id="contact-links-label">
              Links
            </span>
            {d.links.length > 0 ? (
              <ul class="link-rows" aria-labelledby="contact-links-label">
                {d.links.map((link, i) => {
                  const labelError = e[`links[${i}].label`];
                  const urlError = e[`links[${i}].url`];
                  return (
                    // Rows are plain controlled inputs, so the position is a stable enough key.
                    <li key={`link-${i}`} class="link-row">
                      <input
                        class="input"
                        aria-label={`Label for link ${i + 1}`}
                        placeholder="LinkedIn"
                        value={link.label}
                        aria-invalid={labelError ? "true" : undefined}
                        onInput={(ev) =>
                          setLink(i, { label: ev.currentTarget.value }, `links[${i}].label`)
                        }
                      />
                      <input
                        class="input"
                        type="url"
                        aria-label={`Address for link ${i + 1}`}
                        placeholder="https://www.linkedin.com/in/you"
                        value={link.url}
                        aria-invalid={urlError ? "true" : undefined}
                        onInput={(ev) =>
                          setLink(i, { url: ev.currentTarget.value }, `links[${i}].url`)
                        }
                      />
                      <button
                        type="button"
                        class="btn ghost icon"
                        aria-label={`Remove link ${i + 1}`}
                        title="Remove link"
                        onClick={() =>
                          form.update({ ...d, links: d.links.filter((_, j) => j !== i) }, "links")
                        }
                      >
                        <Icon name="trash" size={14} />
                      </button>
                      {labelError || urlError ? (
                        <span class="error">
                          {[labelError, urlError].filter(Boolean).join(". ")}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <div>
              <button
                type="button"
                class="btn ghost small"
                onClick={() => form.update({ ...d, links: [...d.links, { label: "", url: "" }] })}
              >
                <Icon name="plus" size={12} /> Add link
              </button>
            </div>
            <span class="hint">
              Shown in your CV header, for example LinkedIn, GitHub or a personal site.
            </span>
          </div>
        </div>
        <SaveBar form={form} fileName={CONTACT_FILE} />
      </section>
    </form>
  );
}
