'use strict';

/**
 * Repair the `token` attribute of the adapter configuration.
 *
 * v0.1.3 declared `protectedNative`/`encryptedNative` for the bot token. The js-controller
 * decrypts every attribute listed in `encryptedNative` before the adapter starts; for values
 * that had been stored as plain text it falls back to a XOR with the system secret
 * (`tools.decryptLegacy()`, without any format check, warning or error) and turns them into
 * unusable data — the adapter could not authenticate against the MAX API anymore.
 *
 * v0.1.4 removed `encryptedNative` again (`protectedNative` is kept), so stored plain text
 * tokens keep working. This module repairs configurations that were already affected:
 * values stored in the `$/aes-192-cbc:` format are decrypted, unusable values (containing
 * control characters) are dropped and reported, so the user can enter the token again.
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

module.exports = { normalizeSecrets, isBrokenSecret };
