/* =============================================================================
 * UYFSR · Shared utilities
 * ========================================================================== */
(function (global) {
    'use strict';

    var App = global.App = global.App || {};
    var DAY_MS = 86400000;

    var U = {

        DAY_MS: DAY_MS,
        HOUR_MS: 3600000,

        /* ---- strings --------------------------------------------------- */

        escapeHtml: function (str) {
            return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
            });
        },

        /* Collapse whitespace and trim — names typed by humans are messy. */
        cleanName: function (str) {
            return String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
        },

        titleCase: function (str) {
            return String(str || '').replace(/\b\w/g, function (m) { return m.toUpperCase(); });
        },

        initials: function (name) {
            var parts = U.cleanName(name).split(' ').filter(Boolean);
            if (!parts.length) return '?';
            if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
            return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
        },

        /* Deterministic hue from a name, so every designer keeps one colour. */
        hueFor: function (name) {
            var h = 0, s = String(name || '');
            for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
            return h;
        },

        bytesOf: function (str) {
            /* Close enough for base64 payloads and far cheaper than Blob(). */
            return str ? Math.ceil(String(str).length * 0.75) : 0;
        },

        formatBytes: function (n) {
            if (!n) return '0 KB';
            if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
            return (n / (1024 * 1024)).toFixed(1) + ' MB';
        },

        /* ---- dates ------------------------------------------------------ */

        parseISODate: function (iso) {
            var p = String(iso).split('-').map(Number);
            return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
        },

        startOfDay: function (d) {
            var x = new Date(d);
            x.setHours(0, 0, 0, 0);
            return x;
        },

        addDays: function (d, n) {
            var x = new Date(d);
            x.setDate(x.getDate() + n);
            return x;
        },

        /* DST-safe whole-day difference between two local midnights. */
        daysBetween: function (a, b) {
            return Math.round((U.startOfDay(b) - U.startOfDay(a)) / DAY_MS);
        },

        sameDay: function (a, b) {
            return a.getFullYear() === b.getFullYear() &&
                a.getMonth() === b.getMonth() &&
                a.getDate() === b.getDate();
        },

        dayName: function (d, style) {
            return d.toLocaleDateString('en-US', { weekday: style || 'long' });
        },

        formatDate: function (d, opts) {
            return d.toLocaleDateString('en-US', opts || { month: 'short', day: 'numeric', year: 'numeric' });
        },

        formatMonth: function (d) {
            return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
        },

        formatTime: function (d) {
            return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        },

        formatDateTime: function (d) {
            if (!d) return '—';
            var x = d instanceof Date ? d : new Date(d);
            if (isNaN(x)) return '—';
            return U.formatDate(x) + ' · ' + U.formatTime(x);
        },

        /* "in 3d 4h" / "2h 10m left" / "4h ago" — human, not robotic. */
        formatDelta: function (ms) {
            var past = ms < 0;
            var s = Math.abs(ms) / 1000;
            var d = Math.floor(s / 86400);
            var h = Math.floor((s % 86400) / 3600);
            var m = Math.floor((s % 3600) / 60);
            var out;
            if (d >= 1) out = d + 'd ' + h + 'h';
            else if (h >= 1) out = h + 'h ' + m + 'm';
            else out = Math.max(m, 0) + 'm';
            return past ? out + ' ago' : out;
        },

        relativeDay: function (date, now) {
            var diff = U.daysBetween(now, date);
            if (diff === 0) return 'Today';
            if (diff === 1) return 'Tomorrow';
            if (diff === -1) return 'Yesterday';
            if (diff > 1 && diff <= 6) return 'In ' + diff + ' days';
            if (diff < -1 && diff >= -6) return Math.abs(diff) + ' days ago';
            return null;
        },

        /* ---- misc ------------------------------------------------------- */

        clamp: function (n, min, max) { return Math.min(max, Math.max(min, n)); },

        /* Positive modulo — JS % goes negative and quietly breaks rotations. */
        mod: function (n, m) { return ((n % m) + m) % m; },

        debounce: function (fn, wait) {
            var t;
            return function () {
                var args = arguments, self = this;
                clearTimeout(t);
                t = setTimeout(function () { fn.apply(self, args); }, wait);
            };
        },

        uid: function () {
            return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        },

        sha256Hex: function (text) {
            var subtle = global.crypto && (global.crypto.subtle || global.crypto.webkitSubtle);
            if (!subtle) return Promise.reject(new Error('WebCrypto unavailable'));
            return subtle.digest('SHA-256', new TextEncoder().encode(text)).then(function (buf) {
                return Array.prototype.map.call(new Uint8Array(buf), function (b) {
                    return b.toString(16).padStart(2, '0');
                }).join('');
            });
        },

        /* Constant-time-ish compare. Overkill here, but free. */
        safeEqual: function (a, b) {
            a = String(a); b = String(b);
            if (a.length !== b.length) return false;
            var out = 0;
            for (var i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
            return out === 0;
        },

        downloadBlob: function (data, filename, mime) {
            var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/json' });
            var url = URL.createObjectURL(blob);
            U.downloadUrl(url, filename);
            setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
        },

        downloadUrl: function (url, filename) {
            var a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.rel = 'noopener';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        },

        readFileAsText: function (file) {
            return new Promise(function (resolve, reject) {
                var r = new FileReader();
                r.onload = function (e) { resolve(e.target.result); };
                r.onerror = reject;
                r.readAsText(file);
            });
        },

        csvCell: function (v) {
            var s = String(v == null ? '' : v);
            return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
        },

        /* lucide is loaded from a CDN — never assume it arrived. */
        icons: function () {
            if (global.lucide && typeof global.lucide.createIcons === 'function') {
                try { global.lucide.createIcons(); } catch (e) { /* ignore */ }
            }
        }
    };

    App.util = U;

})(window);
