import type { ScreenProps } from "../app.tsx";
import { Icon } from "../components/Icon.tsx";
import { Link, Notice } from "../components/ui.tsx";
import { useHotkeys } from "../hotkeys.ts";
import { navigate, PROFILE_TABS, type ProfileTab } from "../router.ts";
import { workspace } from "../state/store.ts";
import { AnswersEditor } from "./profile/AnswersEditor.tsx";
import { BankEditor } from "./profile/BankEditor.tsx";
import { BaseEditor, BaseList } from "./profile/Bases.tsx";
import { ContactForm } from "./profile/ContactForm.tsx";
import { PreferencesForm } from "./profile/PreferencesForm.tsx";

const TAB_LABELS: Record<ProfileTab, string> = {
  experience: "Experience bank",
  bases: "Base CVs",
  contact: "Contact",
  preferences: "Preferences",
  answers: "Saved answers",
};

export function ProfileScreen(props: ScreenProps & { tab: ProfileTab; baseId: string | null }) {
  const { tab, baseId } = props;
  const bank = workspace.value?.profile.bank;
  const isNew = !bank || bank.entries === 0;

  useHotkeys(
    PROFILE_TABS.map((t, i) => ({
      keys: String(i + 1),
      group: "Profile",
      description: TAB_LABELS[t],
      hidden: i > 0,
      run: () => navigate(`/profile/${t}`, { replace: true }),
    })),
  );

  return (
    <>
      {props.frame(
        "Profile",
        <button type="button" class="btn" onClick={() => navigate("/onboarding")}>
          <Icon name="today" size={14} /> Onboarding
        </button>,
      )}
      <nav class="tabs" aria-label="Profile sections">
        {PROFILE_TABS.map((t, i) => (
          <Link
            key={t}
            href={`/profile/${t}`}
            class="tab"
            aria-current={t === tab ? "page" : undefined}
          >
            {TAB_LABELS[t]}
            {t === "experience" && bank && bank.entries > bank.confirmed ? (
              <span class="badge warning">{bank.entries - bank.confirmed}</span>
            ) : null}
            <kbd>{i + 1}</kbd>
          </Link>
        ))}
      </nav>
      <div class="content">
        <div class={`page${tab === "bases" && baseId ? " page-wide" : ""}`}>
          {isNew && tab === "experience" ? (
            <Notice>
              New here? <Link href="/onboarding">Start onboarding</Link>: import your existing CVs
              and Claude drafts your experience bank for you to review.
            </Notice>
          ) : null}
          {tab === "experience" ? <BankEditor /> : null}
          {tab === "bases" ? baseId ? <BaseEditor key={baseId} id={baseId} /> : <BaseList /> : null}
          {tab === "contact" ? <ContactForm /> : null}
          {tab === "preferences" ? <PreferencesForm /> : null}
          {tab === "answers" ? <AnswersEditor /> : null}
        </div>
      </div>
    </>
  );
}
