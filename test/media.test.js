'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { collectMedia, isUrl, download, openFile, uploadMedia, MAX_MEDIA_SIZE } = require('../lib/media');
const { createMaxFetch } = require('../lib/max-fetch');

/**
 * Minimal fetch response
 *
 * @param {number} status - HTTP status
 * @param {string | Buffer} body - response body
 * @param {Record<string, string>} [headers] - response headers
 * @returns {object} response like fetch returns it
 */
function response(status, body, headers = {}) {
    const buffer = Buffer.from(body);
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: name => lower[name.toLowerCase()] ?? null },
        arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
        text: async () => buffer.toString('utf8'),
    };
}

/**
 * Fake `bot.api` with the upload endpoint
 *
 * @param {object} uploadInfo - answer of getUploadUrl
 * @returns {object} api
 */
function createApi(uploadInfo) {
    const api = { requested: [] };
    api.raw = {
        uploads: {
            getUploadUrl: async ({ type }) => {
                api.requested.push(type);
                return uploadInfo;
            },
        },
    };
    return api;
}

describe('lib/media', () => {
    let tmpDir;
    let imageFile;

    before(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iobroker-max-media-'));
        imageFile = path.join(tmpDir, 'snapshot.jpg');
        fs.writeFileSync(imageFile, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    });

    after(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('collectMedia', () => {
        it('collects all attachment types in a fixed order', () => {
            assert.deepEqual(collectMedia({ file: '/a.pdf', image: ['/b.jpg', ' https://x/c.png '], text: 'hi' }), [
                { type: 'image', source: '/b.jpg' },
                { type: 'image', source: 'https://x/c.png' },
                { type: 'file', source: '/a.pdf' },
            ]);
        });

        it('returns nothing for a request without attachments', () => {
            assert.deepEqual(collectMedia({ text: 'hi', image: '' }), []);
            assert.deepEqual(collectMedia(null), []);
        });

        it('rejects sources that are not strings', () => {
            assert.throws(() => collectMedia({ video: 42 }), /Invalid video/);
            assert.throws(() => collectMedia({ audio: ['  '] }), /Invalid audio/);
        });
    });

    describe('isUrl', () => {
        it('detects http and https URLs only', () => {
            assert.equal(isUrl('https://example.com/a.jpg'), true);
            assert.equal(isUrl('HTTP://cam/snap'), true);
            assert.equal(isUrl('/opt/iobroker/a.jpg'), false);
            assert.equal(isUrl('C:\\pics\\a.jpg'), false);
        });
    });

    describe('openFile', () => {
        it('opens a local file with its name', async () => {
            const { blob, fileName } = await openFile(imageFile);
            assert.equal(fileName, 'snapshot.jpg');
            assert.equal(blob.size, 4);
        });

        it('reports a missing file', async () => {
            await assert.rejects(() => openFile(path.join(tmpDir, 'missing.jpg')), /Cannot read .*ENOENT/);
        });

        it('rejects a directory', async () => {
            await assert.rejects(() => openFile(tmpDir), /is not a file/);
        });
    });

    describe('download', () => {
        it('downloads a URL and keeps its file name and type', async () => {
            const calls = [];
            const fetchFn = async (url, init) => {
                calls.push({ url, init });
                return response(200, 'abc', { 'content-type': 'image/png' });
            };
            const { blob, fileName } = await download('https://example.com/img/cam.png?x=1', fetchFn);
            assert.equal(fileName, 'cam.png');
            assert.equal(blob.type, 'image/png');
            assert.equal(await blob.text(), 'abc');
            assert.equal(calls[0].url, 'https://example.com/img/cam.png?x=1');
        });

        it('sends credentials of the URL as basic auth', async () => {
            let seen;
            const fetchFn = async (url, init) => {
                seen = { url, init };
                return response(200, 'x');
            };
            await download('http://admin:p%40ss@192.168.1.20/snapshot.jpg', fetchFn);
            assert.equal(seen.url, 'http://192.168.1.20/snapshot.jpg');
            assert.equal(seen.init.headers.Authorization, `Basic ${Buffer.from('admin:p@ss').toString('base64')}`);
        });

        it('reports HTTP errors without credentials', async () => {
            const fetchFn = async () => response(404, 'not found');
            await assert.rejects(
                () => download('http://admin:secret@cam/snap.jpg', fetchFn),
                err => /HTTP 404/.test(err.message) && !err.message.includes('secret'),
            );
        });

        it('refuses files above the size limit', async () => {
            const fetchFn = async () => response(200, 'x', { 'content-length': String(MAX_MEDIA_SIZE + 1) });
            await assert.rejects(() => download('https://example.com/big.mp4', fetchFn), /too large/);
        });
    });

    describe('uploadMedia', () => {
        it('uploads an image and returns the photos of the response', async () => {
            const api = createApi({ url: 'https://upload.example/u1' });
            const posted = [];
            const fetchFn = async (url, init) => {
                posted.push({ url, init });
                return response(200, JSON.stringify({ photos: { p1: { token: 'img-token' } } }));
            };
            const attachment = await uploadMedia(api, fetchFn, { type: 'image', source: imageFile });
            assert.deepEqual(attachment, { type: 'image', payload: { photos: { p1: { token: 'img-token' } } } });
            assert.deepEqual(api.requested, ['image']);
            assert.equal(posted[0].url, 'https://upload.example/u1');
            assert.equal(posted[0].init.method, 'POST');
            const data = posted[0].init.body.get('data');
            assert.equal(data.name, 'snapshot.jpg');
            assert.equal(data.size, 4);
        });

        it('uses the token of the upload URL for video and audio', async () => {
            const api = createApi({ url: 'https://upload.example/v', token: 'video-token' });
            const fetchFn = async () => response(200, '<retval>1</retval>');
            const attachment = await uploadMedia(api, fetchFn, { type: 'video', source: imageFile });
            assert.deepEqual(attachment, { type: 'video', payload: { token: 'video-token' } });
        });

        it('uses the token of the response for files', async () => {
            const api = createApi({ url: 'https://upload.example/f' });
            const fetchFn = async () => response(200, JSON.stringify({ token: 'file-token' }));
            const attachment = await uploadMedia(api, fetchFn, { type: 'file', source: imageFile });
            assert.deepEqual(attachment, { type: 'file', payload: { token: 'file-token' } });
        });

        it('downloads a URL before the upload', async () => {
            const api = createApi({ url: 'https://upload.example/u' });
            const urls = [];
            const fetchFn = async url => {
                urls.push(url);
                return url.startsWith('https://upload')
                    ? response(200, JSON.stringify({ photos: { a: { token: 't' } } }))
                    : response(200, 'img', { 'content-type': 'image/jpeg' });
            };
            await uploadMedia(api, fetchFn, { type: 'image', source: 'http://cam/snap.jpg' });
            assert.deepEqual(urls, ['http://cam/snap.jpg', 'https://upload.example/u']);
        });

        it('does not ask for an upload URL when the source cannot be read', async () => {
            const api = createApi({ url: 'https://upload.example/u' });
            await assert.rejects(() => uploadMedia(api, async () => response(200, '{}'), { type: 'image', source: '/nope.jpg' }));
            assert.deepEqual(api.requested, []);
        });

        it('reports a failed upload', async () => {
            const api = createApi({ url: 'https://upload.example/u' });
            const fetchFn = async () => response(413, 'too big');
            await assert.rejects(
                () => uploadMedia(api, fetchFn, { type: 'file', source: imageFile }),
                /Upload of snapshot.jpg failed: HTTP 413 too big/,
            );
        });

        it('reports an upload response without token', async () => {
            const api = createApi({ url: 'https://upload.example/u' });
            const fetchFn = async () => response(200, '{}');
            await assert.rejects(() => uploadMedia(api, fetchFn, { type: 'file', source: imageFile }), /no token/);
        });
    });

    describe('upload over HTTP', () => {
        let server;
        let baseUrl;
        let received;

        before(async () => {
            server = http.createServer((req, res) => {
                const chunks = [];
                req.on('data', chunk => chunks.push(chunk));
                req.on('end', () => {
                    received = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
                    if (req.url === '/camera.jpg') {
                        res.writeHead(200, { 'content-type': 'image/jpeg' });
                        res.end(Buffer.from([1, 2, 3]));
                        return;
                    }
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ token: 'tok' }));
                });
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            baseUrl = `http://127.0.0.1:${server.address().port}`;
        });

        after(() => server.close());

        it('posts the file as multipart form with the adapter fetch', async () => {
            const maxHttp = createMaxFetch();
            try {
                const api = createApi({ url: `${baseUrl}/upload` });
                const attachment = await uploadMedia(api, maxHttp.fetch, { type: 'file', source: imageFile });
                assert.deepEqual(attachment, { type: 'file', payload: { token: 'tok' } });
                assert.match(received.headers['content-type'], /^multipart\/form-data; boundary=/);
                const body = received.body.toString('latin1');
                assert.match(body, /name="data"; filename="snapshot.jpg"/);
                assert.ok(received.body.includes(Buffer.from([0xff, 0xd8, 0xff, 0xd9])));
            } finally {
                await maxHttp.close();
            }
        });

        it('downloads from a server with basic auth', async () => {
            const maxHttp = createMaxFetch();
            try {
                const { blob } = await download(`http://user:pw@127.0.0.1:${server.address().port}/camera.jpg`, maxHttp.fetch);
                assert.equal(received.headers.authorization, `Basic ${Buffer.from('user:pw').toString('base64')}`);
                assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [1, 2, 3]);
            } finally {
                await maxHttp.close();
            }
        });
    });
});
