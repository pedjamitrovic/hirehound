// Starter files written by `hirehound init`. Profile files start fully commented out, so the
// app treats them as "not set up yet" instead of inventing placeholder data for the CV header.

export const WORKSPACE_README = `# Hirehound workspace

This folder holds all of your Hirehound data as plain files. Hirehound never stores your data
anywhere else, so you can back this folder up with git (use a private repository) or any sync tool.

- profile/      your experience bank, base CVs, contact details, preferences and saved answers
- sources/      job boards and companies to watch
- prompts/      your overrides of the built-in AI prompts
- templates/    your overrides of the CV and cover letter themes
- jobs/         one folder per job: posting snapshot, evaluation, tailored CV, status history

The format of every file is documented in docs/data-contract.md in the Hirehound repository.
Editing files by hand (or with Claude Code) is supported; the app picks up changes live.
`;

export const CONTACT_TEMPLATE = `# Contact details for the CV header. Uncomment and fill in.
# version: 1
# name: Alex Example
# email: alex@example.com
# phone: "+381 60 000 0000"
# location: Belgrade, Serbia
# links:
#   - label: LinkedIn
#     url: https://www.linkedin.com/in/alex-example
#   - label: GitHub
#     url: https://github.com/alex-example
`;

export const PREFERENCES_TEMPLATE = `# What you are looking for. Uncomment and adjust; everything except location has a default.
# version: 1
# roles:
#   seniority: [senior, staff, manager]
#   exclude_title_keywords: [intern, sales]
# location:
#   based_in: { country: RS, city: Belgrade }
#   remote: hybrid-ok              # remote-only | hybrid-ok | onsite-ok
#   acceptable_locations: ["Remote (EU)", Berlin]
#   timezone: Europe/Belgrade
#   acceptable_utc_offsets: [-1, 3]
#   work_authorization: [RS]
#   needs_sponsorship_elsewhere: true
#   open_to_relocation: false
# compensation:
#   floor: { min: 60000, currency: EUR, period: year }
# company:
#   sizes: [51-200, 201-1000, 1001-5000]
#   exclude_industries: [gambling]
# deal_breakers:
#   - Requires being on site more than two days a week
# scoring:
#   threshold: 70
# cover_letter:
#   policy: when-requested         # always | when-requested | never
# apply:
#   mode: manual                   # manual | assisted
# cv:
#   max_pages: 2
`;

export const ANSWERS_TEMPLATE = `# Reusable answers for application forms. Hirehound suggests these when a form asks.
version: 1
answers: []
# Example:
#   - id: notice-period
#     question: What is your notice period?
#     aliases: [When can you start?]
#     answer: One month
#     tags: [availability]
`;
