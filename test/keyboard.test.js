'use strict';

const assert = require('node:assert/strict');
const { buildKeyboard } = require('../lib/keyboard');

describe('lib/keyboard', () => {
    it('returns null without keyboard', () => {
        assert.equal(buildKeyboard(undefined), null);
        assert.equal(buildKeyboard(null), null);
    });

    it('turns texts into message buttons', () => {
        assert.deepEqual(buildKeyboard([['Pool', ' Light '], ['Menu']]), {
            type: 'inline_keyboard',
            payload: {
                buttons: [
                    [
                        { type: 'message', text: 'Pool' },
                        { type: 'message', text: 'Light' },
                    ],
                    [{ type: 'message', text: 'Menu' }],
                ],
            },
        });
    });

    it('builds callback and link buttons', () => {
        const keyboard = buildKeyboard([
            [
                { text: 'Open gate', callback: 'gate_open' },
                { text: 'Website', url: 'https://example.com' },
                { text: 'Pool' },
            ],
        ]);
        assert.deepEqual(keyboard.payload.buttons[0], [
            { type: 'callback', text: 'Open gate', payload: 'gate_open' },
            { type: 'link', text: 'Website', url: 'https://example.com' },
            { type: 'message', text: 'Pool' },
        ]);
    });

    it('takes a flat list as one button per row', () => {
        assert.deepEqual(buildKeyboard(['A', 'B']).payload.buttons, [
            [{ type: 'message', text: 'A' }],
            [{ type: 'message', text: 'B' }],
        ]);
    });

    it('rejects invalid keyboards with the position of the button', () => {
        assert.throws(() => buildKeyboard('Pool'), /expected a list of rows/);
        assert.throws(() => buildKeyboard([]), /expected a list of rows/);
        assert.throws(() => buildKeyboard([[]]), /row 1 is empty/);
        assert.throws(() => buildKeyboard([['A', '  ']]), /empty button 1\/2/);
        assert.throws(() => buildKeyboard([[{ callback: 'x' }]]), /button 1\/1 has no text/);
        assert.throws(() => buildKeyboard([[{ text: 'X', url: 'ftp://x' }]]), /http\(s\) url/);
        assert.throws(() => buildKeyboard([[{ text: 'X', callback: 5 }]]), /needs a text as callback/);
        assert.throws(() => buildKeyboard([[42]]), /must be a text or an object/);
    });

    it('enforces the limits of the MAX API', () => {
        assert.throws(() => buildKeyboard([['1', '2', '3', '4', '5', '6', '7', '8']]), /more than 7 buttons/);
        assert.throws(() => buildKeyboard(Array.from({ length: 31 }, () => ['x'])), /more than 30 rows/);
    });
});
