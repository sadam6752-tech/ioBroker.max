'use strict';

/*
 * Voice messages: MAX delivers them as an attachment of the incoming message. The file is downloaded into the data
 * folder of the adapter and its path is published in communicate.pathFile — the same contract as the Telegram
 * adapter, so other adapters (e.g. speech recognition) can pick the file up.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Attachment types that carry a voice message ("voice" in case MAX uses an own type) */
const VOICE_TYPES = ['audio', 'voice'];

/** Files kept in the voice folder */
const KEEP_FILES = 20;

/** Largest voice file that is downloaded (bytes) */
const MAX_VOICE_SIZE = 25 * 1024 * 1024;

/** Timeout for the download (ms) */
const DOWNLOAD_TIMEOUT = 30000;

/** Content types and file extensions of audio files */
const EXTENSIONS = {
    'audio/ogg': '.ogg',
    'audio/opus': '.ogg',
    'audio/x-opus+ogg': '.ogg',
    'application/ogg': '.ogg',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/m4a': '.m4a',
    'audio/aac': '.aac',
    'audio/wav': '.wav',
    'audio/x-wav': '.wav',
    'audio/wave': '.wav',
    'audio/webm': '.webm',
    'audio/amr': '.amr',
};
const URL_EXTENSIONS = ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.aac', '.wav', '.webm', '.amr'];

/**
 * Short description of the attachments for the debug log — types and keys only, no URLs (they may carry tokens)
 *
 * @param {unknown} attachments - attachments of a message body
 * @returns {string} e.g. "audio{payload:url,token}"
 */
function describeAttachments(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) {
        return 'none';
    }
    return attachments
        .map(a => {
            if (!a || typeof a !== 'object') {
                return typeof a;
            }
            const keys = Object.keys(a).filter(k => k !== 'type' && k !== 'payload');
            const payloadKeys = a.payload && typeof a.payload === 'object' ? Object.keys(a.payload) : [];
            return `${a.type}{payload:${payloadKeys.join(',')}${keys.length ? `;${keys.join(',')}` : ''}}`;
        })
        .join(', ');
}

/**
 * First voice attachment with a download URL
 *
 * @param {{ attachments?: unknown }} [body] - message body
 * @returns {{ type: string, url: string } | null} attachment type and URL
 */
function findVoiceAttachment(body) {
    const attachments = body && Array.isArray(body.attachments) ? body.attachments : [];
    for (const a of attachments) {
        if (
            a &&
            typeof a === 'object' &&
            VOICE_TYPES.includes(String(a.type).toLowerCase()) &&
            a.payload &&
            typeof a.payload.url === 'string' &&
            /^https?:\/\//i.test(a.payload.url)
        ) {
            return { type: String(a.type), url: a.payload.url };
        }
    }
    return null;
}

/**
 * File extension from the content type, else from the URL, else .ogg
 *
 * @param {string | null | undefined} contentType - Content-Type header
 * @param {string} url - download URL
 * @returns {string} extension with dot
 */
function voiceExtension(contentType, url) {
    const type = String(contentType || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    if (EXTENSIONS[type]) {
        return EXTENSIONS[type];
    }
    try {
        const ext = path.posix.extname(new URL(url).pathname).toLowerCase();
        if (URL_EXTENSIONS.includes(ext)) {
            return ext === '.oga' || ext === '.opus' ? '.ogg' : ext;
        }
    } catch {
        // no valid URL — use the default
    }
    return '.ogg';
}

/**
 * File name from the MAX message id (only characters that are safe in a file name)
 *
 * @param {string} messageId - MAX message id (mid)
 * @returns {string} file name without extension
 */
function voiceFileName(messageId) {
    const safe = String(messageId || '')
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/^\.+/, '');
    return safe || `voice_${Date.now()}`;
}

/**
 * Delete all but the newest files of the voice folder
 *
 * @param {string} dir - voice folder
 * @param {number} [keep] - number of files to keep
 * @returns {Promise<number>} number of deleted files
 */
async function pruneVoiceDir(dir, keep = KEEP_FILES) {
    let names;
    try {
        names = await fs.promises.readdir(dir);
    } catch {
        return 0;
    }
    const files = [];
    for (const name of names) {
        const file = path.join(dir, name);
        try {
            const stat = await fs.promises.stat(file);
            if (stat.isFile()) {
                files.push({ file, mtime: stat.mtimeMs });
            }
        } catch {
            // vanished in between
        }
    }
    files.sort((a, b) => b.mtime - a.mtime);
    let deleted = 0;
    for (const { file } of files.slice(keep)) {
        try {
            await fs.promises.unlink(file);
            deleted++;
        } catch {
            // already gone
        }
    }
    return deleted;
}

/**
 * Download a voice file into the voice folder
 *
 * @param {typeof globalThis.fetch} fetchFn - fetch that trusts the root CA of MAX (lib/max-fetch.js)
 * @param {string} url - download URL of the attachment
 * @param {string} dir - voice folder (created if missing)
 * @param {string} messageId - MAX message id, used as file name
 * @returns {Promise<string>} absolute path of the written file
 */
async function downloadVoice(fetchFn, url, dir, messageId) {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
    if (!res.ok) {
        throw new Error(`Download of the voice message failed: HTTP ${res.status}`);
    }
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_VOICE_SIZE) {
        throw new Error(`Voice message too large (${length} bytes)`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
        throw new Error('Voice message is empty');
    }
    if (buffer.length > MAX_VOICE_SIZE) {
        throw new Error(`Voice message too large (${buffer.length} bytes)`);
    }
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, voiceFileName(messageId) + voiceExtension(res.headers.get('content-type'), url));
    await fs.promises.writeFile(file, buffer);
    return file;
}

module.exports = {
    KEEP_FILES,
    describeAttachments,
    findVoiceAttachment,
    voiceExtension,
    voiceFileName,
    pruneVoiceDir,
    downloadVoice,
};
