'use strict';

/*
 * Text formatting of MAX messages: `format: 'markdown' | 'html'` (MAX Bot API), plus `parse_mode` of the Telegram
 * adapter for existing scripts ('HTML' → html, 'Markdown' / 'MarkdownV2' → markdown). Without both: plain text.
 */

const FORMATS = ['markdown', 'html'];
const PARSE_MODES = { html: 'html', markdown: 'markdown', markdownv2: 'markdown' };

/**
 * Text format of a send request
 *
 * @param {Record<string, unknown>} data - send request
 * @returns {'markdown' | 'html' | undefined} format for the MAX API, undefined for plain text
 */
function messageFormat(data) {
    if (!data || typeof data !== 'object') {
        return undefined;
    }
    const format = data.format;
    if (format !== undefined && format !== null && format !== '') {
        const value = String(format).trim().toLowerCase();
        if (value === 'text' || value === 'plain') {
            return undefined;
        }
        if (!FORMATS.includes(value)) {
            throw new Error(`Invalid format: ${format} (use markdown or html)`);
        }
        return value;
    }
    const parseMode = data.parse_mode;
    if (parseMode !== undefined && parseMode !== null && parseMode !== '') {
        const value = PARSE_MODES[String(parseMode).trim().toLowerCase()];
        if (!value) {
            throw new Error(`Invalid parse_mode: ${parseMode} (use HTML, Markdown or MarkdownV2)`);
        }
        return value;
    }
    return undefined;
}

/**
 * Escape text for format "html"
 *
 * @param {unknown} text - text
 * @returns {string} text with &, < and > escaped
 */
function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { messageFormat, escapeHtml };
