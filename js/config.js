/* =============================================================================
 * UYFSR · Configuration
 * -----------------------------------------------------------------------------
 * Single place to tune the whole system. Nothing else should hard-code these.
 * ========================================================================== */
(function (global) {
    'use strict';

    global.APP_CONFIG = {

        app: {
            name: 'UYFSR',
            title: 'Schedule & Submission Dashboard',
            /* Bumped whenever the stored data shape changes. Written into backups. */
            dataVersion: 2
        },

        firebase: {
            apiKey: 'AIzaSyD2rVSwbwjW7Wp30askxe2Sldxjd7Po9mo',
            authDomain: 'uyfsr-ae621.firebaseapp.com',
            projectId: 'uyfsr-ae621',
            storageBucket: 'uyfsr-ae621.firebasestorage.app',
            messagingSenderId: '749011113927',
            appId: '1:749011113927:web:e9b0860de944ada7482be2',
            measurementId: 'G-75F66FVXFE'
        },

        /* Realtime Database node names. Kept identical to v1 so every existing
         * topic / poster / assignment already in the database keeps working.   */
        paths: {
            designers: 'designers_list',
            slots: 'schedule_slots',
            logs: 'admin_logs',
            settings: 'settings',
            backups: 'backups'
        },

        /* Offered as a one-click seed when the roster is empty. Never written
         * automatically — v1 let any visitor's browser seed the database. */
        defaultRoster: [
            'Shahrin Noor Sarah',
            'Mushfiqur Rahman Pranto',
            'Ahanaf Fahad Sinan',
            'Sirajum Munira',
            'Taki Al Zaki',
            'Tashkir'
        ],

        schedule: {
            /* First day the rotation is allowed to produce a slot (inclusive). */
            startDate: '2026-07-30',

            /* Days of the week that get a publishing slot. 0=Sun … 6=Sat.      */
            publishDays: [5, 6],

            /* Local hour the poster is due on the slot day (24h clock).        */
            deadlineHour: 20,

            /* Hours after the deadline a late submission is still accepted.    */
            graceHours: 24,

            /* How many days before a slot its designer + actions are revealed. */
            revealDays: 18,

            /* How far ahead assignments get frozen into the database. Beyond
             * this horizon the schedule is a *projection* and can still move
             * if the roster changes.                                           */
            commitHorizonDays: 45,

            /* Minutes between two reconcile passes from the same browser tab.  */
            reconcileThrottleMinutes: 10
        },

        posters: {
            maxPerSlot: 4,
            /* Longest edge after downscaling, in pixels.                       */
            maxEdgePx: 1600,
            jpegQuality: 0.82,
            /* Hard ceiling for one encoded image. Realtime Database chokes on
             * very large string nodes, so we refuse instead of corrupting.     */
            maxBytesPerImage: 900 * 1024,
            /* Ceiling for everything stored on a single slot.                  */
            maxBytesPerSlot: 2.6 * 1024 * 1024
        },

        limits: {
            designerNameMin: 2,
            designerNameMax: 60,
            maxDesigners: 40,
            topicMax: 300,
            noteMax: 240,
            submitterNameMax: 60
        },

        logs: {
            /* Newest N shown in the Activity tab.                              */
            show: 60,
            /* Older entries above this count are pruned by an owner session.   */
            keep: 300
        },

        backups: {
            /* Snapshots kept inside the database.                              */
            keep: 20,
            /* An owner session creates a snapshot if the newest one is older.  */
            autoIntervalHours: 12
        },

        /* -------------------------------------------------------------------
         * Admin accounts.
         *
         * IMPORTANT — read SETUP.md. This is *browser-side* gatekeeping: it
         * hides the controls, it does not protect the database. Real protection
         * comes from database.rules.json + Firebase Auth. Passwords are stored
         * as salted SHA-256 so they are not readable in view-source, which is a
         * speed bump, not a lock.
         *
         * hash = SHA256("UYFSR|" + username + "|" + password)
         * Use tools/hash-password.html to generate a new one.
         * ---------------------------------------------------------------- */
        accounts: {
            taki: {
                role: 'owner',
                display: 'Taki',
                hash: 'd00e92f62e0448909b151032f2857b6a69f45317672dd3b827d71bb03f45a10d'
            },
            jarin: {
                role: 'owner',
                display: 'Jarin',
                hash: 'f02371f7b5906162a1afdbff310aa0d57af12e8fc9d8150791efe1e1e0cc9030'
            }
        },

        /* Session is dropped after this much inactivity. */
        session: { idleMinutes: 45 }
    };

})(window);
