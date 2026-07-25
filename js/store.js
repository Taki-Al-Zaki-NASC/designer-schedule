/* =============================================================================
 * UYFSR · Data layer
 * -----------------------------------------------------------------------------
 * Everything that touches Firebase lives here. The rest of the app only sees
 * App.store.state and a set of intent-shaped methods.
 *
 * What this layer adds over raw db.ref().set():
 *   · validation before every write, mirroring database.rules.json
 *   · retry with backoff + a hard timeout, so a hung write surfaces instead of
 *     silently hanging the UI
 *   · connection tracking and a localStorage mirror, so the dashboard still
 *     renders the last known schedule when the network is down
 *   · atomic multi-path updates for anything that must not half-apply
 *   · an idempotent, throttled reconcile pass that freezes near-term
 *     assignments — replacing v1's write-on-every-render loop
 * ========================================================================== */
(function (global) {
    'use strict';

    var App = global.App = global.App || {};
    var U = App.util;
    var CFG = global.APP_CONFIG;
    var P = CFG.paths;
    var CACHE_KEY = 'uyfsr.cache.v2';
    var RECONCILE_KEY = 'uyfsr.reconcile.v2';

    function ValidationError(msg) {
        var e = new Error(msg);
        e.name = 'ValidationError';
        return e;
    }

    var Store = {

        db: null,
        ready: false,

        state: {
            designers: [],
            slots: {},
            settings: { rotationOffset: 0, submissionCode: '' },
            logs: [],
            connected: false,
            loaded: { designers: false, slots: false, settings: false },
            fromCache: false,
            lastError: null
        },

        _subs: [],
        _reconcileTimer: null,

        /* ---- subscription ------------------------------------------------ */

        subscribe: function (fn) {
            Store._subs.push(fn);
            return function () {
                var i = Store._subs.indexOf(fn);
                if (i > -1) Store._subs.splice(i, 1);
            };
        },

        emit: function (reason) {
            Store._subs.forEach(function (fn) {
                try { fn(Store.state, reason); } catch (e) { console.error('[store] subscriber failed', e); }
            });
        },

        /* ---- boot -------------------------------------------------------- */

        init: function () {
            Store.restoreCache();

            if (!global.firebase || !firebase.database) {
                Store.state.lastError = 'Firebase SDK failed to load.';
                Store.state.loaded = { designers: true, slots: true, settings: true };
                Store.emit('offline-boot');
                return;
            }

            firebase.initializeApp(CFG.firebase);
            Store.db = firebase.database();

            Store.db.ref('.info/connected').on('value', function (snap) {
                var was = Store.state.connected;
                Store.state.connected = snap.val() === true;
                if (was !== Store.state.connected) Store.emit('connection');
            });

            Store.db.ref(P.designers).on('value', function (snap) {
                var val = snap.val();
                var list = [];
                if (Array.isArray(val)) list = val.filter(Boolean);
                else if (val && typeof val === 'object') list = Object.values(val).filter(Boolean);
                Store.state.designers = list.map(U.cleanName);
                Store.state.loaded.designers = true;
                Store.state.fromCache = false;
                Store.persistCache();
                Store.emit('designers');
                Store.scheduleReconcile();
            }, Store.onReadError('designers'));

            Store.db.ref(P.slots).on('value', function (snap) {
                Store.state.slots = snap.val() || {};
                Store.state.loaded.slots = true;
                Store.state.fromCache = false;
                Store.persistCache();
                Store.emit('slots');
                Store.scheduleReconcile();
            }, Store.onReadError('slots'));

            Store.db.ref(P.settings).on('value', function (snap) {
                var v = snap.val() || {};
                Store.state.settings = {
                    rotationOffset: Number(v.rotationOffset) || 0,
                    submissionCode: typeof v.submissionCode === 'string' ? v.submissionCode : '',
                    updatedAt: v.updatedAt || null,
                    updatedBy: v.updatedBy || null
                };
                Store.state.loaded.settings = true;
                Store.persistCache();
                Store.emit('settings');
                Store.scheduleReconcile();
            }, Store.onReadError('settings'));

            Store.db.ref(P.logs).limitToLast(CFG.logs.show).on('value', function (snap) {
                var val = snap.val() || {};
                Store.state.logs = Object.keys(val).map(function (k) {
                    var l = val[k] || {};
                    return {
                        key: k,
                        action: l.action || 'EVENT',
                        details: l.details || '',
                        actor: l.actor || 'system',
                        timestamp: l.timestamp || 0
                    };
                }).sort(function (a, b) { return b.timestamp - a.timestamp; });
                Store.emit('logs');
            }, Store.onReadError('logs'));
        },

        onReadError: function (what) {
            return function (err) {
                console.error('[store] read failed:', what, err);
                Store.state.lastError = 'Could not read ' + what + ': ' + (err && err.message || err);
                Store.state.loaded[what] = true;
                Store.emit('error');
            };
        },

        isLoaded: function () {
            var l = Store.state.loaded;
            return l.designers && l.slots && l.settings;
        },

        /* ---- offline cache ----------------------------------------------- */

        /* Posters are stripped: they are huge and localStorage is ~5 MB. */
        persistCache: function () {
            try {
                var slim = {};
                Object.keys(Store.state.slots).forEach(function (id) {
                    var s = Object.assign({}, Store.state.slots[id]);
                    delete s.posterUrl;
                    delete s.posterUrls;
                    s._posterCount = App.schedule.postersOf(Store.state.slots[id]).length;
                    slim[id] = s;
                });
                localStorage.setItem(CACHE_KEY, JSON.stringify({
                    at: Date.now(),
                    designers: Store.state.designers,
                    settings: Store.state.settings,
                    slots: slim
                }));
            } catch (e) { /* quota or private mode — cache is best effort */ }
        },

        restoreCache: function () {
            try {
                var raw = localStorage.getItem(CACHE_KEY);
                if (!raw) return;
                var c = JSON.parse(raw);
                if (!c || !c.slots) return;
                Store.state.designers = c.designers || [];
                Store.state.slots = c.slots || {};
                Store.state.settings = Object.assign(Store.state.settings, c.settings || {});
                Store.state.fromCache = true;
                Store.state.cachedAt = c.at;
            } catch (e) { /* ignore corrupt cache */ }
        },

        /* ---- write plumbing ---------------------------------------------- */

        /*
         * All writes funnel through here: timeout, bounded retry, error
         * surfacing. A silent write failure is the worst failure mode for a
         * shared schedule, so nothing is fire-and-forget.
         */
        write: function (ref, payload, opts) {
            opts = opts || {};
            var attempts = opts.attempts || 3;
            var method = opts.method || 'update';

            if (!Store.db) return Promise.reject(new Error('Not connected to the database.'));

            function attempt(n) {
                var op = method === 'set' ? ref.set(payload)
                    : method === 'remove' ? ref.remove()
                        : ref.update(payload);

                var timeout = new Promise(function (_, reject) {
                    setTimeout(function () { reject(new Error('Timed out talking to the database.')); }, 12000);
                });

                return Promise.race([op, timeout]).catch(function (err) {
                    if (n < attempts) {
                        return new Promise(function (r) { setTimeout(r, 400 * Math.pow(2, n)); })
                            .then(function () { return attempt(n + 1); });
                    }
                    Store.state.lastError = err.message;
                    throw err;
                });
            }

            return attempt(1);
        },

        /* Server clock where available, local clock as a last resort — never a
         * ReferenceError just because the SDK did not load. */
        serverTime: function () {
            return (global.firebase && firebase.database && firebase.database.ServerValue)
                ? firebase.database.ServerValue.TIMESTAMP
                : Date.now();
        },

        updateSlot: function (slotId, patch, actor) {
            if (!Store.db) return Promise.reject(new Error('Not connected to the database.'));
            patch = Object.assign({}, patch, {
                updatedAt: Store.serverTime(),
                updatedBy: actor || 'guest'
            });
            return Store.write(Store.db.ref(P.slots + '/' + slotId), patch);
        },

        /* One atomic transaction across many paths. Either all of it lands or
         * none of it does — used for swaps and commit batches. */
        multiUpdate: function (map) {
            if (!Object.keys(map).length) return Promise.resolve();
            return Store.write(Store.db.ref(), map);
        },

        /* ---- logging ------------------------------------------------------ */

        log: function (action, details, actor) {
            if (!Store.db) return Promise.resolve();
            return Store.db.ref(P.logs).push({
                action: action,
                details: String(details).slice(0, 300),
                actor: actor || 'guest',
                timestamp: Store.serverTime()
            }).catch(function (e) { console.warn('[store] log failed', e); });
        },

        /* Owner-only housekeeping so admin_logs does not grow forever. */
        pruneLogs: function () {
            if (!Store.db) return Promise.resolve();
            return Store.db.ref(P.logs).once('value').then(function (snap) {
                var val = snap.val() || {};
                var keys = Object.keys(val).sort(function (a, b) {
                    return (val[a].timestamp || 0) - (val[b].timestamp || 0);
                });
                var excess = keys.length - CFG.logs.keep;
                if (excess <= 0) return 0;
                var patch = {};
                keys.slice(0, excess).forEach(function (k) { patch[P.logs + '/' + k] = null; });
                return Store.multiUpdate(patch).then(function () { return excess; });
            });
        },

        /* ---- designers ---------------------------------------------------- */

        validateDesignerName: function (name, existing) {
            var L = CFG.limits;
            name = U.cleanName(name);
            if (name.length < L.designerNameMin) throw ValidationError('Name must be at least ' + L.designerNameMin + ' characters.');
            if (name.length > L.designerNameMax) throw ValidationError('Name must be under ' + L.designerNameMax + ' characters.');
            if (!/^[\p{L}\p{N}][\p{L}\p{N} .'\-]*$/u.test(name)) throw ValidationError('Name contains characters that are not allowed.');
            var dupe = (existing || Store.state.designers).some(function (d) {
                return d.toLowerCase() === name.toLowerCase();
            });
            if (dupe) throw ValidationError(name + ' is already in the rotation.');
            if ((existing || Store.state.designers).length >= L.maxDesigners) {
                throw ValidationError('The rotation is capped at ' + L.maxDesigners + ' designers.');
            }
            return name;
        },

        addDesigner: function (rawName, actor) {
            var name;
            try { name = Store.validateDesignerName(rawName); }
            catch (e) { return Promise.reject(e); }

            var next = Store.state.designers.concat([name]);
            return Store.write(Store.db.ref(P.designers), next, { method: 'set' })
                .then(function () {
                    return Store.log('ADD_DESIGNER', 'Added ' + name + ' to the rotation.', actor);
                })
                .then(function () { return name; });
        },

        removeDesigner: function (name, actor) {
            var next = Store.state.designers.filter(function (d) { return d !== name; });
            if (next.length === Store.state.designers.length) {
                return Promise.reject(ValidationError(name + ' is not in the rotation.'));
            }
            return Store.write(Store.db.ref(P.designers), next, { method: 'set' })
                .then(function () {
                    return Store.log('REMOVE_DESIGNER',
                        'Removed ' + name + '. Committed slots keep their assignment.', actor);
                });
        },

        /* Explicit, owner-triggered seed. Refuses if anyone is already there,
         * so it can never clobber a live roster. */
        seedRoster: function (actor) {
            if (Store.state.designers.length) {
                return Promise.reject(ValidationError('The roster is not empty.'));
            }
            var seed = (CFG.defaultRoster || []).map(U.cleanName).filter(Boolean);
            if (!seed.length) return Promise.reject(ValidationError('No default roster is configured.'));
            return Store.write(Store.db.ref(P.designers), seed, { method: 'set' })
                .then(function () {
                    return Store.log('SEED_ROSTER', 'Seeded ' + seed.length + ' designers.', actor);
                })
                .then(function () { return seed.length; });
        },

        reorderDesigners: function (list, actor) {
            var clean = list.map(U.cleanName).filter(Boolean);
            if (clean.length !== Store.state.designers.length) {
                return Promise.reject(ValidationError('Roster order is out of sync — reload and try again.'));
            }
            return Store.write(Store.db.ref(P.designers), clean, { method: 'set' })
                .then(function () { return Store.log('REORDER_ROSTER', 'Rotation order changed.', actor); });
        },

        /* ---- settings ------------------------------------------------------ */

        saveSettings: function (patch, actor) {
            var next = {};
            if ('rotationOffset' in patch) next.rotationOffset = Math.round(Number(patch.rotationOffset) || 0);
            if ('submissionCode' in patch) {
                var code = String(patch.submissionCode || '').trim();
                if (code.length > 32) return Promise.reject(ValidationError('Submission code is too long.'));
                next.submissionCode = code;
            }
            next.updatedAt = Store.serverTime();
            next.updatedBy = actor || 'guest';
            return Store.write(Store.db.ref(P.settings), next);
        },

        /* ---- slot actions --------------------------------------------------- */

        setTopic: function (slotId, topic, actor) {
            topic = String(topic || '').trim();
            if (topic.length > CFG.limits.topicMax) {
                return Promise.reject(ValidationError('Topic must be under ' + CFG.limits.topicMax + ' characters.'));
            }
            var prev = (Store.state.slots[slotId] || {}).topic || '';
            if (prev === topic) return Promise.resolve(false);

            /* Topic history is the whole reason this app exists — it is append
             * only, and every revision keeps its author and timestamp. */
            var history = Array.isArray((Store.state.slots[slotId] || {}).topicHistory)
                ? Store.state.slots[slotId].topicHistory.slice(-19)
                : [];
            history.push({
                topic: topic,
                previous: prev,
                by: actor || 'guest',
                at: Date.now()
            });

            return Store.updateSlot(slotId, {
                topic: topic,
                topicSetBy: actor || 'guest',
                topicSetAt: Date.now(),
                topicHistory: history
            }, actor).then(function () {
                return Store.log('SET_TOPIC',
                    (prev ? 'Changed' : 'Assigned') + ' topic on ' + slotId + ': "' + topic.slice(0, 80) + '"', actor);
            }).then(function () { return true; });
        },

        submitPosters: function (slotId, images, meta, actor) {
            var existing = App.schedule.postersOf(Store.state.slots[slotId]);
            var merged = existing.concat(images);
            var P_CFG = CFG.posters;

            if (merged.length > P_CFG.maxPerSlot) {
                return Promise.reject(ValidationError(
                    'A slot holds at most ' + P_CFG.maxPerSlot + ' posters. Remove one before adding more.'));
            }
            var total = merged.reduce(function (n, s) { return n + U.bytesOf(s); }, 0);
            if (total > P_CFG.maxBytesPerSlot) {
                return Promise.reject(ValidationError(
                    'Total poster size for this slot would be ' + U.formatBytes(total) +
                    ', over the ' + U.formatBytes(P_CFG.maxBytesPerSlot) + ' limit.'));
            }

            return Store.updateSlot(slotId, {
                submitted: true,
                approved: false,
                needsRevision: false,
                revisionNote: null,
                posterUrls: merged,
                posterUrl: merged[merged.length - 1] || null,
                submittedAt: Date.now(),
                submittedBy: meta.by || actor || 'guest',
                late: !!meta.late,
                posterBytes: total
            }, actor).then(function () {
                return Store.log('SUBMIT_POSTER',
                    (meta.by || 'Someone') + ' uploaded ' + images.length +
                    ' poster(s) for ' + slotId + (meta.late ? ' (late)' : ''), actor);
            });
        },

        approveSlot: function (slotId, actor) {
            return Store.updateSlot(slotId, {
                approved: true,
                submitted: true,
                needsRevision: false,
                revisionNote: null,
                approvedAt: Date.now(),
                approvedBy: actor
            }, actor).then(function () {
                return Store.log('APPROVE', 'Approved ' + slotId + '.', actor);
            });
        },

        requestRevision: function (slotId, note, actor) {
            note = String(note || '').trim().slice(0, CFG.limits.noteMax);
            return Store.updateSlot(slotId, {
                approved: false,
                submitted: false,
                needsRevision: true,
                revisionNote: note,
                revisionRequestedAt: Date.now(),
                revisionCount: ((Store.state.slots[slotId] || {}).revisionCount || 0) + 1
            }, actor).then(function () {
                return Store.log('REQUEST_REVISION', 'Revision requested on ' + slotId + ': ' + note, actor);
            });
        },

        clearPosters: function (slotId, actor) {
            var keep = !!(Store.state.slots[slotId] || {}).approved;
            return Store.updateSlot(slotId, {
                posterUrls: null,
                posterUrl: null,
                posterBytes: 0,
                submitted: keep,
                approved: keep
            }, actor).then(function () {
                return Store.log('CLEAR_POSTER', 'Poster files removed from ' + slotId + '.', actor);
            });
        },

        setExcused: function (slotId, reason, actor) {
            return Store.updateSlot(slotId, {
                excused: true,
                excusedReason: String(reason || '').slice(0, CFG.limits.noteMax),
                excusedAt: Date.now(),
                excusedBy: actor
            }, actor).then(function () {
                return Store.log('EXCUSE', 'Excused ' + slotId + ': ' + reason, actor);
            });
        },

        setCancelled: function (slotId, cancelled, reason, actor) {
            return Store.updateSlot(slotId, {
                cancelled: !!cancelled,
                cancelledReason: cancelled ? String(reason || '').slice(0, CFG.limits.noteMax) : null,
                cancelledAt: cancelled ? Date.now() : null,
                cancelledBy: cancelled ? actor : null
            }, actor).then(function () {
                return Store.log(cancelled ? 'CANCEL_SLOT' : 'RESTORE_SLOT',
                    (cancelled ? 'Cancelled ' : 'Restored ') + slotId + (reason ? ': ' + reason : ''), actor);
            });
        },

        /* Reassign one slot. Writes an override so reconcile never undoes it. */
        overrideAssignment: function (slotId, designer, actor) {
            return Store.updateSlot(slotId, {
                overrideDesigner: designer || null,
                committedDesigner: designer || null,
                assignedDesigner: designer || null
            }, actor).then(function () {
                return Store.log('REASSIGN', 'Slot ' + slotId + ' reassigned to ' + designer + '.', actor);
            });
        },

        /* Swap two slots atomically — a half-applied swap would duplicate a
         * designer and drop another, so this must be all-or-nothing. */
        swapAssignments: function (a, b, actor) {
            if (!a || !b || a.id === b.id) return Promise.resolve();
            var patch = {};
            var pre = P.slots + '/';
            [[a, b.designer], [b, a.designer]].forEach(function (pair) {
                var slot = pair[0], name = pair[1];
                patch[pre + slot.id + '/overrideDesigner'] = name;
                patch[pre + slot.id + '/committedDesigner'] = name;
                patch[pre + slot.id + '/assignedDesigner'] = name;
                patch[pre + slot.id + '/updatedBy'] = actor || 'guest';
                patch[pre + slot.id + '/updatedAt'] = Store.serverTime();
            });
            return Store.multiUpdate(patch).then(function () {
                return Store.log('SWAP_SLOTS',
                    'Swapped ' + a.id + ' (' + a.designer + ') with ' + b.id + ' (' + b.designer + ').', actor);
            });
        },

        clearOverride: function (slotId, actor) {
            return Store.updateSlot(slotId, {
                overrideDesigner: null,
                committedDesigner: null
            }, actor).then(function () {
                return Store.log('CLEAR_OVERRIDE', 'Manual assignment cleared on ' + slotId + '.', actor);
            });
        },

        /* ---- reconcile ------------------------------------------------------ */

        scheduleReconcile: function () {
            clearTimeout(Store._reconcileTimer);
            Store._reconcileTimer = setTimeout(function () {
                Store.reconcileCommitments().catch(function (e) {
                    console.warn('[store] reconcile skipped:', e.message);
                });
            }, 1500);
        },

        /*
         * Freeze assignments inside the commit horizon.
         *
         * v1 rewrote every slot on every render, which fed its own listener and
         * looped. This runs at most once per throttle window, only ever fills in
         * values that are MISSING, and writes them in one atomic batch. If there
         * is nothing to do it performs zero writes.
         */
        reconcileCommitments: function () {
            if (!Store.db || !Store.state.connected) return Promise.resolve(0);
            if (!Store.isLoaded()) return Promise.resolve(0);
            if (!Store.state.designers.length) return Promise.resolve(0);

            var throttleMs = CFG.schedule.reconcileThrottleMinutes * 60000;
            var last = Number(sessionStorage.getItem(RECONCILE_KEY) || 0);
            if (Date.now() - last < throttleMs) return Promise.resolve(0);

            var now = new Date();
            var ctx = {
                roster: Store.state.designers,
                states: Store.state.slots,
                rotationOffset: Store.state.settings.rotationOffset,
                now: now
            };

            var from = U.addDays(now, -1);
            var to = U.addDays(now, CFG.schedule.commitHorizonDays);
            var slots = App.schedule.buildRange(from, to, ctx);

            var patch = {};
            var pre = P.slots + '/';
            slots.forEach(function (slot) {
                if (!slot.designer) return;
                var s = slot.state || {};
                if (s.overrideDesigner || s.committedDesigner) return;
                patch[pre + slot.id + '/committedDesigner'] = slot.designer;
                patch[pre + slot.id + '/assignedDesigner'] = slot.designer;
                patch[pre + slot.id + '/committedAt'] = Store.serverTime();
            });

            var count = Object.keys(patch).length / 3;
            sessionStorage.setItem(RECONCILE_KEY, String(Date.now()));
            if (!count) return Promise.resolve(0);

            return Store.multiUpdate(patch).then(function () { return count; });
        }
    };

    App.store = Store;

})(window);
