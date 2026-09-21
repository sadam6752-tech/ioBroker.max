'use strict';

const assert = require('node:assert/strict');
const { normalizeSecrets, isBrokenSecret } = require('../lib/secrets');

/**
 * Run `normalizeSecrets` with a collecting logger
 *
 * @param {object} config - native configuration (modified in place)
 * @param {(attr: string) => Promise<string>} [decrypt] - optional decrypt implementation
 * @returns {Promise<object>} config and collected log entries
 */
async function normalize(config, decrypt) {
    const logs = { info: [], warn: [], error: [] };
    const logger = {
        info: msg => logs.info.push(msg),
        warn: msg => logs.warn.push(msg),
        error: msg => logs.error.push(msg),
    };
    await normalizeSecrets(config, logger, decrypt);
    return { config, logs };
}

const XOR_GARBAGE = '7\u001e6\u001eT_\t\u0016\u0004KD\u001d%=)';

describe('lib/secrets', () => {
    describe('isBrokenSecret', () => {
        it('accepts printable tokens', () => {
            assert.equal(isBrokenSecret('abc123:/+='), false);
        });

        it('detects control characters', () => {
            assert.equal(isBrokenSecret(XOR_GARBAGE), true);
            assert.equal(isBrokenSecret('abc\u0000def'), true);
        });
    });

    describe('normalizeSecrets', () => {
        it('keeps a plain text token untouched', async () => {
            const { config, logs } = await normalize({ token: 'bot-token-123' });
            assert.equal(config.token, 'bot-token-123');
            assert.equal(logs.info.length + logs.warn.length + logs.error.length, 0);
        });

        it('ignores missing and empty tokens', async () => {
            const { config, logs } = await normalize({ token: '' });
            assert.equal(config.token, '');
            assert.equal(logs.warn.length, 0);

            const { config: config2 } = await normalize({});
            assert.equal(config2.token, undefined);
        });

        it('decrypts a token stored in the $/aes-192-cbc: format', async () => {
            const { config, logs } = await normalize({ token: '$/aes-192-cbc:abcd:1234' }, async () => 'plainToken');
            assert.equal(config.token, 'plainToken');
            assert.equal(logs.info.length, 1);
            assert.match(logs.info[0], /decrypted MAX bot token/);
        });

        it('keeps an encrypted token when no decrypt function is available', async () => {
            const { config } = await normalize({ token: '$/aes-192-cbc:abcd:1234' });
            assert.equal(config.token, '$/aes-192-cbc:abcd:1234');
        });

        it('clears the token when decryption fails', async () => {
            const { config, logs } = await normalize({ token: '$/aes-192-cbc:abcd:1234' }, async () => {
                throw new Error('bad secret');
            });
            assert.equal(config.token, '');
            assert.equal(logs.warn.length, 1);
            assert.match(logs.warn[0], /Could not decrypt the stored token/);
        });

        it('reports a broken (XOR mangled) token', async () => {
            const { config, logs } = await normalize({ token: XOR_GARBAGE });
            assert.equal(config.token, '');
            assert.equal(logs.error.length, 1);
            assert.match(logs.error[0], /token is unreadable/);
        });
    });
});
