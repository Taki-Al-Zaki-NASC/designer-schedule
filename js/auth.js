/* =============================================================================
 * UYFSR · Session / access control
 * -----------------------------------------------------------------------------
 * HONEST SCOPE: this gates the *interface*, not the database. Anyone who reads
 * the page source can see which accounts exist, and anyone with the Firebase
 * URL can write unless database.rules.json is deployed. Passwords are stored as
 * salted SHA-256 so plaintext is not sitting in the file, and the session
 * expires on idle — but the real lock is on the server. See SETUP.md.
 * ========================================================================== */
(function (global) {
    'use strict';

    var App = global.App = global.App || {};
    var U = App.util;
    var CFG = global.APP_CONFIG;
    var STORAGE_KEY = 'uyfsr.session.v2';
    var LOCKOUT_KEY = 'uyfsr.lockout.v2';
    var MAX_ATTEMPTS = 5;
    var LOCKOUT_MS = 5 * 60000;

    var Auth = {

        user: null,
        _subs: [],
        _idleTimer: null,

        subscribe: function (fn) {
            Auth._subs.push(fn);
            return function () {
                var i = Auth._subs.indexOf(fn);
                if (i > -1) Auth._subs.splice(i, 1);
            };
        },

        emit: function () {
            Auth._subs.forEach(function (fn) {
                try { fn(Auth.user); } catch (e) { console.error(e); }
            });
        },

        isOwner: function () { return !!Auth.user && Auth.user.role === 'owner'; },
        isStaff: function () { return !!Auth.user; },
        actorName: function () { return Auth.user ? Auth.user.username : 'guest'; },

        /* ---- lockout ------------------------------------------------------- */

        lockoutState: function () {
            try {
                var raw = JSON.parse(sessionStorage.getItem(LOCKOUT_KEY) || '{}');
                if (raw.until && raw.until > Date.now()) {
                    return { locked: true, remainingMs: raw.until - Date.now(), attempts: raw.attempts || 0 };
                }
                return { locked: false, attempts: raw.attempts || 0 };
            } catch (e) { return { locked: false, attempts: 0 }; }
        },

        registerFailure: function () {
            var s = Auth.lockoutState();
            var attempts = s.attempts + 1;
            var payload = { attempts: attempts };
            if (attempts >= MAX_ATTEMPTS) {
                payload.until = Date.now() + LOCKOUT_MS;
                payload.attempts = 0;
            }
            sessionStorage.setItem(LOCKOUT_KEY, JSON.stringify(payload));
            return payload.until ? MAX_ATTEMPTS - attempts : MAX_ATTEMPTS - attempts;
        },

        clearFailures: function () { sessionStorage.removeItem(LOCKOUT_KEY); },

        /* ---- login --------------------------------------------------------- */

        login: function (username, password) {
            var lock = Auth.lockoutState();
            if (lock.locked) {
                return Promise.reject(new Error(
                    'Too many failed attempts. Try again in ' + Math.ceil(lock.remainingMs / 60000) + ' minute(s).'));
            }

            var key = U.cleanName(username).toLowerCase();
            var account = CFG.accounts[key];

            return U.sha256Hex('UYFSR|' + key + '|' + password)
                .catch(function () {
                    throw new Error('This browser blocks the crypto API needed to sign in. Use HTTPS or localhost.');
                })
                .then(function (hash) {
                    /* Always hash, even for unknown users, so timing does not
                     * reveal which usernames exist. */
                    if (!account || !U.safeEqual(hash, account.hash)) {
                        var left = Auth.registerFailure();
                        throw new Error(left > 0
                            ? 'Incorrect username or password. ' + left + ' attempt(s) left.'
                            : 'Too many failed attempts. Locked for 5 minutes.');
                    }
                    Auth.clearFailures();
                    Auth.user = {
                        username: key,
                        display: account.display || U.titleCase(key),
                        role: account.role,
                        since: Date.now()
                    };
                    Auth.persist();
                    Auth.armIdleTimer();
                    Auth.emit();
                    return Auth.user;
                });
        },

        logout: function (silent) {
            var was = Auth.user;
            Auth.user = null;
            sessionStorage.removeItem(STORAGE_KEY);
            clearTimeout(Auth._idleTimer);
            Auth.emit();
            return was && !silent ? was : null;
        },

        /* ---- session persistence ------------------------------------------- */

        persist: function () {
            try {
                sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
                    username: Auth.user.username,
                    role: Auth.user.role,
                    display: Auth.user.display,
                    since: Auth.user.since,
                    touched: Date.now()
                }));
            } catch (e) { /* ignore */ }
        },

        restore: function () {
            try {
                var raw = sessionStorage.getItem(STORAGE_KEY);
                if (!raw) return null;
                var s = JSON.parse(raw);
                var account = CFG.accounts[s.username];
                if (!account || account.role !== s.role) { sessionStorage.removeItem(STORAGE_KEY); return null; }
                if (Date.now() - (s.touched || 0) > CFG.session.idleMinutes * 60000) {
                    sessionStorage.removeItem(STORAGE_KEY);
                    return null;
                }
                Auth.user = { username: s.username, display: s.display, role: s.role, since: s.since };
                Auth.armIdleTimer();
                Auth.emit();
                return Auth.user;
            } catch (e) { return null; }
        },

        /* Idle expiry — a shared laptop should not stay logged in as owner. */
        armIdleTimer: function () {
            clearTimeout(Auth._idleTimer);
            if (!Auth.user) return;
            Auth._idleTimer = setTimeout(function () {
                if (!Auth.user) return;
                Auth.logout(true);
                if (App.ui) App.ui.toast('Signed out after ' + CFG.session.idleMinutes + ' minutes of inactivity.', 'info');
            }, CFG.session.idleMinutes * 60000);
        },

        touch: function () {
            if (!Auth.user) return;
            Auth.persist();
            Auth.armIdleTimer();
        }
    };

    ['click', 'keydown'].forEach(function (evt) {
        document.addEventListener(evt, U.debounce(function () { Auth.touch(); }, 20000), true);
    });

    App.auth = Auth;

})(window);
