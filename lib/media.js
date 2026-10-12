'use strict';

/*
 * Attachments (image, video, audio, file) for MAX messages.
 *
 * The upload helper of @maxhub/max-bot-api posts the file with node:https and the default agent, so the root CA
 * of lib/max-fetch.js would not apply there and network errors lose their cause. The upload is therefore done
 * here: the upload URL comes from the MAX API (`POST /uploads?type=...`), the file is posted as multipart form
 * with the adapter's own fetch.
 */

const fs = require('node:fs');
const path = require('node:path');
const { FormData } = require('undici');

/** Attachment types in the order they are added to a message */
const MEDIA_TYPES = ['image', 'video', 'audio', 'file'];

/** Largest file the adapter loads (bytes) — protects the memory of the ioBroker host */
const MAX_MEDIA_SIZE = 100 * 1024 * 1024;

/** Timeout for downloading a source URL (ms) */
const DOWNLOAD_TIMEOUT = 60000;

/** Timeout for uploading a file to MAX (ms) */
const UPLOAD_TIMEOUT = 5 * 60000;

/**
 * Collect the attachments of a send request: `image`, `video`, `audio`, `file`, each a string or a list of strings
 * (local path or http(s) URL)
 *
 * @param {Record<string, unknown>} data - send request
 * @returns {{ type: string, source: string }[]} attachments in a fixed order
 */
function collectMedia(data) {
    const media = [];
    if (!data || typeof data !== 'object') {
        return media;
    }
    for (const type of MEDIA_TYPES) {
        const value = data[type];
        if (value === undefined || value === null || value === '') {
            continue;
        }
        const sources = Array.isArray(value) ? value : [value];
        for (const source of sources) {
            if (typeof source !== 'string' || source.trim() === '') {
                throw new Error(`Invalid ${type}: expected a file path or an http(s) URL`);
            }
            media.push({ type, source: source.trim() });
        }
    }
    return media;
}

/**
 * Check whether a source is a URL that the adapter downloads itself
 *
 * @param {string} source - path or URL
 * @returns {boolean} true for http and https URLs
 */
function isUrl(source) {
    return /^https?:\/\//i.test(source);
}

/**
 * Download a URL. Credentials in the URL (`http://user:pass@camera/snapshot.jpg`) are sent as basic auth,
 * because fetch refuses URLs that contain them.
 *
 * @param {string} source - http(s) URL
 * @param {typeof globalThis.fetch} fetchFn - fetch to use
 * @returns {Promise<{ blob: Blob, fileName: string }>} content and file name
 */
async function download(source, fetchFn) {
    const url = new URL(source);
    const headers = {};
    if (url.username || url.password) {
        const user = decodeURIComponent(url.username);
        const password = decodeURIComponent(url.password);
        headers.Authorization = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
        url.username = '';
        url.password = '';
    }
    const shown = `${url.origin}${url.pathname}`;
    const res = await fetchFn(url.href, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT) });
    if (!res.ok) {
        throw new Error(`Download of ${shown} failed: HTTP ${res.status}`);
    }
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_MEDIA_SIZE) {
        throw new Error(`${shown} is too large (${length} bytes, limit ${MAX_MEDIA_SIZE})`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > MAX_MEDIA_SIZE) {
        throw new Error(`${shown} is too large (${buffer.length} bytes, limit ${MAX_MEDIA_SIZE})`);
    }
    const contentType = res.headers.get('content-type') || undefined;
    const fileName = path.posix.basename(url.pathname) || 'file';
    return { blob: new Blob([buffer], contentType ? { type: contentType } : {}), fileName };
}

/**
 * Open a local file without reading it into memory
 *
 * @param {string} source - file path
 * @returns {Promise<{ blob: Blob, fileName: string }>} content and file name
 */
async function openFile(source) {
    let stat;
    try {
        stat = await fs.promises.stat(source);
    } catch (e) {
        throw new Error(`Cannot read ${source}: ${e.code || e.message}`);
    }
    if (!stat.isFile()) {
        throw new Error(`${source} is not a file`);
    }
    if (stat.size > MAX_MEDIA_SIZE) {
        throw new Error(`${source} is too large (${stat.size} bytes, limit ${MAX_MEDIA_SIZE})`);
    }
    return { blob: await fs.openAsBlob(source), fileName: path.basename(source) };
}

/**
 * Upload one attachment to MAX and return the attachment for the send request
 *
 * @param {object} api - `bot.api` of `@maxhub/max-bot-api` (uses `raw.uploads.getUploadUrl`)
 * @param {typeof globalThis.fetch} fetchFn - fetch for the download and the upload
 * @param {{ type: string, source: string }} media - attachment
 * @returns {Promise<{ type: string, payload: object }>} attachment as expected by the MAX API
 */
async function uploadMedia(api, fetchFn, media) {
    const { type, source } = media;
    const { blob, fileName } = isUrl(source) ? await download(source, fetchFn) : await openFile(source);

    const { url: uploadUrl, token } = await api.raw.uploads.getUploadUrl({ type });
    if (!uploadUrl) {
        throw new Error(`MAX returned no upload URL for ${type}`);
    }

    const form = new FormData();
    form.append('data', blob, fileName);
    const res = await fetchFn(uploadUrl, { method: 'POST', body: form, signal: AbortSignal.timeout(UPLOAD_TIMEOUT) });
    const body = await res.text();
    if (!res.ok) {
        throw new Error(`Upload of ${fileName} failed: HTTP ${res.status} ${body.slice(0, 200)}`.trim());
    }

    let data = {};
    try {
        data = JSON.parse(body);
    } catch {
        // video and audio answer with XML (<retval>1</retval>); their token came with the upload URL
    }

    // video/audio: token from the upload URL; image: photos; file: token in the response
    if (token) {
        return { type, payload: { token } };
    }
    if (type === 'image' && data && data.photos) {
        return { type, payload: { photos: data.photos } };
    }
    if (data && data.token) {
        return { type, payload: { token: data.token } };
    }
    throw new Error(`Upload of ${fileName} returned no token`);
}

module.exports = { MEDIA_TYPES, MAX_MEDIA_SIZE, collectMedia, isUrl, download, openFile, uploadMedia };
