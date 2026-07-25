/* =============================================================================
 * UYFSR · Backup & restore
 * -----------------------------------------------------------------------------
 * The topics, the assignment history and who submitted what are the parts of
 * this system that cannot be regenerated. Posters can be re-uploaded; a topic
 * that someone thought about for a week cannot.
 *
 * Four independent layers, so no single failure loses the record:
 *
 *   1. Topic history   – every topic edit is appended in place on the slot,
 *                        with author and timestamp (store.setTopic).
 *   2. Cloud snapshots – periodic copies under /backups inside the database,
 *                        posters stripped so they stay small. Last N kept.
 *   3. File export     – full JSON (optionally including posters) or a topic
 *                        ledger CSV, downloaded to the operator's machine.
 *   4. Local mirror    – the offline cache in store.js, refreshed on every
 *                        change, so a browser that cannot reach Firebase still
 *                        shows the last known schedule.
 * ========================================================================== */
(function (global) {
    'use strict';

    var App = global.App = global.App || {};
    var U = App.util;
    var CFG = global.APP_CONFIG;
    var P = CFG.paths;
    var LAST_LOCAL_KEY = 'uyfsr.lastExport.v2';

    var Backup = {

        /* ---- snapshot shaping ------------------------------------------- */

        /*
         * `includePosters` is off by default on purpose: base64 posters are
         * ~99% of the byte weight and are the least valuable thing to keep.
         */
        buildSnapshot: function (opts) {
            opts = opts || {};
            var slots = {};
            var counts = { slots: 0, topics: 0, approved: 0, submitted: 0, posters: 0, overrides: 0 };

            Object.keys(App.store.state.slots).forEach(function (id) {
                var src = App.store.state.slots[id] || {};
                var posters = App.schedule.postersOf(src);
                var out = {
                    assignedDesigner: src.assignedDesigner || null,
                    committedDesigner: src.committedDesigner || null,
                    overrideDesigner: src.overrideDesigner || null,
                    topic: src.topic || '',
                    topicSetBy: src.topicSetBy || null,
                    topicSetAt: src.topicSetAt || null,
                    topicHistory: Array.isArray(src.topicHistory) ? src.topicHistory : [],
                    submitted: !!src.submitted,
                    approved: !!src.approved,
                    needsRevision: !!src.needsRevision,
                    revisionNote: src.revisionNote || null,
                    excused: !!src.excused,
                    excusedReason: src.excusedReason || null,
                    cancelled: !!src.cancelled,
                    cancelledReason: src.cancelledReason || null,
                    late: !!src.late,
                    submittedBy: src.submittedBy || null,
                    submittedAt: src.submittedAt || null,
                    approvedBy: src.approvedBy || null,
                    approvedAt: src.approvedAt || null,
                    posterCount: posters.length
                };
                if (opts.includePosters && posters.length) out.posterUrls = posters;

                counts.slots++;
                if (out.topic) counts.topics++;
                if (out.approved) counts.approved++;
                else if (out.submitted) counts.submitted++;
                if (out.overrideDesigner) counts.overrides++;
                counts.posters += posters.length;

                slots[id] = out;
            });

            return {
                kind: 'uyfsr-backup',
                dataVersion: CFG.app.dataVersion,
                createdAt: Date.now(),
                createdAtISO: new Date().toISOString(),
                createdBy: App.auth.actorName(),
                includesPosters: !!opts.includePosters,
                scheduleConfig: {
                    startDate: CFG.schedule.startDate,
                    publishDays: CFG.schedule.publishDays,
                    revealDays: CFG.schedule.revealDays,
                    deadlineHour: CFG.schedule.deadlineHour
                },
                designers: App.store.state.designers.slice(),
                settings: {
                    rotationOffset: App.store.state.settings.rotationOffset || 0,
                    submissionCode: App.store.state.settings.submissionCode || ''
                },
                counts: counts,
                slots: slots
            };
        },

        /* ---- file export ------------------------------------------------- */

        exportFile: function (opts) {
            var snap = Backup.buildSnapshot(opts);
            var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
            var name = 'uyfsr-backup-' + stamp + (snap.includesPosters ? '-with-posters' : '') + '.json';
            U.downloadBlob(JSON.stringify(snap, null, 2), name, 'application/json');
            try { localStorage.setItem(LAST_LOCAL_KEY, String(Date.now())); } catch (e) { }
            App.store.log('EXPORT_BACKUP',
                'Exported ' + snap.counts.slots + ' slots / ' + snap.counts.topics + ' topics' +
                (snap.includesPosters ? ' with posters' : ''), App.auth.actorName());
            return snap;
        },

        lastLocalExportAt: function () {
            var v = Number(localStorage.getItem(LAST_LOCAL_KEY) || 0);
            return v || null;
        },

        /* Topic ledger — the one thing worth having in a spreadsheet. */
        exportTopicsCsv: function () {
            var ctx = App.appContext();
            var from = U.parseISODate(CFG.schedule.startDate);
            var to = U.addDays(new Date(), 240);
            var slots = App.schedule.buildRange(from, to, ctx);

            var rows = [['Slot ID', 'Date', 'Day', 'Designer', 'Topic', 'Set by', 'Set at', 'Status', 'Revisions']];
            slots.forEach(function (s) {
                if (!s.topic && s.status.key === 'locked') return;
                rows.push([
                    s.id,
                    U.formatDate(s.date, { year: 'numeric', month: '2-digit', day: '2-digit' }),
                    s.dayName,
                    s.designer || '',
                    s.topic || '',
                    (s.state && s.state.topicSetBy) || '',
                    s.state && s.state.topicSetAt ? new Date(s.state.topicSetAt).toISOString() : '',
                    s.status.label,
                    (s.state && s.state.revisionCount) || 0
                ]);
            });

            var csv = rows.map(function (r) { return r.map(U.csvCell).join(','); }).join('\r\n');
            var stamp = new Date().toISOString().slice(0, 10);
            /* BOM so Excel opens UTF-8 names correctly. */
            U.downloadBlob('﻿' + csv, 'uyfsr-topics-' + stamp + '.csv', 'text/csv;charset=utf-8');
            App.store.log('EXPORT_TOPICS', 'Exported topic ledger (' + (rows.length - 1) + ' rows).', App.auth.actorName());
            return rows.length - 1;
        },

        /* ---- cloud snapshots --------------------------------------------- */

        cloudList: function () {
            if (!App.store.db) return Promise.resolve([]);
            return App.store.db.ref(P.backups).orderByChild('createdAt').limitToLast(CFG.backups.keep)
                .once('value').then(function (snap) {
                    var val = snap.val() || {};
                    return Object.keys(val).map(function (k) {
                        return {
                            key: k,
                            createdAt: val[k].createdAt || 0,
                            createdBy: val[k].createdBy || 'system',
                            counts: val[k].counts || {},
                            auto: !!val[k].auto
                        };
                    }).sort(function (a, b) { return b.createdAt - a.createdAt; });
                });
        },

        createCloudSnapshot: function (auto) {
            if (!App.auth.isOwner()) return Promise.reject(new Error('Only an owner can write a cloud snapshot.'));
            if (!App.store.db) return Promise.reject(new Error('Not connected to the database.'));
            if (!App.store.isLoaded()) return Promise.reject(new Error('Data is still loading.'));

            var snap = Backup.buildSnapshot({ includePosters: false });
            snap.auto = !!auto;

            var ref = App.store.db.ref(P.backups).push();
            return App.store.write(ref, snap, { method: 'set' })
                .then(function () { return Backup.pruneCloud(); })
                .then(function () {
                    return App.store.log('CLOUD_BACKUP',
                        (auto ? 'Automatic' : 'Manual') + ' snapshot — ' + snap.counts.slots +
                        ' slots, ' + snap.counts.topics + ' topics.', App.auth.actorName());
                })
                .then(function () { return snap; });
        },

        pruneCloud: function () {
            return App.store.db.ref(P.backups).once('value').then(function (s) {
                var val = s.val() || {};
                var keys = Object.keys(val).sort(function (a, b) {
                    return (val[a].createdAt || 0) - (val[b].createdAt || 0);
                });
                var excess = keys.length - CFG.backups.keep;
                if (excess <= 0) return 0;
                var patch = {};
                keys.slice(0, excess).forEach(function (k) { patch[P.backups + '/' + k] = null; });
                return App.store.multiUpdate(patch).then(function () { return excess; });
            });
        },

        /* Runs once per owner session, quietly, if the newest snapshot is old. */
        maybeAutoSnapshot: function () {
            if (!App.auth.isOwner() || !App.store.state.connected) return Promise.resolve(false);
            return Backup.cloudList().then(function (list) {
                var newest = list[0];
                var ageMs = newest ? Date.now() - newest.createdAt : Infinity;
                if (ageMs < CFG.backups.autoIntervalHours * 3600000) return false;
                return Backup.createCloudSnapshot(true).then(function () { return true; });
            }).catch(function (e) {
                console.warn('[backup] auto snapshot skipped:', e.message);
                return false;
            });
        },

        fetchCloud: function (key) {
            return App.store.db.ref(P.backups + '/' + key).once('value').then(function (s) {
                var v = s.val();
                if (!v) throw new Error('That snapshot no longer exists.');
                return v;
            });
        },

        deleteCloud: function (key) {
            return App.store.write(App.store.db.ref(P.backups + '/' + key), null, { method: 'remove' })
                .then(function () {
                    return App.store.log('DELETE_BACKUP', 'Removed snapshot ' + key + '.', App.auth.actorName());
                });
        },

        /* ---- validation + restore ----------------------------------------- */

        validate: function (obj) {
            if (!obj || typeof obj !== 'object') throw new Error('That file is not valid JSON.');
            if (obj.kind !== 'uyfsr-backup') throw new Error('This is not a UYFSR backup file.');
            if (!obj.slots || typeof obj.slots !== 'object') throw new Error('The backup has no slot data.');
            if (!Array.isArray(obj.designers)) throw new Error('The backup has no designer roster.');
            if (Number(obj.dataVersion) > CFG.app.dataVersion) {
                throw new Error('This backup was written by a newer version of the dashboard.');
            }
            return obj;
        },

        /*
         * Compare a snapshot against what is live right now, so the operator
         * sees exactly what a restore would change *before* confirming.
         */
        diff: function (snap) {
            var live = App.store.state.slots;
            var d = {
                newSlots: 0, changedTopics: 0, changedAssignments: 0, changedStatus: 0,
                topicsLostIfReplace: 0, rosterChanged: false, samples: []
            };

            Object.keys(snap.slots).forEach(function (id) {
                var b = snap.slots[id] || {};
                var l = live[id];
                if (!l) { d.newSlots++; return; }
                if ((b.topic || '') !== (l.topic || '')) {
                    d.changedTopics++;
                    if (d.samples.length < 6) {
                        d.samples.push({ id: id, from: l.topic || '(empty)', to: b.topic || '(empty)' });
                    }
                }
                var bA = b.overrideDesigner || b.committedDesigner || b.assignedDesigner || '';
                var lA = l.overrideDesigner || l.committedDesigner || l.assignedDesigner || '';
                if (bA !== lA) d.changedAssignments++;
                if (!!b.approved !== !!l.approved || !!b.submitted !== !!l.submitted) d.changedStatus++;
            });

            Object.keys(live).forEach(function (id) {
                if (!snap.slots[id] && (live[id] || {}).topic) d.topicsLostIfReplace++;
            });

            d.rosterChanged = JSON.stringify(snap.designers) !== JSON.stringify(App.store.state.designers);
            return d;
        },

        /*
         * mode 'merge'   – only fills gaps. Never overwrites a topic, poster or
         *                  approval that exists live. This is the safe default.
         * mode 'replace' – slots present in the backup are overwritten wholesale.
         *                  Slots absent from the backup are LEFT ALONE (a restore
         *                  should not silently delete newer work).
         *
         * Posters are only restored from a backup that actually carries them.
         */
        restore: function (snap, mode) {
            if (!App.auth.isOwner()) return Promise.reject(new Error('Only an owner can restore a backup.'));
            Backup.validate(snap);

            var pre = P.slots + '/';
            var patch = {};
            var touched = 0, topics = 0;
            var live = App.store.state.slots;

            Object.keys(snap.slots).forEach(function (id) {
                var b = snap.slots[id] || {};
                var l = live[id] || {};
                var target = {};

                function take(field, value) {
                    if (value === undefined) return;
                    if (mode === 'replace') { target[field] = value; return; }
                    var isEmpty = l[field] === undefined || l[field] === null || l[field] === '' ||
                        (Array.isArray(l[field]) && !l[field].length);
                    if (isEmpty && value !== null && value !== '' && value !== false) target[field] = value;
                }

                take('topic', b.topic || '');
                take('topicSetBy', b.topicSetBy);
                take('topicSetAt', b.topicSetAt);
                take('topicHistory', Array.isArray(b.topicHistory) && b.topicHistory.length ? b.topicHistory : undefined);
                take('committedDesigner', b.committedDesigner);
                take('overrideDesigner', b.overrideDesigner);
                take('assignedDesigner', b.assignedDesigner || b.committedDesigner);
                take('submittedBy', b.submittedBy);
                take('submittedAt', b.submittedAt);
                take('approvedBy', b.approvedBy);
                take('approvedAt', b.approvedAt);
                take('excusedReason', b.excusedReason);
                take('cancelledReason', b.cancelledReason);
                take('revisionNote', b.revisionNote);

                if (mode === 'replace') {
                    target.submitted = !!b.submitted;
                    target.approved = !!b.approved;
                    target.excused = !!b.excused;
                    target.cancelled = !!b.cancelled;
                    target.needsRevision = !!b.needsRevision;
                    target.late = !!b.late;
                }

                if (snap.includesPosters && Array.isArray(b.posterUrls) && b.posterUrls.length) {
                    if (mode === 'replace' || !App.schedule.postersOf(l).length) {
                        target.posterUrls = b.posterUrls;
                        target.posterUrl = b.posterUrls[b.posterUrls.length - 1];
                    }
                }

                var keys = Object.keys(target);
                if (!keys.length) return;
                touched++;
                if ('topic' in target) topics++;
                keys.forEach(function (k) { patch[pre + id + '/' + k] = target[k]; });
                patch[pre + id + '/restoredAt'] = Date.now();
            });

            var rosterPromise = Promise.resolve();
            if (mode === 'replace' && Array.isArray(snap.designers) && snap.designers.length) {
                rosterPromise = App.store.write(App.store.db.ref(P.designers), snap.designers, { method: 'set' });
            }

            return rosterPromise
                .then(function () { return App.store.multiUpdate(patch); })
                .then(function () {
                    return App.store.log('RESTORE_BACKUP',
                        'Restored (' + mode + ') from ' + new Date(snap.createdAt).toISOString() +
                        ' — ' + touched + ' slots, ' + topics + ' topics.', App.auth.actorName());
                })
                .then(function () { return { slots: touched, topics: topics }; });
        },

        importFile: function (file) {
            return U.readFileAsText(file).then(function (text) {
                var obj;
                try { obj = JSON.parse(text); }
                catch (e) { throw new Error('That file is not valid JSON.'); }
                return Backup.validate(obj);
            });
        }
    };

    App.backup = Backup;

})(window);
