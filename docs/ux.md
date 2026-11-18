# UX

The web UI is the primary interface. It should feel calm, dense and professional, closer to a
good issue tracker than to a marketing site.

## Principles

- **Review in one glance.** The information needed for a decision is on one screen.
- **Evidence is always one hover away.** Every tailored claim shows the bank entries behind it.
- **No dead ends.** Every AI output is editable; every blocked action says why and what unblocks it.
- **Show progress, never a bare spinner.** Long tasks stream progress over SSE.
- **Keyboard first.** Triage a queue without touching the mouse.
- **Calm.** Neutral surfaces, one accent color, state colors as soft tints, no animation for its own sake.

## Keyboard shortcuts

Press `?` anywhere to see the shortcuts that are active on the current screen.

| Where | Keys |
|---|---|
| Everywhere | `/` search jobs, `?` shortcut sheet, `n` add a job, `g t` Today, `g p` Pipeline, `g s` Settings |
| Pipeline | `b` / `t` board or table, `j` / `k` (or arrows) select, `h` / `l` change column, `Enter` open, `x` select for bulk, `m` move to..., `[` / `]` move back or forward, `s` skip |
| Job dossier | `1`-`7` switch tab, `m` move to..., `n` add note, `o` open original posting, `Esc` back to pipeline |
| CV review (M3) | `j` / `k` previous or next job, `a` approve, `r` request changes, `e` edit, `b` switch base, `s` skip |

## Wireframes (low fidelity)

App shell on every screen: left nav, top bar with search (`/`), `+ Add job` (`N`), and a live task indicator (SSE). `?` opens the shortcut sheet. Global keys: `g t` Today, `g p` Pipeline, `g s` Settings.

### Today

```
+----------------+--------------------------------------------------------------------------+
| HIREHOUND      | Today, Mon 16 Nov                         [/ Search jobs]  [+ Add job  N]  |
|                +--------------------------------------------------------------------------+
| > Today     3  | NEEDS YOUR REVIEW (3)                                      Review all  R  |
|   Pipeline     | +----------------------------------------------------------------------+ |
|   Profile      | |  87  Acme           Engineering Manager, Platform   EM    ready  2h  | |
|   Sources      | |  74  Globex         Staff Engineer                  SSE   ready  1d  | |
|   Insights     | |  58! Initech        Engineering Lead  (below 70)    EM    ready  1d  | |
|                | +----------------------------------------------------------------------+ |
|                | FOLLOW-UPS DUE (2)                  | UPCOMING INTERVIEWS (1)             |
|                |  Umbrella   applied 8d ago  [Draft] |  Thu 19 Nov 14:00  Acme  panel      |
|                |  Hooli      applied 12d ago [Draft] |                                     |
|                +-------------------------------------+-------------------------------------+
|                | NEW FROM SCANS: 12 found, 4 above threshold, 3 filtered    Triage  T    |
| -------------- | TO EVALUATE (4)                                                          |
|   Settings     |  Vandelay   Senior SWE, Payments      found 3h ago   [Evaluate]          |
| ws: ~/Docu..   | RUNNING: evaluating Globex... 1.2k tokens  |  tailoring Acme... 3/5 steps  |
+----------------+--------------------------------------------------------------------------+
```

In M1 only "To evaluate", "Recently added" and empty states have data; the rest are placeholders wired to the index later.

### Pipeline: board

```
Pipeline   [Board | Table]   State v  Score v  Base v  Source v  Company [________]   23 jobs
+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+
| Found   4 | Evaluated | Tailoring | Ready   3 | Approved  | Applied 5 | Screening | Interview | Offer     |
+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+
| Vandelay  | Hooli     |           | Acme      |           | Umbrella  | Stark     |           |           |
| Sr SWE    | EM        |           | EM, Plat. |           | Staff Eng |           |           |           |
| -- . 3h   | 71 EM 1d  |           | 87 EM 2h  |           | 80 SSE 8d |           |           |           |
|           |           |           |           |           |           |           |           |           |
+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+-----------+
Closed: rejected 4 . withdrawn 1 . skipped 6 . expired 2                                   [Show closed]
Keys: arrows/J/K select . Enter open . M move to... . [ / ] move back/forward . S skip
```

Card = company, role, score, base, age. Drag-and-drop between columns; columns that the guards forbid are dimmed during the drag with the reason on hover.

### Pipeline: table

```
Pipeline   [Board | Table]   State v  Score v  Base v  Source v  Company [________]   23 jobs
+---+-------+-----------+---------------------------+------------+------+--------+--------------+--------+
|[ ]| Score | Company   | Role                      | State      | Base | Source | Location     | Added v|
+---+-------+-----------+---------------------------+------------+------+--------+--------------+--------+
|[x]|  87   | Acme      | Engineering Manager, Plat.| ready      | EM   | url    | Remote (EU)  | 16 Nov |
|[ ]|  80   | Umbrella  | Staff Engineer            | applied    | SSE  | lever  | Berlin       | 08 Nov |
|[ ]|  --   | Vandelay  | Senior SWE, Payments      | found      | -    | text   | Remote       | 16 Nov |
+---+-------+-----------+---------------------------+------------+------+--------+--------------+--------+
1 selected   [Move to v]  [Skip]  [Tag]                         J/K move . X select . Enter open
```

Sorting by header click; filters and sort persist in the URL so views are linkable/bookmarkable.

### Job dossier

```
< Pipeline    Acme  .  Engineering Manager, Platform                       [Move to v]  [...]
              87 strong . EM base . Remote (EU) . EUR 90-110k . found 16 Nov via URL
              found > evaluated > tailoring > (ready) > approved > applied > screening > ...
+--------------------------------------------------------------------------------------------+
| [Posting]  Evaluation   CV   Cover letter   Application   Interview   Timeline              |
+------------------------------------------------------------+-------------------------------+
| Snapshot fetched 16 Nov 10:42 . live . Open original  Raw  | NOTES                  [+ N]  |
|                                                            |  16 Nov  Referral via Ana     |
| About the role                                             | CONTACTS               [+]    |
| We are looking for an Engineering Manager to lead our      |  Jane Doe . recruiter         |
| platform team of 8 ...                                     | FILES                         |
|                                                            |  posting.md . posting.html    |
| What you'll do                                             |  status.yaml                  |
|  - Lead and grow ...                                       |  Open folder                  |
+------------------------------------------------------------+-------------------------------+
Keys: 1-7 switch tab . M move . N note . O open original
```

Raw `posting.html` is untrusted third-party HTML: it is only ever shown in a sandboxed iframe served with `Content-Security-Policy: sandbox`, never inside the app origin. In M1, tabs other than Posting and Timeline show an empty state that says which milestone fills them.

### CV review (M3, designed now so the data model supports it)

```
Review 1/3   Acme . Engineering Manager, Platform   87 strong   EM base          J/K prev/next job
+-----------------------+------------------------------------------------+-------------------------+
| POSTING               | TAILORED CV    [Diff vs base | Clean]          | PDF  (2 pages)          |
| Requirements          |                                                | +---------------------+ |
|  must  people mgmt  ok| ## Experience                                  | | Predrag M...        | |
|  must  Kubernetes   ~ | ### Engineering Manager . Acme . 2021 - now    | | Engineering Manager | |
|  strong platform   ok |     [ROLE-003] ok                              | | ...                 | |
|  nice  Go         gap |   - Grew the team from 4 to 14 engineers       | |                     | |
|                       |     [ACH-014] ok                               | |                     | |
| Highlights            | ~ - Led migration of 40 services to k8s        | |                     | |
|  "lead a team of 8"   |     [ACH-020] [ACH-021] WEAKENED               | |                     | |
|  "own the platform"   | + - Introduced on-call rotation and SLOs       | +---------------------+ |
|                       |     [ACH-031] ok                               |  page 1 of 2   < >      |
+-----------------------+------------------------------------------------+-------------------------+
Checks: numbers ok . companies ok . titles ok . dates ok    Verifier: 23 supported . 1 weakened . 0 unsupported
[A Approve]  [R Request changes]  [E Edit inline]  [B Switch base]  [S Skip]      ATS text round-trip ok
```

Hovering an evidence chip shows the bank entry; clicking a WEAKENED marker shows the verifier's reason and a suggested rewrite. Approve is disabled while anything blocking remains, and the bar says why.
