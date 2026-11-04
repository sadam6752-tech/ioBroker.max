'use strict';

/*
 * Text of an ioBroker notification (notification-manager, command "sendNotification"), built like the Telegram
 * adapter does: category name, description, host and the newest message of every instance. Format "html".
 */

const { escapeHtml } = require('./format');

/**
 * Newest message of an instance with its localised date
 *
 * @param {{ ts?: number, message?: string }[] | undefined} messages - messages of one instance
 * @returns {string} "date message" or an empty string
 */
function newestMessage(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return '';
    }
    const newest = [...messages].sort((a, b) => (Number(b && b.ts) || 0) - (Number(a && a.ts) || 0))[0] || {};
    const date = Number(newest.ts) ? new Date(Number(newest.ts)).toLocaleString() : '';
    return `${date} ${newest.message || ''}`.trim();
}

/**
 * Build the message text of a notification
 *
 * @param {{ host?: string, category?: { id?: string, name?: string, description?: string, instances?: Record<string, { messages?: { ts?: number, message?: string }[] }> } } | null | undefined} message - payload of "sendNotification"
 * @returns {string} text for format "html"
 */
function notificationText(message) {
    const category = (message && message.category) || {};
    const name = category.name || category.id || 'ioBroker';
    const lines = [`<b>${escapeHtml(name)}</b>`, ''];
    if (category.description) {
        lines.push(escapeHtml(category.description));
    }
    if (message && message.host) {
        lines.push(`${escapeHtml(String(message.host).replace(/^system\.host\./, ''))}:`);
    }
    const instances = category.instances && typeof category.instances === 'object' ? category.instances : {};
    for (const [instance, entry] of Object.entries(instances)) {
        const id = instance.replace(/^system\.adapter\./, '');
        lines.push(`${escapeHtml(id)}: ${escapeHtml(newestMessage(entry && entry.messages))}`);
    }
    return lines.join('\n').trim();
}

module.exports = { notificationText, newestMessage };
