'use strict';

/*
 * fetch for the MAX Bot API client.
 *
 * The MAX API host (platform-api2.max.ru) presents a certificate of the "Russian Trusted Root CA" of the
 * Russian Ministry of Digital Development. Node.js does not ship this root and ignores the trust store of
 * the operating system by default, so every request failed with "fetch failed"
 * (UNABLE_TO_GET_ISSUER_CERT_LOCALLY). This module trusts the root for the requests of this adapter only:
 * the CA is added to an own undici dispatcher, the global fetch and all other adapters stay untouched.
 */

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { Agent, fetch } = require('undici');

/** Russian Trusted Root CA, valid until 2032-02-27, SHA-256 D2:6D:2D:02:31:B7:C3:9F:...:CA:8E:CF:31 */
const ROOT_CA_FILE = path.join(__dirname, 'certs', 'russian-trusted-root-ca.pem');

/**
 * Create a fetch function that trusts the Mozilla roots of Node.js plus the Russian Trusted Root CA
 *
 * @returns {{ fetch: typeof globalThis.fetch, close: () => Promise<void> }} fetch and a function that closes its connections
 */
function createMaxFetch() {
    const rootCa = fs.readFileSync(ROOT_CA_FILE, 'utf8');
    const dispatcher = new Agent({ connect: { ca: [...tls.rootCertificates, rootCa] } });

    const maxFetch = (input, init = {}) => fetch(input, { ...init, dispatcher });

    return {
        fetch: maxFetch,
        close: () => dispatcher.close(),
    };
}

/**
 * Turn a fetch error into a readable message: undici reports only "fetch failed" and keeps the reason
 * (certificate, DNS, refused connection) in `cause`.
 *
 * @param {unknown} err - error thrown by fetch or the MAX API client
 * @returns {string} message including the cause
 */
function describeError(err) {
    if (!err || typeof err !== 'object') {
        return String(err);
    }
    const message = 'message' in err ? String(err.message) : String(err);
    const cause = 'cause' in err ? err.cause : undefined;
    if (!cause || typeof cause !== 'object') {
        return message;
    }
    const code = 'code' in cause && cause.code ? String(cause.code) : '';
    const causeMessage = 'message' in cause && cause.message ? String(cause.message) : '';
    const detail = [code, causeMessage && causeMessage !== code ? causeMessage : ''].filter(Boolean).join(': ');
    return detail ? `${message} (${detail})` : message;
}

module.exports = { createMaxFetch, describeError, ROOT_CA_FILE };
