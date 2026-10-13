'use strict';

/**
 * Storage of the bot token.
 *
 * The js-controller decrypts every attribute listed in `encryptedNative` before the adapter starts
 * (`tools.decrypt()`). A value without the `$/aes-192-cbc:` prefix goes through
 * `tools.decryptLegacy()` — a plain XOR with the system secret, without any check. A token that was
 * stored as plain text therefore reaches the adapter as unusable data.
 *
 * - v0.1.3 declared `encryptedNative` without a migration and broke plain text tokens.
 * - v0.1.4 to v0.1.11 kept the token in `protectedNative` only (plain text in the instance object).
 * - v0.1.12 declares `encryptedNative` again and migrates: the raw value in the instance object is
 *   still the plain text token, so the adapter takes it from there, encrypts it with the system
 *   secret (`adapter.encrypt()`) and writes it back once. From then on the js-controller decrypts
 *   it as usual.
 *
 * The decision does not rely on the prefix alone: with a legacy system secret (not 48 hex digits)
 * an encrypted value has no prefix either. A migration happens only when the value handed over by
 * the js-controller is unusable (control characters) while the raw value is a clean token.
 */

/**
 * Check whether a value contains control characters and therefore cannot be a real token
 *
 * @param {string} value - value to check
 * @returns {boolean} true if the value is unusable
 */
function isBrokenSecret(value) {
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u001f\u007f]/.test(value);
}

/**
 * Make the stored token usable again (modifies `config` in place)
 *
 * @param {object} config - native configuration of the adapter
 * @param {object} logger - logger with `info`, `warn` and `error` methods
 * @param {(attr: string) => Promise<string>} [decrypt] - decrypts an encrypted config attribute
 * @returns {Promise<void>} resolves when the token has been checked
 */
async function normalizeSecrets(config, logger, decrypt) {
    const attr = 'token';
    let value = config[attr];
    if (typeof value !== 'string' || value === '') {
        return;
    }

    if (value.startsWith('$/aes-192-cbc:') && typeof decrypt === 'function') {
        try {
            value = await decrypt(attr);
            logger.info('Using the decrypted MAX bot token from the instance configuration.');
        } catch (err) {
            logger.warn(`Could not decrypt the stored ${attr}: ${err.message}`);
            value = '';
        }
    }

    if (typeof value === 'string' && isBrokenSecret(value)) {
        logger.error(
            'The stored MAX bot token is unreadable (broken encryption of v0.1.3). ' +
                'Please open the adapter settings and enter the token again.',
        );
        value = '';
    }

    config[attr] = value;
}

/**
 * Check whether the token is still stored as plain text and has to be migrated
 *
 * @param {unknown} configToken - token as handed over by the js-controller (after decryption)
 * @param {unknown} rawToken - token as stored in the instance object
 * @returns {boolean} true if the raw value is a plain text token
 */
function needsTokenMigration(configToken, rawToken) {
    if (typeof rawToken !== 'string' || rawToken === '' || rawToken.startsWith('$/aes-192-cbc:')) {
        return false;
    }
    if (isBrokenSecret(rawToken)) {
        return false;
    }
    return typeof configToken === 'string' && isBrokenSecret(configToken);
}

/**
 * Move a plain text token into encrypted storage (one time, before the token is used).
 * Sets `adapter.config.token` to the plain text token. Writing the instance object makes the
 * js-controller restart the adapter, which then reads the encrypted token.
 *
 * @param {object} adapter - adapter instance (namespace, config, log, encrypt, get/extendForeignObjectAsync)
 * @returns {Promise<boolean>} true if the token was migrated
 */
async function migrateToken(adapter) {
    const id = `system.adapter.${adapter.namespace}`;
    let raw;
    try {
        const obj = await adapter.getForeignObjectAsync(id);
        raw = obj && obj.native ? obj.native.token : undefined;
    } catch (e) {
        adapter.log.warn(`Could not read the instance object to check the token storage: ${e.message}`);
        return false;
    }
    if (!needsTokenMigration(adapter.config.token, raw)) {
        return false;
    }
    adapter.config.token = raw;
    try {
        await adapter.extendForeignObjectAsync(id, { native: { token: adapter.encrypt(raw) } });
        adapter.log.info('The MAX bot token is now stored encrypted (one-time migration). The adapter restarts.');
        return true;
    } catch (e) {
        adapter.log.warn(`Could not store the MAX bot token encrypted, using it as it is: ${e.message}`);
        return false;
    }
}

module.exports = { normalizeSecrets, isBrokenSecret, needsTokenMigration, migrateToken };
