'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createMaxFetch, describeError, ROOT_CA_FILE } = require('../lib/max-fetch');

describe('lib/max-fetch', () => {
    describe('root CA', () => {
        const cert = new crypto.X509Certificate(fs.readFileSync(ROOT_CA_FILE));

        it('is the Russian Trusted Root CA', () => {
            assert.match(cert.subject, /CN=Russian Trusted Root CA/);
            assert.equal(cert.subject, cert.issuer);
            assert.equal(
                cert.fingerprint256,
                'D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31',
            );
            assert.equal(cert.ca, true);
        });

        it('is still valid', () => {
            assert.ok(new Date(cert.validTo) > new Date());
        });

        it('is part of the npm package', () => {
            const pkg = require('../package.json');
            assert.ok(pkg.files.includes('lib/'));
        });
    });

    describe('createMaxFetch', () => {
        it('returns a fetch function and a close function', async () => {
            const http = createMaxFetch();
            assert.equal(typeof http.fetch, 'function');
            await http.close();
        });

        it('does not change the global fetch', async () => {
            const before = globalThis.fetch;
            const http = createMaxFetch();
            assert.equal(globalThis.fetch, before);
            await http.close();
        });
    });

    describe('describeError', () => {
        it('adds the code and message of the cause', () => {
            const err = new TypeError('fetch failed', {
                cause: Object.assign(new Error('unable to get local issuer certificate'), {
                    code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
                }),
            });
            assert.equal(
                describeError(err),
                'fetch failed (UNABLE_TO_GET_ISSUER_CERT_LOCALLY: unable to get local issuer certificate)',
            );
        });

        it('shows a code only once', () => {
            const err = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND', message: 'ENOTFOUND' } });
            assert.equal(describeError(err), 'fetch failed (ENOTFOUND)');
        });

        it('keeps errors without a cause', () => {
            assert.equal(describeError(new Error('boom')), 'boom');
            assert.equal(describeError('plain'), 'plain');
            assert.equal(describeError(null), 'null');
        });
    });
});
