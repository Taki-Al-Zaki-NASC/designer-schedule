/* =============================================================================
 * UYFSR · Image pipeline
 * -----------------------------------------------------------------------------
 * v1 claimed to "optimize" uploads but drew the image onto a canvas at its
 * original dimensions, so a 12 MP phone photo went into the Realtime Database
 * almost untouched as base64. This actually downscales, re-encodes, and refuses
 * anything that would still be too large to store safely.
 * ========================================================================== */
(function (global) {
    'use strict';

    var App = global.App = global.App || {};
    var U = App.util;
    var CFG = global.APP_CONFIG.posters;

    var ACCEPTED = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

    var Images = {

        accept: ACCEPTED.join(','),

        isAccepted: function (file) {
            return !!file && ACCEPTED.indexOf((file.type || '').toLowerCase()) !== -1;
        },

        loadImage: function (file) {
            return new Promise(function (resolve, reject) {
                var reader = new FileReader();
                reader.onload = function (e) {
                    var img = new Image();
                    img.onload = function () { resolve(img); };
                    img.onerror = function () { reject(new Error('"' + file.name + '" could not be read as an image.')); };
                    img.src = e.target.result;
                };
                reader.onerror = function () { reject(new Error('Could not read "' + file.name + '".')); };
                reader.readAsDataURL(file);
            });
        },

        /*
         * Downscale to maxEdgePx, then step the JPEG quality down until the
         * encoded string fits the per-image budget. Returns a data URL.
         */
        process: function (file) {
            if (!Images.isAccepted(file)) {
                return Promise.reject(new Error('"' + file.name + '" is not a PNG, JPG or WebP.'));
            }

            return Images.loadImage(file).then(function (img) {
                var w = img.naturalWidth || img.width;
                var h = img.naturalHeight || img.height;
                if (!w || !h) throw new Error('"' + file.name + '" has no readable dimensions.');

                var scale = Math.min(1, CFG.maxEdgePx / Math.max(w, h));
                var canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.round(w * scale));
                canvas.height = Math.max(1, Math.round(h * scale));

                var ctx = canvas.getContext('2d');
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                /* Flatten transparency onto white so PNG logos do not turn
                 * black once they are re-encoded as JPEG. */
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                var quality = CFG.jpegQuality;
                var out = canvas.toDataURL('image/jpeg', quality);

                while (U.bytesOf(out) > CFG.maxBytesPerImage && quality > 0.4) {
                    quality -= 0.1;
                    out = canvas.toDataURL('image/jpeg', quality);
                }

                if (U.bytesOf(out) > CFG.maxBytesPerImage) {
                    throw new Error('"' + file.name + '" is still ' + U.formatBytes(U.bytesOf(out)) +
                        ' after compression (limit ' + U.formatBytes(CFG.maxBytesPerImage) +
                        '). Export it smaller and try again.');
                }

                return {
                    dataUrl: out,
                    bytes: U.bytesOf(out),
                    width: canvas.width,
                    height: canvas.height,
                    originalBytes: file.size,
                    name: file.name
                };
            });
        },

        processAll: function (files, onProgress) {
            var results = [];
            return files.reduce(function (chain, file, i) {
                return chain.then(function () {
                    if (onProgress) onProgress(i, files.length, file.name);
                    return Images.process(file).then(function (r) { results.push(r); });
                });
            }, Promise.resolve()).then(function () { return results; });
        },

        /* Open a native file picker and hand back the chosen File objects. */
        pick: function (multiple) {
            return new Promise(function (resolve) {
                var input = document.createElement('input');
                input.type = 'file';
                input.accept = Images.accept;
                input.multiple = multiple !== false;
                input.style.display = 'none';
                document.body.appendChild(input);
                input.onchange = function (e) {
                    var files = Array.prototype.slice.call(e.target.files || []);
                    document.body.removeChild(input);
                    resolve(files);
                };
                input.click();
            });
        }
    };

    App.images = Images;

})(window);
