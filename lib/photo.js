'use strict';

/*
 * Photos: MAX delivers them as attachments of type "image" of the incoming message. Each photo is downloaded into
 * the data folder of the adapter and its path is published in communicate.pathFile — the same contract as for voice
 * messages (lib/voice.js) and as in the Telegram adapter, so other programs (e.g. an AI agent) can pick the file up.
 */

const fs = require('node:fs');
const path = require('node:path');
const { voiceFileName, pruneVoiceDir } = require('./voice');

/** Attachment types that carry a photo */
const PHOTO_TYPES = ['image', 'photo'];

/** Files kept in the photo folder */
const KEEP_PHOTOS = 50;

/** Largest photo that is downloaded (bytes) */
const MAX_PHOTO_SIZE = 20 * 1024 * 1024;

/** Timeout for the download (ms) */
const DOWNLOAD_TIMEOUT = 30000;

/** Content types and file extensions of images */
const EXTENSIONS = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/pjpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/gif': '.gif',
};
const URL_EXTENSIONS = { '.jpg': '.jpg', '.jpeg': '.jpg', '.png': '.png', '.webp': '.webp', '.gif': '.gif' };

/**
 * All photo attachments with a download URL, in the order of the message
 *
 * @param {{ attachments?: unknown }} [body] - message body
 * @returns {{ type: string, url: string }[]} attachment type and URL of every photo
 */
function findPhotoAttachments(body) {
    const attachments = body && Array.isArray(body.attachments) ? body.attachments : [];
    const photos = [];
    for (const a of attachments) {
        if (
            a &&
            typeof a === 'object' &&
            PHOTO_TYPES.includes(String(a.type).toLowerCase()) &&
            a.payload &&
            typeof a.payload.url === 'string' &&
            /^https?:\/\//i.test(a.payload.url)
        ) {
            photos.push({ type: String(a.type), url: a.payload.url });
        }
    }
    return photos;
}

/**
 * Image type from the first bytes of the file
 *
 * @param {Buffer} buffer - file content
 * @returns {string | null} extension with dot, null if unknown
 */
function sniffExtension(buffer) {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return '.jpg';
    }
    if (
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    ) {
        return '.png';
    }
    if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('latin1'))) {
        return '.gif';
    }
    if (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
        buffer.subarray(8, 12).toString('latin1') === 'WEBP'
    ) {
        return '.webp';
    }
    return null;
}

/**
 * File extension from the content type, else from the file content, else from the URL, else .jpg
 *
 * @param {string | null | undefined} contentType - Content-Type header
 * @param {Buffer} buffer - file content
 * @param {string} url - download URL
 * @returns {string} extension with dot (.jpg, .png, .webp or .gif)
 */
function photoExtension(contentType, buffer, url) {
    const type = String(contentType || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    if (EXTENSIONS[type]) {
        return EXTENSIONS[type];
    }
    const sniffed = sniffExtension(buffer);
    if (sniffed) {
        return sniffed;
    }
    try {
        const ext = path.posix.extname(new URL(url).pathname).toLowerCase();
        if (URL_EXTENSIONS[ext]) {
            return URL_EXTENSIONS[ext];
        }
    } catch {
        // no valid URL — use the default
    }
    return '.jpg';
}

/**
 * File name of a photo: <mid> for a single photo, <mid>_1, <mid>_2, ... for several photos of one message
 *
 * @param {string} messageId - MAX message id (mid)
 * @param {number} index - position of the photo in the message, starting with 1
 * @param {number} count - number of photos in the message
 * @returns {string} file name without extension
 */
function photoFileName(messageId, index, count) {
    const base = voiceFileName(messageId);
    return count > 1 ? `${base}_${index}` : base;
}

/**
 * Delete all but the newest files of the photo folder
 *
 * @param {string} dir - photo folder
 * @param {number} [keep] - number of files to keep
 * @returns {Promise<number>} number of deleted files
 */
function prunePhotoDir(dir, keep = KEEP_PHOTOS) {
    return pruneVoiceDir(dir, keep);
}

/**
 * Download a photo into the photo folder
 *
 * @param {typeof globalThis.fetch} fetchFn - fetch that trusts the root CA of MAX (lib/max-fetch.js)
 * @param {string} url - download URL of the attachment
 * @param {string} dir - photo folder (created if missing)
 * @param {string} fileName - file name without extension (photoFileName)
 * @returns {Promise<string>} absolute path of the written file
 */
async function downloadPhoto(fetchFn, url, dir, fileName) {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
    if (!res.ok) {
        throw new Error(`Download of the photo failed: HTTP ${res.status}`);
    }
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_PHOTO_SIZE) {
        throw new Error(`Photo too large (${length} bytes)`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) {
        throw new Error('Photo is empty');
    }
    if (buffer.length > MAX_PHOTO_SIZE) {
        throw new Error(`Photo too large (${buffer.length} bytes)`);
    }
    await fs.promises.mkdir(dir, { recursive: true });
    const file = path.join(dir, fileName + photoExtension(res.headers.get('content-type'), buffer, url));
    await fs.promises.writeFile(file, buffer);
    return file;
}

module.exports = {
    KEEP_PHOTOS,
    MAX_PHOTO_SIZE,
    findPhotoAttachments,
    sniffExtension,
    photoExtension,
    photoFileName,
    prunePhotoDir,
    downloadPhoto,
};
