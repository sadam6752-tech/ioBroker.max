'use strict';

/*
 * encrypt()/decrypt() exactly as in js-controller 7.2.3 (@iobroker/js-controller-common-db, lib/common/tools.js).
 * The module itself cannot be loaded without an installed js-controller, so the tests use this copy to simulate
 * what the js-controller does with the attributes listed in encryptedNative.
 */

const crypto = require('node:crypto');

/**
 * @param {string} key - system secret
 * @param {string} value - value
 * @returns {string} XOR result (legacy encryption and decryption)
 */
function xorLegacy(key, value) {
    let result = '';
    for (let i = 0; i < value.length; i++) {
        result += String.fromCharCode(key[i % key.length].charCodeAt(0) ^ value.charCodeAt(i));
    }
    return result;
}

/**
 * @param {string} key - system secret
 * @param {string} value - plain text
 * @returns {string} encrypted value
 */
function controllerEncrypt(key, value) {
    if (!/^[0-9a-f]{48}$/.test(key)) {
        return xorLegacy(key, value);
    }
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-192-cbc', Buffer.from(key, 'hex'), iv);
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return `$/aes-192-cbc:${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * @param {string} key - system secret
 * @param {string} value - stored value
 * @returns {string} decrypted value
 */
function controllerDecrypt(key, value) {
    if (!value.startsWith('$/aes-192-cbc:') || !/^[0-9a-f]{48}$/.test(key)) {
        return xorLegacy(key, value);
    }
    const parts = value.split(':', 3);
    const decipher = crypto.createDecipheriv('aes-192-cbc', Buffer.from(key, 'hex'), Buffer.from(parts[1], 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]).toString();
}

module.exports = { controllerEncrypt, controllerDecrypt };
