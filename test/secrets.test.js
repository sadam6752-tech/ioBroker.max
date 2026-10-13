'use strict';

const assert = require('node:assert/strict');
const { normalizeSecrets, isBrokenSecret, needsTokenMigration, migrateToken } = require('../lib/secrets');
const { controllerEncrypt, controllerDecrypt } = require('./lib/controller-crypto');

/** a made-up token in the shape of a MAX bot token */
const TOKEN = 'f9LHodD0cOKqPUSCZwXjp4Vw3pHtcvWw7m8nGgN1bQcR8sKzT2yXe5JaUiVb';
const MODERN_SECRET = 'a3f1c2d4e5b60718293a4b5c6d7e8f90a1b2c3d4e5f60718';
const LEGACY_SECRET = 'Zgfr56gFe87jJOM';

/**
 * Simulate an adapter start: the js-controller decrypts the raw value of the instance object
 *
 * @param {string} secret - system secret
 * @param {string} raw - value stored in the instance object
 * @returns {object} adapter mock with the stored instance object
 */
function startAdapter(secret, raw) {
    const logs = { info: [], warn: [], error: [] };
    const adapter = {
        namespace: 'max.0',
        instance: { native: { token: raw } },
        config: { token: raw ? controllerDecrypt(secret, raw) : raw },
        logs,
        writes: [],
        log: {
            info: msg => logs.info.push(msg),
            warn: msg => logs.warn.push(msg),
            error: msg => logs.error.push(msg),
        },
        encrypt: value => controllerEncrypt(secret, value),
        async getForeignObjectAsync(id) {
            assert.equal(id, 'system.adapter.max.0');
            return this.instance;
        },
        async extendForeignObjectAsync(id, obj) {
            this.writes.push({ id, obj });
            this.instance = { native: { ...this.instance.native, ...obj.native } };
        },
    };
    return adapter;
}

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

describe('token migration (v0.1.12)', () => {
    for (const [label, secret] of [
        ['system secret with 48 hex digits', MODERN_SECRET],
        ['legacy system secret', LEGACY_SECRET],
    ]) {
        describe(label, () => {
            it('migrates a plain text token once and keeps it usable', async () => {
                const first = startAdapter(secret, TOKEN);
                assert.equal(isBrokenSecret(first.config.token), true, 'the js-controller breaks plain text');
                assert.equal(await migrateToken(first), true);
                assert.equal(first.config.token, TOKEN);
                assert.equal(first.writes.length, 1);
                assert.notEqual(first.instance.native.token, TOKEN);
                assert.match(first.logs.info[0], /stored encrypted/);

                // restart after the write: the js-controller now decrypts the stored value correctly
                const second = startAdapter(secret, first.instance.native.token);
                assert.equal(second.config.token, TOKEN);
                assert.equal(await migrateToken(second), false);
                assert.equal(second.writes.length, 0);
            });

            it('leaves a token alone that the admin stored encrypted', async () => {
                const adapter = startAdapter(secret, controllerEncrypt(secret, TOKEN));
                assert.equal(adapter.config.token, TOKEN);
                assert.equal(await migrateToken(adapter), false);
                assert.equal(adapter.writes.length, 0);
            });
        });
    }

    it('stores the AES format with a modern secret', async () => {
        const adapter = startAdapter(MODERN_SECRET, TOKEN);
        await migrateToken(adapter);
        assert.match(adapter.instance.native.token, /^\$\/aes-192-cbc:/);
    });

    it('does nothing without a token', async () => {
        const adapter = startAdapter(MODERN_SECRET, '');
        assert.equal(await migrateToken(adapter), false);
        assert.equal(adapter.writes.length, 0);
    });

    it('keeps the plain text token when the instance object cannot be written', async () => {
        const adapter = startAdapter(MODERN_SECRET, TOKEN);
        adapter.extendForeignObjectAsync = async () => {
            throw new Error('permission denied');
        };
        assert.equal(await migrateToken(adapter), false);
        assert.equal(adapter.config.token, TOKEN);
        assert.match(adapter.logs.warn[0], /permission denied/);
    });

    it('does nothing when the instance object cannot be read', async () => {
        const adapter = startAdapter(MODERN_SECRET, TOKEN);
        adapter.getForeignObjectAsync = async () => {
            throw new Error('no database');
        };
        assert.equal(await migrateToken(adapter), false);
        assert.match(adapter.logs.warn[0], /no database/);
    });

    describe('needsTokenMigration', () => {
        it('needs a broken decrypted value and a clean raw value', () => {
            assert.equal(needsTokenMigration('a\u0001b', TOKEN), true);
            assert.equal(needsTokenMigration(TOKEN, TOKEN), false);
            assert.equal(needsTokenMigration('a\u0001b', '$/aes-192-cbc:00:11'), false);
            assert.equal(needsTokenMigration('a\u0001b', 'x\u0002y'), false);
            assert.equal(needsTokenMigration('a\u0001b', undefined), false);
        });
    });
});
