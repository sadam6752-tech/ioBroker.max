'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { HELP, COMMANDS } = require('../lib/help');

/**
 * The commands onMessage() of main.js answers
 *
 * @returns {string[]} command names
 */
function commandsOfMain() {
    const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf('async onMessage(');
    const end = source.indexOf('async _answerCallback(');
    assert.ok(start > 0 && end > start, 'onMessage found');
    return [...source.slice(start, end).matchAll(/obj\.command [!=]== '([^']+)'/g)].map(m => m[1]);
}

describe('help', () => {
    it('lists exactly the commands onMessage answers, each once', () => {
        const names = COMMANDS.map(c => c.command);
        assert.equal(new Set(names).size, names.length);
        assert.deepEqual([...names].sort(), [...new Set(commandsOfMain())].sort());
    });

    it('marks only help as read-only', () => {
        for (const { command, write } of COMMANDS) {
            assert.equal(write, command !== 'help', command);
        }
    });

    it('names every command for an agent', () => {
        for (const { command } of COMMANDS.filter(c => c.command !== 'help')) {
            assert.ok(HELP.includes(`- ${command} `) || HELP.includes(`- ${command}:`), command);
        }
        assert.ok(HELP.includes('sendTo max.0'));
        assert.ok(HELP.includes('How to talk to the user:'));
    });

    it('keeps the lines short', () => {
        for (const line of HELP.split('\n')) {
            assert.ok(line.length <= 120, line);
        }
    });
});
