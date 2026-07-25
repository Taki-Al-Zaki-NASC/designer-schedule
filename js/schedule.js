/* =============================================================================
 * UYFSR · Schedule engine
 * -----------------------------------------------------------------------------
 * One source of truth for "who is on which slot, and what state is it in".
 *
 * Rotation model
 * --------------
 *   Every publishing day (Fri + Sat by default) since the anchor date gets a
 *   sequential index. Designer = roster[(index + rotationOffset) % rosterSize].
 *   The index is continuous across month and year boundaries, so nobody is
 *   permanently stuck with "first slot of every month".
 *
 * Three-tier resolution (highest wins)
 * ------------------------------------
 *   1. override   – an owner manually moved this slot. Never recomputed.
 *   2. committed  – frozen once the slot enters the commit horizon, so the
 *                   near-term roster does not shuffle when someone is added
 *                   or removed. This is what makes the schedule trustworthy.
 *   3. projected  – computed live from the rotation. Beyond the horizon it is
 *                   a forecast and is labelled as such in the UI.
 *
 * The engine is PURE: it never writes to the database. Committing is a
 * separate, throttled, idempotent pass in store.js.
 * ========================================================================== */
(function (global) {
    'use strict';

    var App = global.App = global.App || {};
    var U = App.util;
    var CFG = global.APP_CONFIG.schedule;

    var PUBLISH_DAYS = CFG.publishDays.slice().sort(function (a, b) { return a - b; });
    var START = U.parseISODate(CFG.startDate);

    /* First real slot on or after the configured start date. */
    var ANCHOR = (function () {
        var d = U.startOfDay(START);
        for (var i = 0; i < 21; i++) {
            if (PUBLISH_DAYS.indexOf(d.getDay()) !== -1) return d;
            d = U.addDays(d, 1);
        }
        return d;
    })();

    function weekStart(d) {
        var x = U.startOfDay(d);
        return U.addDays(x, -x.getDay());   /* back to Sunday */
    }

    var ANCHOR_WEEK = weekStart(ANCHOR);

    /* Sequential position of a publishing day in the infinite rotation. */
    function rawIndex(date) {
        var weeks = Math.round((weekStart(date) - ANCHOR_WEEK) / (7 * U.DAY_MS));
        var pos = PUBLISH_DAYS.indexOf(date.getDay());
        if (pos === -1) return null;
        return weeks * PUBLISH_DAYS.length + pos;
    }

    var BASE_INDEX = rawIndex(ANCHOR);

    var Schedule = {

        anchorDate: ANCHOR,
        startDate: START,

        isPublishDay: function (date) {
            return PUBLISH_DAYS.indexOf(date.getDay()) !== -1;
        },

        /* Legacy-compatible id: "YYYY-M-D" with a ZERO-BASED month.
         * Do not "fix" this — every topic and poster already stored in the
         * database is keyed by it. */
        slotIdFor: function (date) {
            return date.getFullYear() + '-' + date.getMonth() + '-' + date.getDate();
        },

        /* Ordinal of a slot in the rotation, 0 for the very first one. */
        sequenceOf: function (date) {
            var raw = rawIndex(date);
            return raw === null ? null : raw - BASE_INDEX;
        },

        /* Who the pure rotation would pick, ignoring overrides and commits. */
        projectedDesigner: function (date, roster, rotationOffset) {
            if (!roster || !roster.length) return null;
            var seq = Schedule.sequenceOf(date);
            if (seq === null || seq < 0) return null;
            return roster[U.mod(seq + (rotationOffset || 0), roster.length)];
        },

        /* ---- deadlines --------------------------------------------------- */

        revealAt: function (date) {
            return U.addDays(U.startOfDay(date), -CFG.revealDays);
        },

        deadlineAt: function (date) {
            var d = U.startOfDay(date);
            d.setHours(CFG.deadlineHour, 0, 0, 0);
            return d;
        },

        graceEndsAt: function (date) {
            return new Date(Schedule.deadlineAt(date).getTime() + CFG.graceHours * U.HOUR_MS);
        },

        /* ---- slot construction ------------------------------------------ */

        /* Every publishing day inside a calendar month, on/after the start. */
        datesInMonth: function (year, monthIndex) {
            var out = [];
            var d = new Date(year, monthIndex, 1);
            var end = new Date(year, monthIndex + 1, 0);
            var floor = U.startOfDay(START);
            while (d <= end) {
                if (Schedule.isPublishDay(d) && U.startOfDay(d) >= floor) out.push(new Date(d));
                d.setDate(d.getDate() + 1);
            }
            return out;
        },

        datesBetween: function (from, to) {
            var out = [];
            var d = U.startOfDay(from);
            var end = U.startOfDay(to);
            var floor = U.startOfDay(START);
            if (d < floor) d = new Date(floor);
            var guard = 0;
            while (d <= end && guard++ < 4000) {
                if (Schedule.isPublishDay(d)) out.push(new Date(d));
                d = U.addDays(d, 1);
            }
            return out;
        },

        /* Resolve one date into a fully described slot. */
        build: function (date, ctx) {
            var roster = ctx.roster || [];
            var states = ctx.states || {};
            var offset = ctx.rotationOffset || 0;
            var now = ctx.now || new Date();

            var id = Schedule.slotIdFor(date);
            var state = states[id] || {};
            var projected = Schedule.projectedDesigner(date, roster, offset);

            var isPast = U.startOfDay(date) < U.startOfDay(now);
            var source, designer;

            if (state.overrideDesigner) {
                designer = state.overrideDesigner;
                source = 'override';
            } else if (state.committedDesigner) {
                designer = state.committedDesigner;
                source = 'committed';
            } else if (isPast && state.assignedDesigner) {
                /* v1 wrote assignedDesigner on every render. Trust it only for
                 * days that already happened — that is history, not a forecast. */
                designer = state.assignedDesigner;
                source = 'committed';
            } else {
                designer = projected;
                source = 'projected';
            }

            var slot = {
                id: id,
                date: date,
                dayName: U.dayName(date),
                dayShort: U.dayName(date, 'short'),
                sequence: Schedule.sequenceOf(date),
                designer: designer,
                projectedDesigner: projected,
                assignmentSource: source,
                isProjected: source === 'projected',
                orphanDesigner: !!(designer && roster.length && roster.indexOf(designer) === -1),
                state: state,
                revealAt: Schedule.revealAt(date),
                deadlineAt: Schedule.deadlineAt(date),
                graceEndsAt: Schedule.graceEndsAt(date),
                posters: Schedule.postersOf(state),
                topic: state.topic || ''
            };

            slot.status = Schedule.deriveStatus(slot, now, ctx.isOwner);
            return slot;
        },

        buildMonth: function (year, monthIndex, ctx) {
            return Schedule.datesInMonth(year, monthIndex).map(function (d) {
                return Schedule.build(d, ctx);
            });
        },

        buildRange: function (from, to, ctx) {
            return Schedule.datesBetween(from, to).map(function (d) {
                return Schedule.build(d, ctx);
            });
        },

        /* ---- posters ----------------------------------------------------- */

        postersOf: function (state) {
            state = state || {};
            var list = Array.isArray(state.posterUrls) ? state.posterUrls.filter(Boolean) : [];
            if (list.length) return list;
            return state.posterUrl ? [state.posterUrl] : [];
        },

        /* ---- status ------------------------------------------------------ */

        /*
         * Order matters. Read it top to bottom as the real-life sequence of
         * events for one slot.
         */
        deriveStatus: function (slot, now, isOwner) {
            var s = slot.state || {};
            var posters = slot.posters.length > 0;

            if (s.cancelled) {
                return status('cancelled', 'Cancelled', 'neutral', s.cancelledReason || 'Slot cancelled by an owner.');
            }

            var revealed = now >= slot.revealAt;
            if (!revealed && !s.submitted && !s.approved) {
                return status('locked', 'Locked', 'neutral',
                    'Opens ' + U.formatDate(slot.revealAt) + ' (' + CFG.revealDays + ' days before the slot).');
            }

            if (s.approved) {
                return status('approved', 'Approved', 'success',
                    s.late ? 'Approved — submitted after the deadline.' : 'Approved and published.');
            }

            if (s.submitted && posters) {
                return status('submitted', s.late ? 'In review · late' : 'In review', 'warn',
                    'Waiting for an owner to review ' + slot.posters.length +
                    (slot.posters.length === 1 ? ' poster.' : ' posters.'));
            }

            /* Submitted flag with no file left = the poster was cleared. */
            if (s.submitted && !posters) {
                return status('open', 'Awaiting re-upload', 'info', 'The poster was removed. A new file is needed.');
            }

            if (s.needsRevision) {
                return status('revision', 'Revision requested', 'danger',
                    s.revisionNote || 'An owner asked for changes.');
            }

            if (s.excused) {
                return status('excused', 'Excused', 'neutral', s.excusedReason || 'Excused by an owner.');
            }

            if (now < slot.deadlineAt) {
                var msLeft = slot.deadlineAt - now;
                if (msLeft <= 48 * U.HOUR_MS) {
                    return status('due', 'Due soon', 'warn', 'Deadline ' + U.formatDelta(msLeft) + ' away.');
                }
                return status('open', 'Open', 'info', 'Deadline ' + U.formatDateTime(slot.deadlineAt) + '.');
            }

            if (now < slot.graceEndsAt) {
                return status('overdue', 'Overdue · grace', 'danger',
                    'Past the deadline. Late uploads accepted for another ' +
                    U.formatDelta(slot.graceEndsAt - now) + '.');
            }

            return status('missed', 'Missed', 'danger',
                'No poster was submitted before ' + U.formatDateTime(slot.graceEndsAt) + '.');

            function status(key, label, tone, hint) {
                return { key: key, label: label, tone: tone, hint: hint, revealed: revealed || !!isOwner };
            }
        },

        /* Can a poster still be dropped on this slot right now? */
        canSubmit: function (slot, now, isOwner) {
            var s = slot.state || {};
            if (isOwner) return !s.cancelled;                 /* owners can backfill */
            if (s.cancelled || s.approved) return false;
            if (now < slot.revealAt) return false;
            return now <= slot.graceEndsAt;
        },

        isLate: function (slot, now) {
            return now > slot.deadlineAt;
        },

        /* Slot day is "live" — today is the publishing day. */
        isLive: function (slot, now) {
            return U.sameDay(slot.date, now);
        },

        /* ---- roster analytics -------------------------------------------- */

        /*
         * Per-designer scoreboard over a date range. Only counts slots that
         * have actually resolved — a locked future slot is not a "miss".
         */
        rosterStats: function (roster, ctx, from, to) {
            var slots = Schedule.buildRange(from, to, ctx);
            var now = ctx.now || new Date();
            var map = {};

            roster.forEach(function (name) {
                map[name] = {
                    name: name, assigned: 0, approved: 0, submitted: 0, late: 0,
                    missed: 0, excused: 0, cancelled: 0, upcoming: 0,
                    nextSlot: null, lastSlot: null
                };
            });

            slots.forEach(function (slot) {
                if (!slot.designer) return;
                var r = map[slot.designer];
                if (!r) {
                    r = map[slot.designer] = {
                        name: slot.designer, assigned: 0, approved: 0, submitted: 0, late: 0,
                        missed: 0, excused: 0, cancelled: 0, upcoming: 0,
                        nextSlot: null, lastSlot: null, offRoster: true
                    };
                }
                r.assigned++;
                var k = slot.status.key;
                if (k === 'approved') r.approved++;
                else if (k === 'submitted') r.submitted++;
                else if (k === 'missed') r.missed++;
                else if (k === 'excused') r.excused++;
                else if (k === 'cancelled') r.cancelled++;
                else r.upcoming++;

                if (slot.state && slot.state.late) r.late++;
                if (slot.date >= now && (!r.nextSlot || slot.date < r.nextSlot.date)) r.nextSlot = slot;
                if (slot.date < now && (!r.lastSlot || slot.date > r.lastSlot.date)) r.lastSlot = slot;
            });

            return Object.keys(map).map(function (k) {
                var r = map[k];
                var resolved = r.approved + r.missed + r.excused + r.submitted;
                r.resolved = resolved;
                r.reliability = resolved ? Math.round((r.approved + r.submitted) / resolved * 100) : null;
                return r;
            }).sort(function (a, b) {
                return roster.indexOf(a.name) - roster.indexOf(b.name);
            });
        }
    };

    App.schedule = Schedule;

})(window);
