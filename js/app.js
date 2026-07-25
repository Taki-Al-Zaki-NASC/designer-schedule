/* =============================================================================
 * UYFSR · Application shell — views, rendering, interaction
 * ========================================================================== */
(function (global) {
    'use strict';

    var App = global.App = global.App || {};
    var U = App.util;
    var CFG = global.APP_CONFIG;
    var S = App.schedule;

    var view = {
        tab: 'schedule',
        monthOffset: 0,
        query: '',
        filter: 'all',
        rosterDragIndex: null
    };

    var els = {};
    var renderQueued = false;

    /* ---- shared context ------------------------------------------------- */

    App.appContext = function () {
        return {
            roster: App.store.state.designers,
            states: App.store.state.slots,
            rotationOffset: App.store.state.settings.rotationOffset || 0,
            now: new Date(),
            isOwner: App.auth.isOwner()
        };
    };

    function anchorMonth() {
        var base = new Date();
        return new Date(base.getFullYear(), base.getMonth() + view.monthOffset, 1);
    }

    function minMonthOffset() {
        var start = U.parseISODate(CFG.schedule.startDate);
        var now = new Date();
        return (start.getFullYear() - now.getFullYear()) * 12 + (start.getMonth() - now.getMonth());
    }

    /* =====================================================================
     * Rendering
     * ================================================================== */

    function render() {
        if (renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(function () {
            renderQueued = false;
            try { paint(); } catch (e) { console.error('[render]', e); }
        });
    }

    function paint() {
        renderChrome();
        renderTabs();
        if (view.tab === 'schedule') renderSchedule();
        if (view.tab === 'roster') renderRoster();
        if (view.tab === 'controls') renderControls();
        if (view.tab === 'activity') renderActivity();
        if (view.tab === 'backup') renderBackup();
        U.icons();
    }

    /* ---- chrome ---------------------------------------------------------- */

    function renderChrome() {
        var user = App.auth.user;
        var btn = els.authBtn;
        if (user) {
            btn.className = 'btn btn--brand btn--sm';
            btn.innerHTML = '<span class="avatar avatar--xs" style="--h:' + U.hueFor(user.username) + '">' +
                U.escapeHtml(U.initials(user.display)) + '</span>' +
                U.escapeHtml(user.display) + '<i data-lucide="chevron-down"></i>';
            btn.setAttribute('aria-label', 'Signed in as ' + user.display);
        } else {
            btn.className = 'btn btn--ghost btn--sm';
            btn.innerHTML = '<i data-lucide="lock"></i> Admin sign in';
        }

        var conn = els.conn;
        var st = App.store.state;
        if (!st.connected && st.fromCache) {
            conn.className = 'conn conn--warn';
            conn.innerHTML = '<span class="conn__dot"></span> Offline · cached ' +
                (st.cachedAt ? U.formatDateTime(st.cachedAt) : 'copy');
        } else if (!st.connected) {
            conn.className = 'conn conn--warn';
            conn.innerHTML = '<span class="conn__dot"></span> Reconnecting…';
        } else {
            conn.className = 'conn conn--ok';
            conn.innerHTML = '<span class="conn__dot"></span> Live';
        }
    }

    function renderTabs() {
        var owner = App.auth.isOwner();
        /* Drop out of an owner-only tab first, so the highlight below is never
         * painted on a tab that is about to be hidden. */
        if (!owner && ['controls', 'activity', 'backup'].indexOf(view.tab) !== -1) view.tab = 'schedule';

        els.tabs.querySelectorAll('[data-tab]').forEach(function (b) {
            var t = b.dataset.tab;
            var ownerOnly = b.dataset.owner === 'true';
            b.hidden = ownerOnly && !owner;
            b.classList.toggle('is-active', t === view.tab);
            b.setAttribute('aria-selected', t === view.tab ? 'true' : 'false');
        });
        ['schedule', 'roster', 'controls', 'activity', 'backup'].forEach(function (t) {
            var panel = document.getElementById('view-' + t);
            if (panel) panel.hidden = t !== view.tab;
        });
    }

    /* ---- schedule -------------------------------------------------------- */

    function renderSchedule() {
        var ctx = App.appContext();

        if (!App.store.isLoaded()) return renderSkeletons();

        if (!ctx.roster.length) {
            els.statsRow.innerHTML = '';
            els.grid.innerHTML = emptyState('users-round', 'No designers in the rotation',
                'An owner needs to add designers before any slot can be scheduled.');
            els.monthLabel.textContent = U.formatMonth(anchorMonth());
            return;
        }

        var query = view.query.trim().toLowerCase();

        if (query) {
            els.monthBar.classList.add('is-searching');
            var from = U.addDays(ctx.now, -120);
            var to = U.addDays(ctx.now, 300);
            var hits = S.buildRange(from, to, ctx).filter(function (s) {
                var inName = (s.designer || '').toLowerCase().indexOf(query) !== -1;
                var inTopic = (s.topic || '').toLowerCase().indexOf(query) !== -1;
                var revealed = s.status.key !== 'locked' || ctx.isOwner;
                return revealed && (inName || inTopic);
            });
            hits.sort(function (a, b) {
                var an = a.date >= U.startOfDay(ctx.now), bn = b.date >= U.startOfDay(ctx.now);
                if (an !== bn) return an ? -1 : 1;        /* upcoming first */
                return an ? a.date - b.date : b.date - a.date;
            });
            renderStats(hits, 'Search results');
            els.grid.innerHTML = hits.length
                ? hits.slice(0, 40).map(function (s) { return cardHtml(s, ctx); }).join('')
                : emptyState('search-x', 'Nothing matched "' + U.escapeHtml(view.query) + '"',
                    'Search looks at designer names and assigned topics across the last 4 and next 10 months.');
            els.monthLabel.textContent = hits.length + ' result' + (hits.length === 1 ? '' : 's');
            return;
        }

        els.monthBar.classList.remove('is-searching');
        var m = anchorMonth();
        els.monthLabel.textContent = U.formatMonth(m);
        els.prevMonth.disabled = view.monthOffset <= minMonthOffset();

        var slots = S.buildMonth(m.getFullYear(), m.getMonth(), ctx);
        renderStats(slots, U.formatMonth(m));

        var shown = slots.filter(function (s) { return matchesFilter(s, view.filter); });

        if (!slots.length) {
            els.grid.innerHTML = emptyState('calendar-off', 'No slots in ' + U.formatMonth(m),
                'The rotation starts ' + U.formatDate(U.parseISODate(CFG.schedule.startDate)) +
                '. Slots fall on ' + CFG.schedule.publishDays.map(function (d) {
                    return U.dayName(new Date(2024, 0, 7 + d));
                }).join(' and ') + '.');
            return;
        }

        if (!shown.length) {
            els.grid.innerHTML = emptyState('filter-x', 'No slots match this filter',
                U.formatMonth(m) + ' has ' + slots.length + ' slot(s), none in the "' + view.filter + '" state.');
            return;
        }

        els.grid.innerHTML = shown.map(function (s) { return cardHtml(s, ctx); }).join('');
    }

    function matchesFilter(slot, filter) {
        var k = slot.status.key;
        if (filter === 'all') return true;
        if (filter === 'open') return ['open', 'due', 'overdue', 'revision'].indexOf(k) !== -1;
        if (filter === 'review') return k === 'submitted';
        if (filter === 'approved') return k === 'approved';
        if (filter === 'attention') return ['missed', 'overdue', 'revision'].indexOf(k) !== -1;
        if (filter === 'locked') return k === 'locked';
        return true;
    }

    function renderStats(slots, scopeLabel) {
        var total = slots.length;
        var by = { approved: 0, submitted: 0, missed: 0, overdue: 0, revision: 0, locked: 0, open: 0, due: 0, excused: 0, cancelled: 0 };
        slots.forEach(function (s) { by[s.status.key] = (by[s.status.key] || 0) + 1; });

        var live = total - by.cancelled;
        var attention = by.missed + by.overdue + by.revision;
        var upcoming = by.open + by.due + by.locked;
        var pct = live ? Math.round(by.approved / live * 100) : 0;

        els.statsRow.innerHTML = [
            statTile('Slots', total, scopeLabel, 'calendar-days', 'neutral',
                by.cancelled ? by.cancelled + ' cancelled' : (live + ' active')),
            statTile('Approved', by.approved, pct + '% of active slots', 'circle-check-big', 'success', null, pct),
            statTile('In review', by.submitted, by.submitted ? 'Waiting on an owner' : 'Nothing queued', 'clock-4', 'warn'),
            statTile('Needs attention', attention,
                attention ? by.missed + ' missed · ' + by.overdue + ' overdue · ' + by.revision + ' revision' : 'All clear',
                'triangle-alert', attention ? 'danger' : 'neutral'),
            statTile('Upcoming', upcoming, by.locked + ' still locked', 'hourglass', 'brand')
        ].join('');
    }

    function statTile(label, value, sub, icon, tone, extra, pct) {
        return '<div class="stat stat--' + tone + '">' +
            '<div class="stat__icon"><i data-lucide="' + icon + '"></i></div>' +
            '<div class="stat__body">' +
            '<span class="stat__label">' + U.escapeHtml(label) + '</span>' +
            '<span class="stat__value">' + value + '</span>' +
            '<span class="stat__sub">' + U.escapeHtml(extra || sub || '') + '</span>' +
            (pct !== undefined ? '<span class="stat__bar"><i style="width:' + pct + '%"></i></span>' : '') +
            '</div></div>';
    }

    function renderSkeletons() {
        els.statsRow.innerHTML = repeat(5, '<div class="stat skeleton" style="height:76px"></div>');
        els.grid.innerHTML = repeat(6, '<div class="card skeleton" style="height:230px"></div>');

        function repeat(n, html) {
            var out = '';
            for (var i = 0; i < n; i++) out += html;
            return out;
        }
    }

    /* ---- slot card ------------------------------------------------------- */

    function cardHtml(slot, ctx) {
        var st = slot.status;
        var owner = ctx.isOwner;
        var revealed = st.key !== 'locked' || owner;
        var isLive = S.isLive(slot, ctx.now);
        var s = slot.state || {};

        var classes = ['card', 'card--' + st.tone];
        if (!revealed) classes.push('is-locked');
        if (isLive) classes.push('is-live');
        if (st.key === 'cancelled' || st.key === 'missed' || st.key === 'excused') classes.push('is-muted');

        /* -- who -- */
        var whoHtml;
        if (revealed && slot.designer) {
            whoHtml =
                '<span class="avatar" style="--h:' + U.hueFor(slot.designer) + '">' + U.escapeHtml(U.initials(slot.designer)) + '</span>' +
                '<div class="who__text">' +
                '<strong>' + U.escapeHtml(slot.designer) + '</strong>' +
                '<small>' + assignmentNote(slot) + '</small>' +
                '</div>';
        } else if (!slot.designer) {
            whoHtml = '<span class="avatar avatar--empty"><i data-lucide="user-x"></i></span>' +
                '<div class="who__text"><strong>Unassigned</strong><small>No designer resolves to this slot.</small></div>';
        } else {
            whoHtml = '<span class="avatar avatar--empty"><i data-lucide="lock"></i></span>' +
                '<div class="who__text"><strong class="is-dim">Assignment hidden</strong>' +
                '<small>Reveals ' + U.escapeHtml(U.formatDate(slot.revealAt)) + '</small></div>';
        }

        /* -- topic -- */
        var canEditTopic = owner && st.key !== 'cancelled';
        var topicHtml;
        if (slot.topic) {
            topicHtml = '<div class="topic' + (canEditTopic ? ' topic--editable' : '') + '"' +
                (canEditTopic ? ' data-action="edit-topic" data-id="' + slot.id + '" role="button" tabindex="0"' : '') + '>' +
                '<i data-lucide="tag"></i><span>' + U.escapeHtml(slot.topic) + '</span>' +
                (canEditTopic ? '<i class="topic__pen" data-lucide="pencil"></i>' : '') +
                '</div>';
        } else if (!revealed) {
            topicHtml = '<div class="topic topic--empty"><i data-lucide="tag"></i><span>Topic hidden until the slot opens</span></div>';
        } else if (canEditTopic) {
            topicHtml = '<div class="topic topic--empty topic--editable" data-action="edit-topic" data-id="' + slot.id + '" role="button" tabindex="0">' +
                '<i data-lucide="plus"></i><span>Assign a topic</span></div>';
        } else {
            topicHtml = '<div class="topic topic--empty"><i data-lucide="tag"></i><span>No topic assigned yet</span></div>';
        }

        /* -- timing -- */
        var timingHtml = '';
        if (revealed && ['locked', 'cancelled'].indexOf(st.key) === -1) {
            var msLeft = slot.deadlineAt - ctx.now;
            var label, tone;
            if (st.key === 'approved') { label = 'Approved ' + U.formatDateTime(s.approvedAt); tone = 'ok'; }
            else if (st.key === 'submitted') { label = 'Submitted ' + U.formatDateTime(s.submittedAt); tone = 'warn'; }
            else if (msLeft > 0) { label = 'Due ' + U.formatTime(slot.deadlineAt) + ' · ' + U.formatDelta(msLeft) + ' left'; tone = msLeft < 48 * U.HOUR_MS ? 'warn' : 'ok'; }
            else if (ctx.now < slot.graceEndsAt) { label = 'Grace ends in ' + U.formatDelta(slot.graceEndsAt - ctx.now); tone = 'bad'; }
            else { label = 'Deadline passed ' + U.formatDelta(msLeft); tone = 'bad'; }
            timingHtml = '<div class="timing timing--' + tone + '"><i data-lucide="timer"></i>' + U.escapeHtml(label) + '</div>';
        }

        /* -- posters --
         * Submitted files are for owner review only — a normal designer never
         * sees the image, just the status text ("Waiting for an owner to
         * review…"). Once it's visible, it's a bare square with no label
         * reads as decoration, not as "click to view" — so the caption and an
         * always-visible expand icon (not hover-only, which touch has none of)
         * make it obvious for the owner who does see it. */
        var postersHtml = '';
        if (slot.posters.length && owner) {
            var posterWord = slot.posters.length === 1 ? 'poster' : 'posters';
            postersHtml =
                '<div class="thumbsLabel"><i data-lucide="images"></i>' +
                slot.posters.length + ' ' + posterWord + ' submitted · tap to view</div>' +
                '<div class="thumbs">' + slot.posters.map(function (url, i) {
                    return '<button class="thumb" data-action="view-poster" data-id="' + slot.id + '" data-index="' + i + '" ' +
                        'aria-label="Open poster ' + (i + 1) + ' of ' + slot.posters.length + '">' +
                        '<img src="' + url + '" alt="" loading="lazy" />' +
                        '<span class="thumb__view"><i data-lucide="expand"></i></span>' +
                        (owner ? '<span class="thumb__x" data-action="drop-poster" data-id="' + slot.id + '" data-index="' + i + '" role="button" aria-label="Remove poster ' + (i + 1) + '"><i data-lucide="x"></i></span>' : '') +
                        '</button>';
                }).join('') + '</div>';
        }

        /* -- note -- */
        var noteHtml = '';
        if (st.key === 'revision' && s.revisionNote) noteHtml = note('message-square-warning', 'Revision note: ' + s.revisionNote);
        else if (st.key === 'excused' && s.excusedReason) noteHtml = note('heart-handshake', s.excusedReason);
        else if (st.key === 'cancelled' && s.cancelledReason) noteHtml = note('calendar-x', s.cancelledReason);
        else if (st.hint) noteHtml = note('info', st.hint);

        /* -- actions -- */
        var acts = [];
        var canSubmit = S.canSubmit(slot, ctx.now, owner);

        if (canSubmit && ['approved'].indexOf(st.key) === -1) {
            var late = S.isLate(slot, ctx.now);
            acts.push(btn(slot.posters.length ? 'Add poster' : 'Upload poster',
                'upload', slot.id, late ? 'warn' : 'brand', null, 'upload'));
        }
        if (owner) {
            if (s.submitted && slot.posters.length && !s.approved) {
                acts.push(btn('Approve', 'approve', slot.id, 'success', null, 'check'));
                acts.push(btn('Request changes', 'revision', slot.id, 'ghost', null, 'undo-2'));
            }
            if (slot.posters.length) acts.push(btn('Download', 'download-all', slot.id, 'ghost', null, 'download'));
            if (s.approved) acts.push(btn('Reopen', 'reopen', slot.id, 'ghost', null, 'rotate-ccw'));
            if (st.key === 'missed') acts.push(btn('Excuse', 'excuse', slot.id, 'ghost', null, 'heart-handshake'));
            acts.push(btn('', 'more', slot.id, 'ghost icon-only', 'More actions', 'ellipsis'));
        }

        var seqNote = slot.sequence !== null ? 'Slot #' + (slot.sequence + 1) : '';

        return '<article class="' + classes.join(' ') + '" data-slot="' + slot.id + '">' +
            (isLive ? '<span class="card__live"><span class="pulse"></span>Publishing today</span>' : '') +
            '<header class="card__head">' +
            '<div class="card__date">' +
            '<span class="daychip">' + U.escapeHtml(slot.dayShort.toUpperCase()) + '</span>' +
            '<div><strong>' + U.escapeHtml(U.formatDate(slot.date, { month: 'short', day: 'numeric' })) + '</strong>' +
            '<small>' + slot.date.getFullYear() + (seqNote ? ' · ' + seqNote : '') + '</small></div>' +
            '</div>' +
            '<span class="badge badge--' + st.tone + '">' + U.escapeHtml(st.label) + '</span>' +
            '</header>' +
            '<div class="who">' + whoHtml + '</div>' +
            topicHtml +
            timingHtml +
            postersHtml +
            noteHtml +
            (acts.length ? '<footer class="card__actions">' + acts.join('') + '</footer>' : '') +
            '</article>';

        function note(icon, text) {
            return '<p class="note"><i data-lucide="' + icon + '"></i><span>' + U.escapeHtml(text) + '</span></p>';
        }
    }

    function assignmentNote(slot) {
        if (slot.orphanDesigner) return '<span class="tag tag--warn">Left the roster</span>';
        if (slot.assignmentSource === 'override') return '<span class="tag tag--info">Manually assigned</span>';
        if (slot.assignmentSource === 'projected') return '<span class="tag">Projected · not final yet</span>';
        return 'Confirmed assignment';
    }

    function btn(label, action, id, tone, title, icon) {
        var cls = 'btn btn--sm btn--' + (tone || 'ghost');
        return '<button class="' + cls + '" data-action="' + action + '" data-id="' + id + '"' +
            (title ? ' title="' + U.escapeHtml(title) + '" aria-label="' + U.escapeHtml(title) + '"' : '') + '>' +
            (icon ? '<i data-lucide="' + icon + '"></i>' : '') +
            (label ? U.escapeHtml(label) : '') + '</button>';
    }

    function emptyState(icon, title, body) {
        return '<div class="empty"><i data-lucide="' + icon + '"></i>' +
            '<strong>' + U.escapeHtml(title) + '</strong>' +
            '<p>' + U.escapeHtml(body) + '</p></div>';
    }

    /* ---- roster ---------------------------------------------------------- */

    function renderRoster() {
        var ctx = App.appContext();
        var host = document.getElementById('rosterBody');
        if (!ctx.roster.length) {
            host.innerHTML = emptyState('users-round', 'No designers yet',
                'An owner can add people from the Controls tab.');
            return;
        }

        var from = U.addDays(ctx.now, -180);
        var to = U.addDays(ctx.now, 120);
        var stats = S.rosterStats(ctx.roster, ctx, from, to);
        var owner = ctx.isOwner;

        host.innerHTML =
            '<p class="hint"><i data-lucide="info"></i> Reliability counts only slots that have already resolved — ' +
            'upcoming and locked slots are never scored. Window: ' + U.formatDate(from) + ' → ' + U.formatDate(to) + '.</p>' +
            '<div class="roster">' + stats.map(function (r, i) {
                var next = r.nextSlot;
                var rel = r.reliability;
                var relTone = rel === null ? 'neutral' : rel >= 90 ? 'success' : rel >= 70 ? 'warn' : 'danger';
                return '<div class="rosterRow' + (r.offRoster ? ' is-off' : '') + '"' +
                    (owner && !r.offRoster ? ' draggable="true" data-rindex="' + i + '"' : '') + '>' +
                    (owner && !r.offRoster ? '<span class="grip" aria-hidden="true"><i data-lucide="grip-vertical"></i></span>' : '<span class="grip"></span>') +
                    '<span class="avatar" style="--h:' + U.hueFor(r.name) + '">' + U.escapeHtml(U.initials(r.name)) + '</span>' +
                    '<div class="rosterRow__main">' +
                    '<strong>' + U.escapeHtml(r.name) + (r.offRoster ? ' <span class="tag tag--warn">Removed</span>' : '') + '</strong>' +
                    '<small>' + (next
                        ? 'Next: ' + U.formatDate(next.date) + ' · ' + (U.relativeDay(next.date, ctx.now) || U.formatDelta(next.date - ctx.now))
                        : 'No upcoming slot in this window') + '</small>' +
                    '</div>' +
                    '<div class="rosterRow__stats">' +
                    pill('check', r.approved, 'Approved', 'success') +
                    pill('clock-4', r.submitted, 'In review', 'warn') +
                    pill('x', r.missed, 'Missed', 'danger') +
                    pill('heart-handshake', r.excused, 'Excused', 'neutral') +
                    pill('calendar-clock', r.upcoming, 'Upcoming', 'brand') +
                    '</div>' +
                    '<span class="rel rel--' + relTone + '" title="On-time reliability">' +
                    (rel === null ? '—' : rel + '%') + '</span>' +
                    (owner && !r.offRoster
                        ? '<button class="btn btn--ghost btn--sm icon-only" data-action="remove-designer" data-name="' +
                        U.escapeHtml(r.name) + '" title="Remove ' + U.escapeHtml(r.name) + '"><i data-lucide="trash-2"></i></button>'
                        : '') +
                    '</div>';
            }).join('') + '</div>';

        function pill(icon, n, title, tone) {
            return '<span class="pill pill--' + (n ? tone : 'zero') + '" title="' + title + '">' +
                '<i data-lucide="' + icon + '"></i>' + n + '</span>';
        }
    }

    /* ---- controls (owner) ------------------------------------------------ */

    function renderControls() {
        var ctx = App.appContext();
        var host = document.getElementById('controlsBody');
        var settings = App.store.state.settings;

        var horizonSlots = S.buildRange(ctx.now, U.addDays(ctx.now, CFG.schedule.commitHorizonDays + 60), ctx);

        host.innerHTML =
            section('user-plus', 'Roster',
                '<div class="row">' +
                '<input class="field__input" id="newDesigner" placeholder="Full name…" maxlength="' + CFG.limits.designerNameMax + '" />' +
                '<button class="btn btn--brand" data-action="add-designer"><i data-lucide="plus"></i> Add designer</button>' +
                '</div>' +
                '<p class="hint"><i data-lucide="info"></i> Adding or removing someone only reshuffles slots beyond the ' +
                CFG.schedule.commitHorizonDays + '-day confirmation horizon. Anything already confirmed stays put.</p>' +
                (!ctx.roster.length && (CFG.defaultRoster || []).length
                    ? '<button class="btn btn--ghost" data-action="seed-roster"><i data-lucide="sparkles"></i> ' +
                    'Seed the default roster (' + CFG.defaultRoster.length + ' designers)</button>'
                    : '') +
                '<div class="chips">' + (ctx.roster.length
                    ? ctx.roster.map(function (n) {
                        return '<span class="chip"><span class="avatar avatar--xs" style="--h:' + U.hueFor(n) + '">' +
                            U.escapeHtml(U.initials(n)) + '</span>' + U.escapeHtml(n) +
                            '<button data-action="remove-designer" data-name="' + U.escapeHtml(n) +
                            '" aria-label="Remove ' + U.escapeHtml(n) + '"><i data-lucide="x"></i></button></span>';
                    }).join('')
                    : '<span class="hint">Empty rotation.</span>') + '</div>'
            ) +

            section('rotate-cw', 'Rotation',
                '<div class="row row--wrap">' +
                '<div class="stat stat--brand" style="flex:1;min-width:220px">' +
                '<div class="stat__icon"><i data-lucide="list-ordered"></i></div>' +
                '<div class="stat__body"><span class="stat__label">Rotation offset</span>' +
                '<span class="stat__value">' + (settings.rotationOffset || 0) + '</span>' +
                '<span class="stat__sub">Shifts every uncommitted future slot</span></div></div>' +
                '<button class="btn btn--ghost" data-action="rotation-shift" data-delta="-1"><i data-lucide="minus"></i> Shift back</button>' +
                '<button class="btn btn--ghost" data-action="rotation-shift" data-delta="1"><i data-lucide="plus"></i> Shift forward</button>' +
                '</div>' +
                '<p class="hint"><i data-lucide="info"></i> Use this when the whole rotation needs to move by one person — ' +
                'for a single swap, use the sequence list below instead.</p>'
            ) +

            section('shield', 'Submission code',
                '<div class="row">' +
                '<input class="field__input" id="submissionCode" placeholder="Leave empty to allow open uploads" ' +
                'maxlength="32" value="' + U.escapeHtml(settings.submissionCode || '') + '" />' +
                '<button class="btn btn--brand" data-action="save-code"><i data-lucide="save"></i> Save</button>' +
                '</div>' +
                '<p class="hint"><i data-lucide="triangle-alert"></i> A shared code stops random visitors uploading to a slot. ' +
                'It is checked in the browser — it deters, it does not authenticate. Deploy database.rules.json for real protection.</p>'
            ) +

            section('calendar-range', 'Upcoming sequence',
                '<p class="hint"><i data-lucide="info"></i> Confirmed slots are frozen. Projected slots can still move if the roster changes.</p>' +
                '<div class="seq">' + horizonSlots.slice(0, 26).map(function (slot) {
                    return '<div class="seqRow">' +
                        '<span class="seqRow__date">' + U.escapeHtml(U.formatDate(slot.date, { month: 'short', day: 'numeric' })) +
                        ' <small>' + U.escapeHtml(slot.dayShort) + '</small></span>' +
                        '<span class="seqRow__who"><span class="avatar avatar--xs" style="--h:' + U.hueFor(slot.designer || '?') + '">' +
                        U.escapeHtml(U.initials(slot.designer || '?')) + '</span>' +
                        U.escapeHtml(slot.designer || 'Unassigned') + '</span>' +
                        '<span class="tag ' + (slot.assignmentSource === 'projected' ? '' : 'tag--info') + '">' +
                        (slot.assignmentSource === 'override' ? 'Manual' : slot.assignmentSource === 'committed' ? 'Confirmed' : 'Projected') +
                        '</span>' +
                        '<span class="seqRow__acts">' +
                        '<button class="btn btn--ghost btn--sm" data-action="reassign" data-id="' + slot.id + '">Reassign</button>' +
                        '<button class="btn btn--ghost btn--sm" data-action="swap" data-id="' + slot.id + '">Swap</button>' +
                        (slot.assignmentSource === 'override'
                            ? '<button class="btn btn--ghost btn--sm icon-only" data-action="clear-override" data-id="' + slot.id +
                            '" title="Back to automatic"><i data-lucide="rotate-ccw"></i></button>' : '') +
                        '</span></div>';
                }).join('') + '</div>'
            ) +

            section('wrench', 'Maintenance',
                '<div class="row row--wrap">' +
                '<button class="btn btn--ghost" data-action="force-reconcile"><i data-lucide="refresh-cw"></i> Re-confirm horizon</button>' +
                '<button class="btn btn--ghost" data-action="prune-logs"><i data-lucide="eraser"></i> Prune old logs</button>' +
                '</div>' +
                '<p class="hint"><i data-lucide="info"></i> Re-confirming fills in assignments for any slot inside the next ' +
                CFG.schedule.commitHorizonDays + ' days that does not have one yet. It never overwrites an existing assignment.</p>'
            );

        function section(icon, title, body) {
            return '<section class="panel"><h3 class="panel__title"><i data-lucide="' + icon + '"></i>' +
                U.escapeHtml(title) + '</h3>' + body + '</section>';
        }
    }

    /* ---- activity -------------------------------------------------------- */

    function renderActivity() {
        var host = document.getElementById('activityBody');
        var logs = App.store.state.logs;
        if (!logs.length) {
            host.innerHTML = emptyState('scroll-text', 'No activity yet',
                'Sign-ins, topic edits, uploads, approvals and backups all land here.');
            return;
        }
        host.innerHTML = '<div class="logs">' + logs.map(function (l) {
            return '<div class="log">' +
                '<span class="log__action log__action--' + toneForAction(l.action) + '">' + U.escapeHtml(l.action) + '</span>' +
                '<span class="log__detail">' + U.escapeHtml(l.details) + '</span>' +
                '<span class="log__meta">' + U.escapeHtml(l.actor) + ' · ' +
                (l.timestamp ? U.formatDateTime(l.timestamp) : '—') + '</span>' +
                '</div>';
        }).join('') + '</div>';
    }

    function toneForAction(a) {
        if (/APPROVE|BACKUP|ADD_/.test(a)) return 'success';
        if (/DELETE|REMOVE|CLEAR|CANCEL|REVISION|PRUNE/.test(a)) return 'danger';
        if (/LOGIN|LOGOUT|EXPORT/.test(a)) return 'brand';
        return 'neutral';
    }

    /* ---- backup ---------------------------------------------------------- */

    function renderBackup() {
        var host = document.getElementById('backupBody');
        var snap = App.store.isLoaded() ? App.backup.buildSnapshot({ includePosters: false }) : null;
        var lastLocal = App.backup.lastLocalExportAt();

        host.innerHTML =
            '<section class="panel">' +
            '<h3 class="panel__title"><i data-lucide="database-backup"></i> What is protected</h3>' +
            '<div class="statsRow">' +
            statTile('Slots on record', snap ? snap.counts.slots : '—', '', 'calendar-days', 'neutral') +
            statTile('Topics stored', snap ? snap.counts.topics : '—', 'Never overwritten without history', 'tag', 'brand') +
            statTile('Posters', snap ? snap.counts.posters : '—', 'Excluded from light backups', 'image', 'neutral') +
            statTile('Manual assignments', snap ? snap.counts.overrides : '—', '', 'hand', 'neutral') +
            '</div>' +
            '<p class="hint"><i data-lucide="info"></i> Every topic edit is also stored inline on its slot with the author and time, ' +
            'so an accidental overwrite can always be traced and undone.</p>' +
            '</section>' +

            '<section class="panel">' +
            '<h3 class="panel__title"><i data-lucide="download"></i> Export</h3>' +
            '<div class="row row--wrap">' +
            '<button class="btn btn--brand" data-action="export-json"><i data-lucide="file-json"></i> Download JSON backup</button>' +
            '<button class="btn btn--ghost" data-action="export-json-posters"><i data-lucide="images"></i> JSON + posters (large)</button>' +
            '<button class="btn btn--ghost" data-action="export-csv"><i data-lucide="table"></i> Topic ledger (CSV)</button>' +
            '</div>' +
            '<p class="hint"><i data-lucide="clock"></i> Last download from this browser: ' +
            (lastLocal ? U.formatDateTime(lastLocal) : 'never') + '</p>' +
            '</section>' +

            '<section class="panel">' +
            '<h3 class="panel__title"><i data-lucide="cloud-upload"></i> Cloud snapshots</h3>' +
            '<div class="row row--wrap">' +
            '<button class="btn btn--brand" data-action="snapshot-now"><i data-lucide="camera"></i> Take snapshot now</button>' +
            '<button class="btn btn--ghost" data-action="refresh-snapshots"><i data-lucide="refresh-cw"></i> Refresh list</button>' +
            '</div>' +
            '<div id="snapshotList" class="snapList"><p class="hint">Loading snapshots…</p></div>' +
            '<p class="hint"><i data-lucide="info"></i> The newest ' + CFG.backups.keep +
            ' snapshots are kept. One is taken automatically when an owner signs in and the last is over ' +
            CFG.backups.autoIntervalHours + ' hours old.</p>' +
            '</section>' +

            '<section class="panel">' +
            '<h3 class="panel__title"><i data-lucide="upload"></i> Restore from a file</h3>' +
            '<div class="row row--wrap">' +
            '<button class="btn btn--ghost" data-action="import-json"><i data-lucide="folder-open"></i> Choose backup file…</button>' +
            '</div>' +
            '<p class="hint"><i data-lucide="shield-check"></i> You always see a change summary before anything is written. ' +
            '<strong>Merge</strong> only fills gaps and never overwrites live work; <strong>replace</strong> overwrites slots ' +
            'present in the backup but never deletes slots that are not in it.</p>' +
            '</section>';

        loadSnapshots();
    }

    function loadSnapshots() {
        var host = document.getElementById('snapshotList');
        if (!host) return;
        App.backup.cloudList().then(function (list) {
            if (!host.isConnected) return;
            if (!list.length) { host.innerHTML = '<p class="hint">No cloud snapshots yet.</p>'; return; }
            host.innerHTML = list.map(function (b) {
                return '<div class="snap">' +
                    '<div class="snap__main"><strong>' + U.escapeHtml(U.formatDateTime(b.createdAt)) + '</strong>' +
                    '<small>' + U.escapeHtml(b.createdBy) + (b.auto ? ' · automatic' : ' · manual') + ' · ' +
                    (b.counts.slots || 0) + ' slots, ' + (b.counts.topics || 0) + ' topics</small></div>' +
                    '<button class="btn btn--ghost btn--sm" data-action="restore-snapshot" data-key="' + b.key + '">Restore…</button>' +
                    '<button class="btn btn--ghost btn--sm icon-only" data-action="delete-snapshot" data-key="' + b.key +
                    '" title="Delete snapshot"><i data-lucide="trash-2"></i></button>' +
                    '</div>';
            }).join('');
            U.icons();
        }).catch(function (e) {
            if (host.isConnected) host.innerHTML = '<p class="hint">Could not load snapshots: ' + U.escapeHtml(e.message) + '</p>';
        });
    }

    /* =====================================================================
     * Actions
     * ================================================================== */

    var actions = {

        /* -- auth -- */
        auth: function () {
            if (!App.auth.user) return openLogin();
            App.ui.dialog({
                title: 'Signed in as ' + App.auth.user.display,
                subtitle: App.auth.user.role === 'owner' ? 'Owner — full control' : 'Limited access',
                icon: 'user-round',
                tone: 'brand',
                confirmLabel: 'Sign out',
                cancelLabel: 'Stay signed in'
            }).then(function (r) {
                if (r === null) return;
                var name = App.auth.user.display;
                App.store.log('LOGOUT', name + ' signed out.', App.auth.actorName());
                App.auth.logout();
                App.ui.toast('Signed out.', 'info');
            });
        },

        /* -- schedule nav -- */
        'prev-month': function () { view.monthOffset = Math.max(minMonthOffset(), view.monthOffset - 1); render(); },
        'next-month': function () { view.monthOffset++; render(); },
        'today': function () { view.monthOffset = 0; view.query = ''; els.search.value = ''; render(); },

        /* -- slot: topic -- */
        'edit-topic': function (el) {
            var slot = slotById(el.dataset.id);
            if (!slot) return;
            var history = (slot.state.topicHistory || []).slice().reverse();
            var historyHtml = history.length > 1
                ? '<details class="details"><summary>Topic history (' + history.length + ')</summary><ul class="histList">' +
                history.map(function (h) {
                    return '<li><span>' + U.escapeHtml(h.topic || '(cleared)') + '</span><small>' +
                        U.escapeHtml(h.by || 'unknown') + ' · ' + U.escapeHtml(U.formatDateTime(h.at)) + '</small></li>';
                }).join('') + '</ul></details>'
                : '';

            App.ui.prompt({
                title: slot.topic ? 'Edit topic' : 'Assign topic',
                subtitle: (slot.designer || 'Unassigned') + ' · ' + U.formatDate(slot.date),
                icon: 'tag',
                confirmLabel: 'Save topic',
                body: historyHtml,
                fields: [{
                    name: 'topic', label: 'Design topic', type: 'textarea', rows: 3,
                    value: slot.topic, maxlength: CFG.limits.topicMax,
                    placeholder: 'What should this poster be about?',
                    hint: 'Previous versions are kept automatically — nothing is ever lost.'
                }]
            }).then(function (v) {
                if (!v) return;
                return App.store.setTopic(slot.id, v.topic, App.auth.actorName())
                    .then(function (changed) {
                        App.ui.toast(changed ? 'Topic saved.' : 'No change.', changed ? 'success' : 'info');
                    });
            }).catch(fail);
        },

        /* -- slot: upload -- */
        upload: function (el) {
            var slot = slotById(el.dataset.id);
            if (!slot) return;
            var ctx = App.appContext();
            var late = S.isLate(slot, ctx.now);
            var codeRequired = !!App.store.state.settings.submissionCode && !App.auth.isOwner();

            var fields = [{
                name: 'by', label: 'Your name', type: 'text',
                value: App.auth.user ? App.auth.user.display : (slot.designer || ''),
                maxlength: CFG.limits.submitterNameMax, required: true,
                hint: 'Recorded on the submission so the history stays honest.'
            }];
            if (codeRequired) {
                fields.push({ name: 'code', label: 'Submission code', type: 'password', required: true });
            }

            App.ui.prompt({
                title: 'Submit poster',
                subtitle: (slot.designer || 'Unassigned') + ' · ' + U.formatDate(slot.date) +
                    (late ? ' · past the deadline' : ''),
                icon: 'upload',
                tone: late ? 'warn' : 'brand',
                confirmLabel: 'Choose files…',
                body: late
                    ? '<p class="callout callout--warn"><i data-lucide="triangle-alert"></i>' +
                    'The deadline was ' + U.escapeHtml(U.formatDateTime(slot.deadlineAt)) +
                    '. This will be recorded as a late submission.</p>'
                    : '<p class="callout"><i data-lucide="info"></i>Up to ' + CFG.posters.maxPerSlot +
                    ' posters per slot. Images are resized to ' + CFG.posters.maxEdgePx + 'px before upload.</p>',
                fields: fields,
                validate: function (v) {
                    if (codeRequired && v.code !== App.store.state.settings.submissionCode) {
                        return 'That submission code is not correct.';
                    }
                    return null;
                }
            }).then(function (v) {
                if (!v) return;
                return App.images.pick(true).then(function (files) {
                    if (!files.length) return;
                    var room = CFG.posters.maxPerSlot - slot.posters.length;
                    if (files.length > room) {
                        throw new Error('Only ' + room + ' more poster(s) fit on this slot.');
                    }
                    var busy = App.ui.busy('Processing images…', '');
                    return App.images.processAll(files, function (i, n, name) {
                        busy.update('Processing ' + (i + 1) + ' of ' + n, name);
                    }).then(function (imgs) {
                        busy.update('Uploading…', U.formatBytes(imgs.reduce(function (a, b) { return a + b.bytes; }, 0)));
                        return App.store.submitPosters(slot.id, imgs.map(function (i) { return i.dataUrl; }),
                            { by: U.cleanName(v.by), late: late }, App.auth.actorName());
                    }).then(function () {
                        busy.done();
                        App.ui.toast(late ? 'Uploaded — flagged as late.' : 'Uploaded. Waiting for review.', 'success');
                    }).catch(function (e) { busy.done(); throw e; });
                });
            }).catch(fail);
        },

        /* -- slot: owner review -- */
        approve: function (el) {
            var slot = slotById(el.dataset.id);
            App.store.approveSlot(slot.id, App.auth.actorName())
                .then(function () { App.ui.toast('Approved.', 'success'); }).catch(fail);
        },

        revision: function (el) {
            var slot = slotById(el.dataset.id);
            App.ui.prompt({
                title: 'Request changes',
                subtitle: (slot.designer || '') + ' · ' + U.formatDate(slot.date),
                icon: 'undo-2', tone: 'warn', confirmLabel: 'Send back',
                fields: [{
                    name: 'note', label: 'What needs to change?', type: 'textarea', rows: 3,
                    required: true, maxlength: CFG.limits.noteMax,
                    hint: 'Shown on the card so the designer knows what to fix.'
                }],
                body: '<p class="callout"><i data-lucide="info"></i>The current posters stay attached until a new file is uploaded.</p>'
            }).then(function (v) {
                if (!v) return;
                return App.store.requestRevision(slot.id, v.note, App.auth.actorName())
                    .then(function () { App.ui.toast('Sent back for revision.', 'info'); });
            }).catch(fail);
        },

        reopen: function (el) {
            var slot = slotById(el.dataset.id);
            App.ui.confirm({
                title: 'Reopen this slot?',
                subtitle: U.formatDate(slot.date),
                body: '<p class="callout"><i data-lucide="info"></i>Approval is withdrawn and the slot goes back to review. Posters are kept.</p>',
                tone: 'warn', icon: 'rotate-ccw', confirmLabel: 'Reopen'
            }).then(function (ok) {
                if (!ok) return;
                return App.store.updateSlot(slot.id, { approved: false, submitted: true, approvedAt: null, approvedBy: null },
                    App.auth.actorName())
                    .then(function () {
                        App.store.log('REOPEN', 'Reopened ' + slot.id + '.', App.auth.actorName());
                        App.ui.toast('Slot reopened.', 'info');
                    });
            }).catch(fail);
        },

        excuse: function (el) {
            var slot = slotById(el.dataset.id);
            App.ui.prompt({
                title: 'Mark as excused',
                subtitle: (slot.designer || '') + ' · ' + U.formatDate(slot.date),
                icon: 'heart-handshake', tone: 'brand', confirmLabel: 'Excuse slot',
                fields: [{ name: 'reason', label: 'Reason', type: 'text', required: true, maxlength: CFG.limits.noteMax }],
                body: '<p class="callout"><i data-lucide="info"></i>An excused slot stops counting against reliability.</p>'
            }).then(function (v) {
                if (!v) return;
                return App.store.setExcused(slot.id, v.reason, App.auth.actorName())
                    .then(function () { App.ui.toast('Marked as excused.', 'success'); });
            }).catch(fail);
        },

        more: function (el) {
            var slot = slotById(el.dataset.id);
            var s = slot.state || {};
            App.ui.dialog({
                title: 'Slot actions',
                subtitle: (slot.designer || 'Unassigned') + ' · ' + U.formatDate(slot.date),
                icon: 'settings-2', tone: 'brand', wide: true,
                confirmLabel: 'Close', cancelLabel: null,
                body: '<div class="menu">' +
                    menuItem('user-round-cog', 'Reassign this slot', 'reassign', slot.id) +
                    menuItem('arrow-left-right', 'Swap with another slot', 'swap', slot.id) +
                    (s.overrideDesigner ? menuItem('rotate-ccw', 'Back to automatic rotation', 'clear-override', slot.id) : '') +
                    (slot.posters.length ? menuItem('trash-2', 'Remove all posters', 'clear-posters', slot.id) : '') +
                    (s.excused ? menuItem('undo-2', 'Remove excused flag', 'unexcuse', slot.id) : '') +
                    (s.cancelled
                        ? menuItem('calendar-check', 'Restore this slot', 'restore-slot', slot.id)
                        : menuItem('calendar-x', 'Cancel this slot', 'cancel-slot', slot.id)) +
                    '</div>' +
                    '<dl class="kv">' +
                    kv('Slot ID', slot.id) +
                    kv('Assignment', slot.assignmentSource) +
                    kv('Reveals', U.formatDate(slot.revealAt)) +
                    kv('Deadline', U.formatDateTime(slot.deadlineAt)) +
                    kv('Grace ends', U.formatDateTime(slot.graceEndsAt)) +
                    kv('Submitted by', s.submittedBy || '—') +
                    kv('Approved by', s.approvedBy || '—') +
                    kv('Revisions', String(s.revisionCount || 0)) +
                    kv('Poster weight', U.formatBytes(s.posterBytes || 0)) +
                    '</dl>'
            });

            /* data-act="cancel" closes this dialog; data-action fires the real
             * handler afterwards, so menu items never stack two dialogs. */
            function menuItem(icon, label, action, id) {
                return '<button class="menuItem" data-act="cancel" data-action="' + action + '" data-id="' + id + '">' +
                    '<i data-lucide="' + icon + '"></i>' + U.escapeHtml(label) + '</button>';
            }
            function kv(k, v) {
                return '<div><dt>' + U.escapeHtml(k) + '</dt><dd>' + U.escapeHtml(String(v)) + '</dd></div>';
            }
        },

        'clear-posters': function (el) {
            var slot = slotById(el.dataset.id);
            App.ui.confirm({
                title: 'Remove all posters?',
                subtitle: U.formatDate(slot.date),
                body: '<p class="callout callout--warn"><i data-lucide="triangle-alert"></i>' +
                    'The image files are deleted from the database. Topic, assignment and history are untouched. ' +
                    'This cannot be undone unless you have a backup that includes posters.</p>',
                confirmLabel: 'Delete posters'
            }).then(function (ok) {
                if (!ok) return;
                return App.store.clearPosters(slot.id, App.auth.actorName())
                    .then(function () { App.ui.toast('Posters removed.', 'info'); });
            }).catch(fail);
        },

        'drop-poster': function (el, e) {
            e.stopPropagation();
            var slot = slotById(el.dataset.id);
            var idx = Number(el.dataset.index);
            App.ui.confirm({
                title: 'Remove poster ' + (idx + 1) + '?',
                confirmLabel: 'Remove'
            }).then(function (ok) {
                if (!ok) return;
                var next = slot.posters.filter(function (_, i) { return i !== idx; });
                return App.store.updateSlot(slot.id, {
                    posterUrls: next.length ? next : null,
                    posterUrl: next[next.length - 1] || null,
                    submitted: next.length ? slot.state.submitted : false,
                    approved: next.length ? slot.state.approved : false
                }, App.auth.actorName()).then(function () {
                    App.store.log('CLEAR_POSTER', 'Removed poster ' + (idx + 1) + ' from ' + slot.id + '.', App.auth.actorName());
                    App.ui.toast('Poster removed.', 'info');
                });
            }).catch(fail);
        },

        unexcuse: function (el) {
            App.store.updateSlot(el.dataset.id, { excused: false, excusedReason: null }, App.auth.actorName())
                .then(function () { App.ui.toast('Excused flag removed.', 'info'); }).catch(fail);
        },

        'cancel-slot': function (el) {
            var slot = slotById(el.dataset.id);
            App.ui.prompt({
                title: 'Cancel this slot',
                subtitle: U.formatDate(slot.date),
                icon: 'calendar-x', tone: 'danger', confirmLabel: 'Cancel slot',
                fields: [{ name: 'reason', label: 'Why?', type: 'text', required: true, maxlength: CFG.limits.noteMax, placeholder: 'Public holiday, exam week…' }],
                body: '<p class="callout"><i data-lucide="info"></i>A cancelled slot is excluded from statistics and never counts as missed. ' +
                    'It does not shift anyone else in the rotation.</p>'
            }).then(function (v) {
                if (!v) return;
                return App.store.setCancelled(slot.id, true, v.reason, App.auth.actorName())
                    .then(function () { App.ui.toast('Slot cancelled.', 'info'); });
            }).catch(fail);
        },

        'restore-slot': function (el) {
            App.store.setCancelled(el.dataset.id, false, '', App.auth.actorName())
                .then(function () { App.ui.toast('Slot restored.', 'success'); }).catch(fail);
        },

        reassign: function (el) {
            var slot = slotById(el.dataset.id);
            var roster = App.store.state.designers;
            if (!roster.length) return App.ui.toast('The roster is empty.', 'warn');
            App.ui.prompt({
                title: 'Reassign slot',
                subtitle: U.formatDate(slot.date) + ' · currently ' + (slot.designer || 'unassigned'),
                icon: 'user-round-cog', confirmLabel: 'Reassign',
                fields: [{
                    name: 'designer', label: 'Designer', type: 'select', value: slot.designer,
                    options: roster.map(function (n) { return { value: n, label: n }; }),
                    hint: 'This becomes a manual assignment and is never recalculated.'
                }]
            }).then(function (v) {
                if (!v) return;
                return App.store.overrideAssignment(slot.id, v.designer, App.auth.actorName())
                    .then(function () { App.ui.toast('Reassigned to ' + v.designer + '.', 'success'); });
            }).catch(fail);
        },

        swap: function (el) {
            var slot = slotById(el.dataset.id);
            var ctx = App.appContext();
            var candidates = S.buildRange(ctx.now, U.addDays(ctx.now, 180), ctx)
                .filter(function (s) { return s.id !== slot.id && s.designer; });
            if (!candidates.length) return App.ui.toast('No other upcoming slot to swap with.', 'warn');

            App.ui.prompt({
                title: 'Swap assignments',
                subtitle: U.formatDate(slot.date) + ' · ' + (slot.designer || 'unassigned'),
                icon: 'arrow-left-right', confirmLabel: 'Swap',
                fields: [{
                    name: 'target', label: 'Swap with', type: 'select',
                    options: candidates.map(function (s) {
                        return { value: s.id, label: U.formatDate(s.date) + ' — ' + s.designer };
                    }),
                    hint: 'Both slots are updated in one atomic write.'
                }]
            }).then(function (v) {
                if (!v) return;
                var target = candidates.find(function (s) { return s.id === v.target; });
                return App.store.swapAssignments(slot, target, App.auth.actorName())
                    .then(function () { App.ui.toast('Swapped with ' + U.formatDate(target.date) + '.', 'success'); });
            }).catch(fail);
        },

        'clear-override': function (el) {
            App.store.clearOverride(el.dataset.id, App.auth.actorName())
                .then(function () { App.ui.toast('Back to the automatic rotation.', 'info'); }).catch(fail);
        },

        'view-poster': function (el) {
            var slot = slotById(el.dataset.id);
            App.ui.lightbox(slot.posters, Number(el.dataset.index), slot.designer || slot.id);
        },

        'download-all': function (el) {
            var slot = slotById(el.dataset.id);
            slot.posters.forEach(function (url, i) {
                setTimeout(function () {
                    var name = 'poster-' + (slot.designer || 'uyfsr').replace(/\s+/g, '-').toLowerCase() +
                        '-' + slot.id + '-' + (i + 1) + '.jpg';
                    fetch(url).then(function (r) { return r.blob(); })
                        .then(function (b) { U.downloadBlob(b, name); })
                        .catch(function () { U.downloadUrl(url, name); });
                }, i * 350);
            });
            App.store.log('DOWNLOAD', 'Downloaded ' + slot.posters.length + ' poster(s) from ' + slot.id + '.', App.auth.actorName());
        },

        /* -- roster / controls -- */
        'add-designer': function () {
            var input = document.getElementById('newDesigner');
            var name = input.value;
            App.store.addDesigner(name, App.auth.actorName()).then(function (clean) {
                input.value = '';
                App.ui.toast(clean + ' added to the rotation.', 'success');
            }).catch(fail);
        },

        'seed-roster': function () {
            App.store.seedRoster(App.auth.actorName()).then(function (n) {
                App.ui.toast('Seeded ' + n + ' designers. Reorder them by dragging in the Roster tab.', 'success');
            }).catch(fail);
        },

        'remove-designer': function (el) {
            var name = el.dataset.name;
            var ctx = App.appContext();
            var upcoming = S.buildRange(ctx.now, U.addDays(ctx.now, CFG.schedule.commitHorizonDays), ctx)
                .filter(function (s) { return s.designer === name; });
            App.ui.confirm({
                title: 'Remove ' + name + '?',
                subtitle: 'From the rotation',
                icon: 'user-round-x',
                body: '<p class="callout callout--warn"><i data-lucide="triangle-alert"></i>' +
                    name + ' still holds <strong>' + upcoming.length + '</strong> confirmed slot(s) in the next ' +
                    CFG.schedule.commitHorizonDays + ' days. Those keep their assignment and will show a ' +
                    '"Left the roster" tag — reassign them from the Controls tab. History and topics are never deleted.</p>',
                confirmLabel: 'Remove from rotation'
            }).then(function (ok) {
                if (!ok) return;
                return App.store.removeDesigner(name, App.auth.actorName())
                    .then(function () { App.ui.toast(name + ' removed.', 'info'); });
            }).catch(fail);
        },

        'rotation-shift': function (el) {
            var delta = Number(el.dataset.delta);
            var next = (App.store.state.settings.rotationOffset || 0) + delta;
            App.store.saveSettings({ rotationOffset: next }, App.auth.actorName()).then(function () {
                App.store.log('ROTATION_SHIFT', 'Rotation offset set to ' + next + '.', App.auth.actorName());
                App.ui.toast('Rotation shifted. Confirmed slots were not touched.', 'success');
            }).catch(fail);
        },

        'save-code': function () {
            var code = document.getElementById('submissionCode').value;
            App.store.saveSettings({ submissionCode: code }, App.auth.actorName()).then(function () {
                App.store.log('SET_CODE', code ? 'Submission code enabled.' : 'Submission code cleared.', App.auth.actorName());
                App.ui.toast(code ? 'Submission code saved.' : 'Uploads are open again.', 'success');
            }).catch(fail);
        },

        'force-reconcile': function () {
            sessionStorage.removeItem('uyfsr.reconcile.v2');
            App.store.reconcileCommitments().then(function (n) {
                App.ui.toast(n ? 'Confirmed ' + n + ' slot assignment(s).' : 'Everything in the horizon is already confirmed.',
                    n ? 'success' : 'info');
            }).catch(fail);
        },

        'prune-logs': function () {
            App.store.pruneLogs().then(function (n) {
                App.ui.toast(n ? 'Removed ' + n + ' old log entries.' : 'Nothing to prune.', 'info');
            }).catch(fail);
        },

        /* -- backup -- */
        'export-json': function () {
            var s = App.backup.exportFile({ includePosters: false });
            App.ui.toast('Backup downloaded — ' + s.counts.slots + ' slots, ' + s.counts.topics + ' topics.', 'success');
        },

        'export-json-posters': function () {
            App.ui.confirm({
                title: 'Include poster images?',
                icon: 'images', tone: 'warn', confirmLabel: 'Download anyway',
                body: '<p class="callout callout--warn"><i data-lucide="triangle-alert"></i>' +
                    'Posters are stored as base64 and dominate the file size. Expect a large download and a slow browser ' +
                    'for a few seconds. Use this before a risky change, not as a routine backup.</p>'
            }).then(function (ok) {
                if (!ok) return;
                var busy = App.ui.busy('Building full backup…', 'Serialising posters');
                setTimeout(function () {
                    try {
                        var s = App.backup.exportFile({ includePosters: true });
                        busy.done();
                        App.ui.toast('Full backup downloaded (' + s.counts.posters + ' posters).', 'success');
                    } catch (e) { busy.done(); fail(e); }
                }, 60);
            });
        },

        'export-csv': function () {
            var n = App.backup.exportTopicsCsv();
            App.ui.toast('Topic ledger exported (' + n + ' rows).', 'success');
        },

        'snapshot-now': function () {
            var busy = App.ui.busy('Writing snapshot…', '');
            App.backup.createCloudSnapshot(false).then(function (s) {
                busy.done();
                App.ui.toast('Snapshot saved — ' + s.counts.topics + ' topics protected.', 'success');
                loadSnapshots();
            }).catch(function (e) { busy.done(); fail(e); });
        },

        'refresh-snapshots': function () { loadSnapshots(); },

        'delete-snapshot': function (el) {
            App.ui.confirm({ title: 'Delete this snapshot?', confirmLabel: 'Delete' }).then(function (ok) {
                if (!ok) return;
                return App.backup.deleteCloud(el.dataset.key).then(function () {
                    App.ui.toast('Snapshot deleted.', 'info');
                    loadSnapshots();
                });
            }).catch(fail);
        },

        'restore-snapshot': function (el) {
            App.backup.fetchCloud(el.dataset.key).then(function (snap) { return offerRestore(snap); }).catch(fail);
        },

        'import-json': function () {
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = 'application/json,.json';
            input.onchange = function (e) {
                var f = (e.target.files || [])[0];
                if (!f) return;
                App.backup.importFile(f).then(offerRestore).catch(fail);
            };
            input.click();
        }
    };

    function offerRestore(snap) {
        var d = App.backup.diff(snap);
        var body =
            '<p class="callout"><i data-lucide="info"></i>Snapshot from <strong>' +
            U.escapeHtml(U.formatDateTime(snap.createdAt)) + '</strong> by ' + U.escapeHtml(snap.createdBy || 'unknown') +
            ' · ' + snap.counts.slots + ' slots, ' + snap.counts.topics + ' topics' +
            (snap.includesPosters ? ', posters included' : ', no posters') + '.</p>' +
            '<dl class="kv">' +
            '<div><dt>Slots not in the live data</dt><dd>' + d.newSlots + '</dd></div>' +
            '<div><dt>Topics that differ</dt><dd>' + d.changedTopics + '</dd></div>' +
            '<div><dt>Assignments that differ</dt><dd>' + d.changedAssignments + '</dd></div>' +
            '<div><dt>Approval states that differ</dt><dd>' + d.changedStatus + '</dd></div>' +
            '<div><dt>Roster</dt><dd>' + (d.rosterChanged ? 'differs' : 'identical') + '</dd></div>' +
            '</dl>' +
            (d.samples.length
                ? '<details class="details" open><summary>Sample topic differences</summary><ul class="histList">' +
                d.samples.map(function (s) {
                    return '<li><span>' + U.escapeHtml(s.id) + '</span><small>live: ' + U.escapeHtml(s.from) +
                        ' → backup: ' + U.escapeHtml(s.to) + '</small></li>';
                }).join('') + '</ul></details>'
                : '');

        return App.ui.prompt({
            title: 'Restore this backup?',
            subtitle: 'Review the changes before writing anything',
            icon: 'database-backup', tone: 'warn', confirmLabel: 'Restore',
            body: body,
            fields: [{
                name: 'mode', label: 'Restore mode', type: 'select', value: 'merge',
                options: [
                    { value: 'merge', label: 'Merge — only fill in what is missing (safe)' },
                    { value: 'replace', label: 'Replace — overwrite slots present in the backup' }
                ],
                hint: 'Neither mode deletes slots that are missing from the backup.'
            }]
        }).then(function (v) {
            if (!v) return;
            var busy = App.ui.busy('Restoring…', v.mode === 'replace' ? 'Overwriting matched slots' : 'Filling gaps only');
            return App.backup.restore(snap, v.mode).then(function (r) {
                busy.done();
                App.ui.toast('Restored ' + r.slots + ' slot(s), ' + r.topics + ' topic(s).', 'success');
            }).catch(function (e) { busy.done(); throw e; });
        });
    }

    function slotById(id) {
        var parts = String(id).split('-').map(Number);
        var date = new Date(parts[0], parts[1], parts[2]);
        return S.build(date, App.appContext());
    }

    function fail(err) {
        if (!err) return;
        console.error(err);
        App.ui.toast(err.message || 'Something went wrong.', 'error');
    }

    /* ---- login ----------------------------------------------------------- */

    function openLogin() {
        App.ui.prompt({
            title: 'Admin sign in',
            subtitle: 'Owner access unlocks review, topics and backups',
            icon: 'lock', confirmLabel: 'Sign in',
            fields: [
                { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'username' },
                { name: 'password', label: 'Password', type: 'password', required: true, placeholder: '••••••••' }
            ]
        }).then(function (v) {
            if (!v) return;
            return App.auth.login(v.username, v.password).then(function (user) {
                App.store.log('LOGIN', user.display + ' signed in as ' + user.role + '.', user.username);
                App.ui.toast('Welcome back, ' + user.display + '.', 'success');
                view.tab = 'schedule';
                render();
                App.backup.maybeAutoSnapshot().then(function (made) {
                    if (made) App.ui.toast('Automatic backup snapshot saved.', 'info');
                });
            }).catch(function (e) {
                App.ui.toast(e.message, 'error');
                setTimeout(openLogin, 250);
            });
        });
    }

    /* =====================================================================
     * Wiring
     * ================================================================== */

    function bind() {
        els = {
            authBtn: document.getElementById('authBtn'),
            conn: document.getElementById('conn'),
            clock: document.getElementById('clock'),
            tabs: document.getElementById('tabs'),
            grid: document.getElementById('grid'),
            statsRow: document.getElementById('statsRow'),
            monthLabel: document.getElementById('monthLabel'),
            monthBar: document.getElementById('monthBar'),
            prevMonth: document.querySelector('[data-action="prev-month"]'),
            search: document.getElementById('search'),
            chips: document.getElementById('filterChips')
        };

        document.addEventListener('click', function (e) {
            var el = e.target.closest('[data-action]');
            if (!el) return;
            var fn = actions[el.dataset.action];
            if (!fn) return;
            e.preventDefault();
            fn(el, e);
        });

        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            var el = e.target.closest('[data-action][role="button"]');
            if (!el) return;
            e.preventDefault();
            var fn = actions[el.dataset.action];
            if (fn) fn(el, e);
        });

        els.tabs.addEventListener('click', function (e) {
            var b = e.target.closest('[data-tab]');
            if (!b) return;
            view.tab = b.dataset.tab;
            render();
        });

        els.search.addEventListener('input', U.debounce(function () {
            view.query = els.search.value;
            document.getElementById('searchClear').hidden = !view.query;
            render();
        }, 180));

        document.getElementById('searchClear').addEventListener('click', function () {
            els.search.value = '';
            view.query = '';
            this.hidden = true;
            els.search.focus();
            render();
        });

        els.chips.addEventListener('click', function (e) {
            var c = e.target.closest('[data-filter]');
            if (!c) return;
            view.filter = c.dataset.filter;
            els.chips.querySelectorAll('[data-filter]').forEach(function (x) {
                x.classList.toggle('is-active', x === c);
                x.setAttribute('aria-pressed', x === c ? 'true' : 'false');
            });
            render();
        });

        /* Roster drag-to-reorder (owner). */
        document.addEventListener('dragstart', function (e) {
            var row = e.target.closest('[data-rindex]');
            if (!row) return;
            view.rosterDragIndex = Number(row.dataset.rindex);
            row.classList.add('is-dragging');
            e.dataTransfer.effectAllowed = 'move';
        });
        document.addEventListener('dragover', function (e) {
            if (view.rosterDragIndex === null) return;
            var row = e.target.closest('[data-rindex]');
            if (row) { e.preventDefault(); row.classList.add('is-dropTarget'); }
        });
        document.addEventListener('dragleave', function (e) {
            var row = e.target.closest('[data-rindex]');
            if (row) row.classList.remove('is-dropTarget');
        });
        document.addEventListener('drop', function (e) {
            var row = e.target.closest('[data-rindex]');
            if (!row || view.rosterDragIndex === null) return;
            e.preventDefault();
            var to = Number(row.dataset.rindex);
            var from = view.rosterDragIndex;
            view.rosterDragIndex = null;
            if (from === to) return render();
            var list = App.store.state.designers.slice();
            list.splice(to, 0, list.splice(from, 1)[0]);
            App.store.reorderDesigners(list, App.auth.actorName())
                .then(function () { App.ui.toast('Rotation order updated.', 'success'); })
                .catch(fail);
        });
        document.addEventListener('dragend', function () {
            view.rosterDragIndex = null;
            document.querySelectorAll('.is-dragging,.is-dropTarget').forEach(function (x) {
                x.classList.remove('is-dragging', 'is-dropTarget');
            });
        });

        document.addEventListener('keydown', function (e) {
            if (e.target.matches('input, textarea, select')) return;
            if (e.key === '/') { e.preventDefault(); els.search.focus(); }
            if (e.key === 'ArrowLeft' && view.tab === 'schedule') actions['prev-month']();
            if (e.key === 'ArrowRight' && view.tab === 'schedule') actions['next-month']();
        });
    }

    function startClock() {
        function tick() {
            var d = new Date();
            els.clock.innerHTML =
                '<strong>' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) + '</strong>' +
                '<small>' + U.escapeHtml(d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })) + '</small>';
        }
        tick();
        setInterval(tick, 20000);
        /* Countdowns and status transitions are time-based, so repaint often
         * enough that a card cannot sit in a stale state. */
        setInterval(render, 60000);
    }

    function boot() {
        bind();
        App.store.subscribe(render);
        App.auth.subscribe(render);
        App.auth.restore();
        App.store.init();
        startClock();
        render();

        if (App.auth.isOwner()) {
            App.backup.maybeAutoSnapshot();
        }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

})(window);
