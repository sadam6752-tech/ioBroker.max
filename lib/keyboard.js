'use strict';

/*
 * Inline keyboard (buttons below a message).
 *
 * `keyboard` is a list of rows, each row a list of buttons:
 * - "Pool"                               message button: pressing it sends "Pool" as a message of the user,
 *                                        so a script handles a pressed button like a typed command
 * - { text: "Open gate", callback: "gate" }  callback button: the payload arrives in users.<id>.callback_data
 *                                        and communicate.request
 * - { text: "Website", url: "https://…" }    link button
 */

/** Limits of the MAX API for an inline keyboard */
const MAX_ROWS = 30;
const MAX_BUTTONS_PER_ROW = 7;
const MAX_BUTTONS = 210;

/**
 * Turn one button definition into a MAX button
 *
 * @param {unknown} button - string or object
 * @param {string} where - position for error messages
 * @returns {object} MAX button
 */
function buildButton(button, where) {
    if (typeof button === 'string') {
        if (button.trim() === '') {
            throw new Error(`Invalid keyboard: empty button ${where}`);
        }
        return { type: 'message', text: button.trim() };
    }
    if (!button || typeof button !== 'object' || Array.isArray(button)) {
        throw new Error(`Invalid keyboard: button ${where} must be a text or an object`);
    }
    const obj = button;
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    if (text === '') {
        throw new Error(`Invalid keyboard: button ${where} has no text`);
    }
    if (obj.url !== undefined) {
        if (typeof obj.url !== 'string' || !/^https?:\/\//i.test(obj.url)) {
            throw new Error(`Invalid keyboard: button ${where} needs an http(s) url`);
        }
        return { type: 'link', text, url: obj.url };
    }
    if (obj.callback !== undefined) {
        if (typeof obj.callback !== 'string' || obj.callback === '') {
            throw new Error(`Invalid keyboard: button ${where} needs a text as callback`);
        }
        return { type: 'callback', text, payload: obj.callback };
    }
    return { type: 'message', text };
}

/**
 * Build the inline keyboard attachment
 *
 * @param {unknown} keyboard - list of rows (a flat list of buttons is taken as one row per button)
 * @returns {{ type: 'inline_keyboard', payload: { buttons: object[][] } } | null} attachment, or null without keyboard
 */
function buildKeyboard(keyboard) {
    if (keyboard === undefined || keyboard === null) {
        return null;
    }
    if (!Array.isArray(keyboard) || keyboard.length === 0) {
        throw new Error('Invalid keyboard: expected a list of rows');
    }
    const rows = keyboard.map(row => (Array.isArray(row) ? row : [row]));
    if (rows.length > MAX_ROWS) {
        throw new Error(`Invalid keyboard: more than ${MAX_ROWS} rows`);
    }
    let count = 0;
    const buttons = rows.map((row, r) => {
        if (row.length === 0) {
            throw new Error(`Invalid keyboard: row ${r + 1} is empty`);
        }
        if (row.length > MAX_BUTTONS_PER_ROW) {
            throw new Error(`Invalid keyboard: row ${r + 1} has more than ${MAX_BUTTONS_PER_ROW} buttons`);
        }
        count += row.length;
        return row.map((button, b) => buildButton(button, `${r + 1}/${b + 1}`));
    });
    if (count > MAX_BUTTONS) {
        throw new Error(`Invalid keyboard: more than ${MAX_BUTTONS} buttons`);
    }
    return { type: 'inline_keyboard', payload: { buttons } };
}

module.exports = { buildKeyboard };
