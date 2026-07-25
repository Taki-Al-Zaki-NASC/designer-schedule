/* =============================================================================
 * UYFSR · UI primitives — toasts, dialogs, sheets, lightbox
 * -----------------------------------------------------------------------------
 * All dialogs are promise-based, focus-trapped, and closable with Escape.
 * ========================================================================== */
(function (global) {
    'use strict';

    var App = global.App = global.App || {};
    var U = App.util;

    var openStack = [];

    var UI = {

        /* ---- toasts ------------------------------------------------------- */

        toast: function (message, type, opts) {
            opts = opts || {};
            var stack = document.getElementById('toastStack');
            if (!stack) return;
            type = type || 'info';

            var icon = { success: 'check-circle-2', error: 'alert-circle', warn: 'alert-triangle', info: 'info' }[type] || 'info';
            var el = document.createElement('div');
            el.className = 'toast toast--' + type;
            el.setAttribute('role', type === 'error' ? 'alert' : 'status');
            el.innerHTML =
                '<i data-lucide="' + icon + '"></i>' +
                '<div class="toast__body">' +
                (opts.title ? '<strong>' + U.escapeHtml(opts.title) + '</strong>' : '') +
                '<span>' + U.escapeHtml(message) + '</span>' +
                '</div>' +
                '<button class="toast__close" aria-label="Dismiss"><i data-lucide="x"></i></button>';

            stack.appendChild(el);
            U.icons();

            var timer = setTimeout(dismiss, opts.duration || (type === 'error' ? 6500 : 3600));
            el.querySelector('.toast__close').addEventListener('click', function () {
                clearTimeout(timer); dismiss();
            });

            function dismiss() {
                el.classList.add('is-leaving');
                setTimeout(function () { el.remove(); }, 200);
            }
            return dismiss;
        },

        /* ---- generic dialog ------------------------------------------------ */

        /*
         * fields: [{ name, label, type, value, placeholder, hint, required,
         *            maxlength, options:[{value,label}], rows }]
         * Resolves with a values object, or null when cancelled.
         */
        dialog: function (cfg) {
            return new Promise(function (resolve) {
                var overlay = document.createElement('div');
                overlay.className = 'overlay';
                var tone = cfg.tone || 'brand';

                var fieldsHtml = (cfg.fields || []).map(function (f) {
                    var id = 'fld_' + f.name;
                    var common = 'id="' + id + '" name="' + f.name + '"' +
                        (f.placeholder ? ' placeholder="' + U.escapeHtml(f.placeholder) + '"' : '') +
                        (f.maxlength ? ' maxlength="' + f.maxlength + '"' : '') +
                        (f.required ? ' required' : '');
                    var input;
                    if (f.type === 'textarea') {
                        input = '<textarea class="field__input" rows="' + (f.rows || 3) + '" ' + common + '>' +
                            U.escapeHtml(f.value || '') + '</textarea>';
                    } else if (f.type === 'select') {
                        input = '<select class="field__input" ' + common + '>' +
                            (f.options || []).map(function (o) {
                                return '<option value="' + U.escapeHtml(o.value) + '"' +
                                    (String(o.value) === String(f.value) ? ' selected' : '') + '>' +
                                    U.escapeHtml(o.label) + '</option>';
                            }).join('') + '</select>';
                    } else if (f.type === 'checkbox') {
                        return '<label class="field field--check"><input type="checkbox" ' + common +
                            (f.value ? ' checked' : '') + ' /><span>' + U.escapeHtml(f.label) + '</span>' +
                            (f.hint ? '<small class="field__hint">' + U.escapeHtml(f.hint) + '</small>' : '') + '</label>';
                    } else {
                        input = '<input class="field__input" type="' + (f.type || 'text') + '" ' + common +
                            ' value="' + U.escapeHtml(f.value || '') + '" />';
                    }
                    return '<div class="field">' +
                        '<label class="field__label" for="' + id + '">' + U.escapeHtml(f.label) + '</label>' +
                        input +
                        (f.hint ? '<small class="field__hint">' + U.escapeHtml(f.hint) + '</small>' : '') +
                        '</div>';
                }).join('');

                overlay.innerHTML =
                    '<div class="dialog dialog--' + tone + (cfg.wide ? ' dialog--wide' : '') + '" role="dialog" aria-modal="true" aria-label="' + U.escapeHtml(cfg.title || 'Dialog') + '">' +
                    '<div class="dialog__head">' +
                    '<span class="dialog__icon dialog__icon--' + tone + '"><i data-lucide="' + (cfg.icon || 'circle-help') + '"></i></span>' +
                    '<div>' +
                    '<h2 class="dialog__title">' + U.escapeHtml(cfg.title || '') + '</h2>' +
                    (cfg.subtitle ? '<p class="dialog__subtitle">' + U.escapeHtml(cfg.subtitle) + '</p>' : '') +
                    '</div>' +
                    '<button class="dialog__close" data-act="cancel" aria-label="Close"><i data-lucide="x"></i></button>' +
                    '</div>' +
                    (cfg.body ? '<div class="dialog__body">' + cfg.body + '</div>' : '') +
                    (fieldsHtml ? '<div class="dialog__fields">' + fieldsHtml + '</div>' : '') +
                    '<div class="dialog__error" hidden></div>' +
                    '<div class="dialog__actions">' +
                    (cfg.cancelLabel === null ? '' :
                        '<button class="btn btn--ghost" data-act="cancel">' + U.escapeHtml(cfg.cancelLabel || 'Cancel') + '</button>') +
                    '<button class="btn btn--' + tone + '" data-act="confirm">' +
                    U.escapeHtml(cfg.confirmLabel || 'Confirm') + '</button>' +
                    '</div>' +
                    '</div>';

                document.body.appendChild(overlay);
                document.body.classList.add('is-locked');
                openStack.push({ overlay: overlay, close: close });
                U.icons();

                requestAnimationFrame(function () {
                    overlay.classList.add('is-open');
                    var first = overlay.querySelector('.field__input, [data-act="confirm"]');
                    if (first) first.focus();
                });

                var errorBox = overlay.querySelector('.dialog__error');

                function collect() {
                    var out = {};
                    (cfg.fields || []).forEach(function (f) {
                        var el = overlay.querySelector('#fld_' + f.name);
                        if (!el) return;
                        out[f.name] = f.type === 'checkbox' ? el.checked : el.value;
                    });
                    return out;
                }

                function fail(msg) {
                    errorBox.textContent = msg;
                    errorBox.hidden = false;
                }

                function submit() {
                    var values = collect();
                    var missing = (cfg.fields || []).find(function (f) {
                        return f.required && !String(values[f.name] || '').trim();
                    });
                    if (missing) return fail(missing.label + ' is required.');
                    if (cfg.validate) {
                        var err = cfg.validate(values);
                        if (err) return fail(err);
                    }
                    close();
                    resolve(values);
                }

                function close() {
                    overlay.classList.remove('is-open');
                    document.removeEventListener('keydown', onKey, true);
                    setTimeout(function () {
                        overlay.remove();
                        openStack = openStack.filter(function (x) { return x.overlay !== overlay; });
                        if (!openStack.length) document.body.classList.remove('is-locked');
                    }, 160);
                }

                function onKey(e) {
                    if (openStack[openStack.length - 1] && openStack[openStack.length - 1].overlay !== overlay) return;
                    if (e.key === 'Escape') { e.preventDefault(); close(); resolve(null); }
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
                    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { e.preventDefault(); submit(); }
                    if (e.key === 'Tab') trapFocus(e, overlay);
                }

                overlay.addEventListener('click', function (e) {
                    var act = e.target.closest('[data-act]');
                    if (act) {
                        if (act.dataset.act === 'cancel') { close(); resolve(null); }
                        else submit();
                        return;
                    }
                    if (e.target === overlay) { close(); resolve(null); }
                });

                document.addEventListener('keydown', onKey, true);
            });
        },

        confirm: function (cfg) {
            return UI.dialog({
                title: cfg.title || 'Are you sure?',
                subtitle: cfg.subtitle,
                body: cfg.body,
                icon: cfg.icon || 'alert-triangle',
                tone: cfg.tone || 'danger',
                confirmLabel: cfg.confirmLabel || 'Confirm',
                cancelLabel: cfg.cancelLabel || 'Cancel'
            }).then(function (r) { return r !== null; });
        },

        prompt: function (cfg) {
            return UI.dialog({
                title: cfg.title,
                subtitle: cfg.subtitle,
                icon: cfg.icon || 'pencil-line',
                tone: cfg.tone || 'brand',
                confirmLabel: cfg.confirmLabel || 'Save',
                fields: cfg.fields,
                validate: cfg.validate,
                body: cfg.body
            });
        },

        /* ---- blocking progress -------------------------------------------- */

        busy: function (title, subtitle) {
            var el = document.getElementById('busyOverlay');
            el.querySelector('.busy__title').textContent = title || 'Working…';
            el.querySelector('.busy__subtitle').textContent = subtitle || '';
            el.classList.add('is-open');
            document.body.classList.add('is-locked');
            return {
                update: function (t, s) {
                    if (t) el.querySelector('.busy__title').textContent = t;
                    if (s !== undefined) el.querySelector('.busy__subtitle').textContent = s;
                },
                done: function () {
                    el.classList.remove('is-open');
                    if (!openStack.length) document.body.classList.remove('is-locked');
                }
            };
        },

        /* ---- lightbox ------------------------------------------------------ */

        lightbox: function (urls, startIndex, caption) {
            var i = startIndex || 0;
            var overlay = document.createElement('div');
            overlay.className = 'overlay overlay--dark';
            overlay.innerHTML =
                '<div class="lightbox" role="dialog" aria-modal="true" aria-label="Poster preview">' +
                '<div class="lightbox__bar">' +
                '<span class="lightbox__caption"></span>' +
                '<div class="lightbox__tools">' +
                '<a class="btn btn--ghost btn--sm" data-act="download" download><i data-lucide="download"></i> Download</a>' +
                '<button class="btn btn--ghost btn--sm" data-act="close" aria-label="Close"><i data-lucide="x"></i></button>' +
                '</div></div>' +
                '<div class="lightbox__stage">' +
                '<button class="lightbox__nav lightbox__nav--prev" data-act="prev" aria-label="Previous"><i data-lucide="chevron-left"></i></button>' +
                '<img class="lightbox__img" alt="Poster preview" />' +
                '<button class="lightbox__nav lightbox__nav--next" data-act="next" aria-label="Next"><i data-lucide="chevron-right"></i></button>' +
                '</div></div>';

            document.body.appendChild(overlay);
            document.body.classList.add('is-locked');
            openStack.push({ overlay: overlay, close: close });
            U.icons();
            requestAnimationFrame(function () { overlay.classList.add('is-open'); });
            paint();

            function paint() {
                overlay.querySelector('.lightbox__img').src = urls[i];
                overlay.querySelector('.lightbox__caption').textContent =
                    (caption ? caption + ' · ' : '') + 'Poster ' + (i + 1) + ' of ' + urls.length;
                var dl = overlay.querySelector('[data-act="download"]');
                dl.href = urls[i];
                dl.download = 'poster-' + (caption || 'uyfsr').replace(/\s+/g, '-').toLowerCase() + '-' + (i + 1) + '.jpg';
                overlay.querySelectorAll('.lightbox__nav').forEach(function (b) {
                    b.style.visibility = urls.length > 1 ? 'visible' : 'hidden';
                });
            }

            function close() {
                overlay.classList.remove('is-open');
                document.removeEventListener('keydown', onKey, true);
                setTimeout(function () {
                    overlay.remove();
                    openStack = openStack.filter(function (x) { return x.overlay !== overlay; });
                    if (!openStack.length) document.body.classList.remove('is-locked');
                }, 160);
            }

            function step(n) { i = U.mod(i + n, urls.length); paint(); }

            function onKey(e) {
                if (e.key === 'Escape') close();
                if (e.key === 'ArrowRight') step(1);
                if (e.key === 'ArrowLeft') step(-1);
            }

            overlay.addEventListener('click', function (e) {
                var act = e.target.closest('[data-act]');
                if (!act) { if (e.target === overlay) close(); return; }
                if (act.dataset.act === 'close') close();
                if (act.dataset.act === 'next') step(1);
                if (act.dataset.act === 'prev') step(-1);
            });
            document.addEventListener('keydown', onKey, true);
        }
    };

    function trapFocus(e, root) {
        var nodes = root.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (!nodes.length) return;
        var first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    App.ui = UI;

})(window);
