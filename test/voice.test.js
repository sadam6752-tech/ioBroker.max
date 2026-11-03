'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {
    describeAttachments,
    findVoiceAttachment,
    voiceExtension,
    voiceFileName,
    pruneVoiceDir,
    downloadVoice,
} = require('../lib/voice');

describe('lib/voice', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iobroker-max-voice-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('findVoiceAttachment', () => {
        it('finds an audio attachment', () => {
            const body = { attachments: [{ type: 'audio', payload: { url: 'https://x/a.ogg', token: 't' } }] };
            assert.deepEqual(findVoiceAttachment(body), { type: 'audio', url: 'https://x/a.ogg' });
        });

        it('accepts a type "voice" as well', () => {
            const body = { attachments: [{ type: 'voice', payload: { url: 'https://x/v' } }] };
            assert.equal(findVoiceAttachment(body).type, 'voice');
        });

        it('ignores other attachments and audio without a URL', () => {
            assert.equal(findVoiceAttachment({ attachments: [{ type: 'image', payload: { url: 'https://x/i.jpg' } }] }), null);
            assert.equal(findVoiceAttachment({ attachments: [{ type: 'audio', payload: { token: 't' } }] }), null);
            assert.equal(findVoiceAttachment({ attachments: [{ type: 'audio', payload: { url: 'ftp://x/a' } }] }), null);
            assert.equal(findVoiceAttachment({}), null);
            assert.equal(findVoiceAttachment(undefined), null);
        });

        it('takes the first voice attachment', () => {
            const body = {
                attachments: [
                    { type: 'image', payload: { url: 'https://x/i.jpg' } },
                    { type: 'audio', payload: { url: 'https://x/1.ogg' } },
                    { type: 'audio', payload: { url: 'https://x/2.ogg' } },
                ],
            };
            assert.equal(findVoiceAttachment(body).url, 'https://x/1.ogg');
        });
    });

    describe('describeAttachments', () => {
        it('lists types and keys without URLs', () => {
            const text = describeAttachments([
                { type: 'audio', payload: { url: 'https://secret.example/a?sig=abc', token: 'tok' } },
                { type: 'file', payload: { url: 'https://x' }, filename: 'a.pdf', size: 3 },
            ]);
            assert.equal(text, 'audio{payload:url,token}, file{payload:url;filename,size}');
            assert.equal(text.includes('secret'), false);
        });

        it('reports no attachments', () => {
            assert.equal(describeAttachments(undefined), 'none');
            assert.equal(describeAttachments([]), 'none');
        });
    });

    describe('voiceExtension', () => {
        it('uses the content type', () => {
            assert.equal(voiceExtension('audio/ogg; codecs=opus', 'https://x/a'), '.ogg');
            assert.equal(voiceExtension('audio/mpeg', 'https://x/a'), '.mp3');
            assert.equal(voiceExtension('audio/mp4', 'https://x/a'), '.m4a');
            assert.equal(voiceExtension('audio/aac', 'https://x/a'), '.aac');
        });

        it('falls back to the URL', () => {
            assert.equal(voiceExtension('application/octet-stream', 'https://x/a/voice.m4a?sig=1'), '.m4a');
            assert.equal(voiceExtension(null, 'https://x/a/voice.opus'), '.ogg');
        });

        it('defaults to .ogg', () => {
            assert.equal(voiceExtension('application/octet-stream', 'https://x/a/voice'), '.ogg');
            assert.equal(voiceExtension(undefined, 'not a url'), '.ogg');
        });
    });

    describe('voiceFileName', () => {
        it('keeps safe characters of the message id', () => {
            assert.equal(voiceFileName('mid.0000ab12_cd-ef'), 'mid.0000ab12_cd-ef');
        });

        it('replaces path characters', () => {
            assert.equal(voiceFileName('../../etc/passwd'), '_.._etc_passwd');
            assert.equal(voiceFileName('a/b\\c:d'), 'a_b_c_d');
        });

        it('creates a name without a message id', () => {
            assert.match(voiceFileName(''), /^voice_\d+$/);
        });
    });

    describe('pruneVoiceDir', () => {
        it('keeps the newest files only', async () => {
            for (let i = 0; i < 5; i++) {
                const file = path.join(tmpDir, `f${i}.ogg`);
                fs.writeFileSync(file, 'x');
                const t = new Date(Date.now() - (5 - i) * 60000);
                fs.utimesSync(file, t, t);
            }
            assert.equal(await pruneVoiceDir(tmpDir, 2), 3);
            assert.deepEqual(fs.readdirSync(tmpDir).sort(), ['f3.ogg', 'f4.ogg']);
        });

        it('does nothing for a missing folder', async () => {
            assert.equal(await pruneVoiceDir(path.join(tmpDir, 'missing')), 0);
        });
    });

    describe('downloadVoice', () => {
        let server;
        let base;

        before(async () => {
            server = http.createServer((req, res) => {
                if (req.url === '/voice') {
                    res.writeHead(200, { 'content-type': 'audio/ogg' });
                    res.end(Buffer.from('OggS-test'));
                } else if (req.url === '/empty') {
                    res.writeHead(200, { 'content-type': 'audio/ogg' });
                    res.end();
                } else {
                    res.writeHead(404);
                    res.end();
                }
            });
            await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
            base = `http://127.0.0.1:${server.address().port}`;
        });

        after(() => server.close());

        it('writes the file into the folder, named after the message id', async () => {
            const dir = path.join(tmpDir, 'max_0', 'voice');
            const file = await downloadVoice(fetch, `${base}/voice`, dir, 'mid.123');
            assert.equal(file, path.join(dir, 'mid.123.ogg'));
            assert.equal(fs.readFileSync(file, 'utf8'), 'OggS-test');
        });

        it('reports HTTP errors and empty files', async () => {
            await assert.rejects(() => downloadVoice(fetch, `${base}/missing`, tmpDir, 'm'), /HTTP 404/);
            await assert.rejects(() => downloadVoice(fetch, `${base}/empty`, tmpDir, 'm'), /empty/);
        });
    });
});
