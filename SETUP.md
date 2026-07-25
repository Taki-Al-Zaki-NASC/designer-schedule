# UYFSR · Schedule & Submission Dashboard

A poster rotation board for a small design team. It decides **who publishes on
which Friday/Saturday**, holds the **topic** for each slot, takes the poster
**submission**, runs it through **review**, and keeps the whole record backed up.

Everything runs in the browser against a Firebase Realtime Database. There is no
server to deploy.

---

## Files

```
index.html                  markup only — no logic
css/theme.css               design tokens, reset, primitives (buttons, badges, fields)
css/app.css                 layout and components
js/config.js                every tunable value lives here
js/util.js                  dates, strings, hashing, downloads
js/schedule.js              the rotation engine — pure, never writes
js/store.js                 the data layer — validation, retry, cache, reconcile
js/auth.js                  session gate, lockout, idle expiry
js/images.js                downscale + re-encode pipeline for posters
js/backup.js                snapshots, export, import, restore
js/ui.js                    toasts, dialogs, lightbox
js/app.js                   views, rendering, action handlers
database.rules.json         security rules — deploy these
database.rules.auth.json    stricter rules, once Firebase Auth is on
tools/hash-password.html    generate an account hash
tools/verify-schedule.js    node tools/verify-schedule.js
tools/verify-wiring.js      node tools/verify-wiring.js
```

Load order matters and is enforced by `verify-wiring.js`. Plain `<script>` tags,
no bundler, no modules — so it works from a plain static host.

---

## Running it

Serve the folder over HTTP. **Do not open `index.html` with `file://`** —
browsers disable `crypto.subtle` there, and admin sign-in needs it.

```bash
python -m http.server 8080
# or
npx serve .
```

Then open <http://localhost:8080>.

---

## The rotation, in plain terms

* Slots fall on every **Friday and Saturday** from `schedule.startDate` onward.
* Each slot has a sequential number that **keeps counting across months and
  years**. Designer = `roster[(number + rotationOffset) % rosterSize]`.
* Over a year every designer lands within one slot of everyone else, and nobody
  ever gets two in a row. `verify-schedule.js` asserts both.

An assignment is resolved in three tiers, highest first:

| Tier | Where it comes from | Changes when the roster changes? |
|---|---|---|
| **Manual** | an owner used Reassign or Swap | never |
| **Confirmed** | frozen automatically once the slot enters the horizon | never |
| **Projected** | computed live from the rotation | yes — it is a forecast |

The horizon is `commitHorizonDays` (45 by default). This is what makes the board
trustworthy: **the next six weeks are fixed**, so adding or removing someone
today cannot reshuffle a slot that people have already planned around. Anything
further out is labelled *Projected* in the UI so nobody treats it as final.

### Slot lifecycle

```
Locked ──(18 days before)──► Open ──(<48h)──► Due soon ──(20:00 deadline)──► Overdue (grace, 24h) ──► Missed
                               │                                                  │
                               └────────────── poster uploaded ───────────────────┘
                                                     ▼
                                              In review ──► Approved
                                                     └────► Revision requested ──► back to Open
```

Owners can also mark a missed slot **Excused** (stops counting against
reliability) or **Cancel** a slot entirely (holiday, exam week — excluded from
all statistics, and it does not shift anyone else).

All timings are in `config.js`: `revealDays`, `deadlineHour`, `graceHours`.

---

## Security — read this properly

There are two independent things here, and only one of them is real security.

**Browser-side sign-in (`js/auth.js`)** hides the admin controls. Passwords are
stored as salted SHA-256 so they are not readable in view-source, failed attempts
lock out for five minutes, and the session expires after 45 idle minutes. This
stops a curious visitor. It does **not** stop anyone who opens the network tab —
the account list is in the page, and the Firebase URL is in the page.

**Database rules** are the real lock. Nothing else is.

### Step 1 — deploy the rules (do this now)

```bash
npm install -g firebase-tools
firebase login
firebase deploy --only database
```

or paste `database.rules.json` into
*Firebase Console → Realtime Database → Rules → Publish*.

This ruleset works with the app exactly as shipped and gives you:

* every field type- and length-checked, so malformed data cannot land
* posters capped at ~1.4 MB each and required to be `data:image/…`
* unknown fields rejected outright
* whole slots cannot be deleted, only their fields cleared
* log and backup entries cannot be edited after they are written

What it still allows, because there is no authentication yet: anyone with the
database URL can write *valid* data. Someone determined could change a topic.

### Step 2 — turn on real authentication (recommended)

1. *Firebase Console → Authentication → Sign-in method → enable **Anonymous***.
2. Add `firebase-auth-compat.js` to `index.html` and call
   `firebase.auth().signInAnonymously()` before `App.store.init()`.
3. Sign in once as each owner, copy their UID from the Authentication tab, and
   add it under `/admins/<uid>: true` in the database.
4. Deploy `database.rules.auth.json` instead.

After that, only listed UIDs can approve, set topics, reassign, or touch
backups. Everyone else can read and submit a poster, nothing more.

### Change the passwords

The shipped accounts are the old ones so nothing breaks on day one. Change them:

1. Open `tools/hash-password.html` over http (not file://).
2. Type a username and a new password.
3. Paste the generated block into `accounts` in `js/config.js`.

---

## Backups

Topics are the part of this system that cannot be regenerated. Four layers
protect them:

1. **Topic history** — every edit is appended to the slot itself with author and
   timestamp. Open any topic dialog to see the full trail. Nothing is ever
   silently overwritten.
2. **Cloud snapshots** — stored under `/backups` in the database. One is taken
   automatically when an owner signs in and the newest is over 12 hours old; the
   last 20 are kept. Posters are excluded so they stay small.
3. **File export** — Backup tab → *Download JSON backup* (or *+ posters* before
   a risky change), plus a **topic ledger CSV** for spreadsheets.
4. **Offline mirror** — the last known schedule is written to `localStorage` on
   every change, so the board still renders with a "cached copy" banner when
   Firebase is unreachable.

### Restoring

Pick a snapshot or a file. Before anything is written you get a diff: how many
topics differ, how many assignments differ, whether the roster changed, and
sample before/after values. Then choose a mode:

* **Merge** — only fills empty fields. Never overwrites a live topic, poster or
  approval. This is the safe default.
* **Replace** — overwrites the slots present in the backup.

Neither mode deletes slots that are missing from the backup. A restore can never
wipe newer work.

**Keep one JSON export off-platform** — a Firebase project that gets deleted
takes its own snapshots with it.

---

## What changed from v1, and why

| v1 behaviour | Problem | Now |
|---|---|---|
| `generateMonthSchedule()` wrote to the database on every render | Each write re-fired the `on('value')` listener → re-render → write. A permanent loop burning quota. | Rendering never writes. A throttled `reconcileCommitments()` fills only *missing* assignments, in one atomic batch, at most once per 10 minutes. |
| Two different generators for the grid and the search box | They disagreed, so search showed a different designer than the card for the same date. | One engine. Grid, search, roster, sequence editor and backups all call `schedule.build()`. |
| `globalIndex` reset to 0 each month | The same person got the first slot of every single month. | One continuous counter since the anchor date. |
| Drag-to-reorder wrote `assignedDesigner` | The next render overwrote it. The feature did nothing. | Reassign/Swap write an `overrideDesigner` that reconcile never touches. Swaps are one atomic multi-path write. |
| "Optimizing" upload drew the image at full size | A 12 MP photo went into the database nearly untouched. | Real downscale to 1600px, quality stepped down until it fits, hard refusal above 900 KB with a clear message. |
| `isSlotUnlocked` returned true for every past date | Past slots were "unlocked" forever. | Explicit reveal → deadline → grace → missed timeline. |
| Slot became "Cancelled/Missed" at midnight | Missing by one minute looked identical to never submitting. | 20:00 deadline, 24-hour grace with a *late* flag, then Missed. Owners can Excuse. |
| Only Approve or Delete | No way to ask for a fix. | Request changes with a note, Reopen, Excuse, Cancel. |
| Remaining = total − completed | Counted pending work as remaining. | Approved / In review / Needs attention / Upcoming, counted separately. Cancelled excluded. |
| Passwords in plaintext in the HTML | Visible in view-source. | Salted SHA-256, lockout, idle expiry — plus rules that actually protect the data. |
| Inline `onclick="fn('${name}')"` | Broke on names with quotes. | Event delegation on `data-action` attributes. No HTML-interpolated JavaScript anywhere. |
| Clock updated every 60s but showed seconds | Displayed a stale time. | Minute-precision clock plus a repaint every 60s so countdowns and status transitions stay honest. |
| No error handling on writes | A failed save looked identical to a successful one. | Timeout, bounded retry with backoff, and a toast on failure. |

Existing data is untouched: slot IDs (`YYYY-M-D`, zero-based month) and every
node and field name from v1 are preserved, so topics and posters already in the
database carry straight over.

---

## Verifying

```bash
node tools/verify-schedule.js   # 34 checks on the rotation, deadlines, statuses
node tools/verify-wiring.js     # every action wired, every id and CSS class real
```

Run both after touching `schedule.js`, `config.js` or the markup.
