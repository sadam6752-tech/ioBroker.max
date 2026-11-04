'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
    KEEP_PHOTOS,
    findPhotoAttachments,
    sniffExtension,
    photoExtension,
    photoFileName,
    prunePhotoDir,
    downloadPhoto,
} = require('../lib/photo');

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
const GIF = Buffer.from('GIF89a....', 'latin1');
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1');

/**
 * @param {number} status - HTTP status
 * @param {Buffer} body - response body
 * @param {Record<string, string>} [headers] - response headers
 * @returns {object} minimal fetch response
 */
function response(status, body, headers = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => headers[name.toLowerCase()] ?? null },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
    };
}

describe('lib/photo', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iobroker-max-photo-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('findPhotoAttachments', () => {
        it('finds every image attachment in order', () => {
            const body = {
                attachments: [
                    { type: 'image', payload: { photo_id: 1, url: 'https://x/1', token: 't' } },
                    { type: 'audio', payload: { url: 'https://x/a.ogg' } },
                    { type: 'image', payload: { photo_id: 2, url: 'https://x/2' } },
                    { type: 'inline_keyboard', payload: { buttons: [] } },
                ],
            };
            assert.deepEqual(findPhotoAttachments(body), [
                { type: 'image', url: 'https://x/1' },
                { type: 'image', url: 'https://x/2' },
            ]);
        });

        it('skips attachments without a http(s) URL', () => {
            assert.deepEqual(findPhotoAttachments({ attachments: [{ type: 'image', payload: { token: 't' } }] }), []);
            assert.deepEqual(findPhotoAttachments({ attachments: [{ type: 'image', payload: { url: 'file:///etc/passwd' } }] }), []);
            assert.deepEqual(findPhotoAttachments({}), []);
            assert.deepEqual(findPhotoAttachments(undefined), []);
        });
    });

    describe('photoExtension', () => {
        it('uses the content type', () => {
            assert.equal(photoExtension('image/jpeg', PNG, 'https://x/a'), '.jpg');
            assert.equal(photoExtension('image/png; charset=binary', JPEG, 'https://x/a'), '.png');
            assert.equal(photoExtension('image/webp', JPEG, 'https://x/a'), '.webp');
            assert.equal(photoExtension('image/gif', JPEG, 'https://x/a'), '.gif');
        });

        it('falls back to the file content, then to the URL, then to .jpg', () => {
            assert.equal(photoExtension('application/octet-stream', PNG, 'https://x/a.jpg'), '.png');
            assert.equal(photoExtension(null, GIF, 'https://x/a'), '.gif');
            assert.equal(photoExtension(null, WEBP, 'https://x/a'), '.webp');
            assert.equal(photoExtension(null, Buffer.from('????'), 'https://x/a/photo.JPEG?x=1'), '.jpg');
            assert.equal(photoExtension(null, Buffer.from('????'), 'https://x/a/p.webp'), '.webp');
            assert.equal(photoExtension(null, Buffer.from('????'), 'not a url'), '.jpg');
        });

        it('recognises the image types by their first bytes', () => {
            assert.equal(sniffExtension(JPEG), '.jpg');
            assert.equal(sniffExtension(PNG), '.png');
            assert.equal(sniffExtension(GIF), '.gif');
            assert.equal(sniffExtension(WEBP), '.webp');
            assert.equal(sniffExtension(Buffer.from('OggS')), null);
        });
    });

    describe('photoFileName', () => {
        it('numbers several photos of one message', () => {
            assert.equal(photoFileName('mid.abc', 1, 1), 'mid.abc');
            assert.equal(photoFileName('mid.abc', 1, 3), 'mid.abc_1');
            assert.equal(photoFileName('mid.abc', 3, 3), 'mid.abc_3');
        });

        it('keeps only characters that are safe in a file name', () => {
            assert.equal(photoFileName('../a/b', 1, 1), '_a_b');
        });
    });

    describe('prunePhotoDir', () => {
        it('keeps 50 files by default', async () => {
            assert.equal(KEEP_PHOTOS, 50);
            for (let i = 0; i < 52; i++) {
                const f = path.join(tmpDir, `p${i}.jpg`);
                fs.writeFileSync(f, 'x');
                const t = new Date(Date.now() - i * 1000);
                fs.utimesSync(f, t, t);
            }
            assert.equal(await prunePhotoDir(tmpDir), 2);
            const files = fs.readdirSync(tmpDir);
            assert.equal(files.length, 50);
            assert.ok(!files.includes('p51.jpg') && !files.includes('p50.jpg'));
        });
    });

    describe('downloadPhoto', () => {
        it('writes the file with the extension of its type', async () => {
            const dir = path.join(tmpDir, 'photo');
            const file = await downloadPhoto(async () => response(200, PNG, { 'content-type': 'image/png' }), 'https://x/1', dir, 'mid.1_2');
            assert.equal(path.basename(file), 'mid.1_2.png');
            assert.deepEqual(fs.readFileSync(file), PNG);
        });

        it('rejects failed, empty and too large downloads', async () => {
            await assert.rejects(downloadPhoto(async () => response(403, JPEG), 'https://x/1', tmpDir, 'a'), /HTTP 403/);
            await assert.rejects(downloadPhoto(async () => response(200, Buffer.alloc(0)), 'https://x/1', tmpDir, 'a'), /empty/);
            await assert.rejects(
                downloadPhoto(async () => response(200, JPEG, { 'content-length': String(100 * 1024 * 1024) }), 'https://x/1', tmpDir, 'a'),
                /too large/,
            );
        });
    });
});
