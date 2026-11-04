'use strict';

const assert = require('node:assert/strict');
const { messageFormat, escapeHtml } = require('../lib/format');
const { notificationText, newestMessage } = require('../lib/notification');

describe('lib/format', () => {
    describe('messageFormat', () => {
        it('takes format markdown and html', () => {
            assert.equal(messageFormat({ format: 'markdown' }), 'markdown');
            assert.equal(messageFormat({ format: 'HTML' }), 'html');
        });

        it('maps parse_mode of the Telegram adapter', () => {
            assert.equal(messageFormat({ parse_mode: 'HTML' }), 'html');
            assert.equal(messageFormat({ parse_mode: 'Markdown' }), 'markdown');
            assert.equal(messageFormat({ parse_mode: 'MarkdownV2' }), 'markdown');
        });

        it('prefers format over parse_mode', () => {
            assert.equal(messageFormat({ format: 'html', parse_mode: 'Markdown' }), 'html');
        });

        it('sends plain text without format', () => {
            assert.equal(messageFormat({}), undefined);
            assert.equal(messageFormat({ format: '' }), undefined);
            assert.equal(messageFormat({ format: 'plain' }), undefined);
            assert.equal(messageFormat(null), undefined);
        });

        it('rejects unknown values', () => {
            assert.throws(() => messageFormat({ format: 'bbcode' }), /Invalid format: bbcode/);
            assert.throws(() => messageFormat({ parse_mode: 'rtf' }), /Invalid parse_mode: rtf/);
        });
    });

    describe('escapeHtml', () => {
        it('escapes &, < and >', () => {
            assert.equal(escapeHtml('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
        });
    });
});

describe('lib/notification', () => {
    const message = {
        host: 'system.host.raspi',
        category: {
            id: 'diskSpaceIssues',
            name: 'Disk space <low>',
            description: 'The free disk space is low',
            instances: {
                'system.adapter.backitup.0': {
                    messages: [
                        { ts: 1000, message: 'old message' },
                        { ts: 5000, message: 'newest & last' },
                    ],
                },
                'system.adapter.admin.0': { messages: [] },
            },
        },
    };

    it('builds the text like the Telegram adapter, as html', () => {
        const text = notificationText(message);
        const lines = text.split('\n');
        assert.equal(lines[0], '<b>Disk space &lt;low&gt;</b>');
        assert.equal(lines[1], '');
        assert.equal(lines[2], 'The free disk space is low');
        assert.equal(lines[3], 'raspi:');
        assert.match(lines[4], /^backitup\.0: .* newest &amp; last$/);
        assert.equal(lines[5], 'admin.0:');
    });

    it('takes the newest message of an instance', () => {
        assert.match(newestMessage([{ ts: 1, message: 'a' }, { ts: 2, message: 'b' }]), / b$/);
        assert.equal(newestMessage([]), '');
        assert.equal(newestMessage(undefined), '');
    });

    it('copes with an incomplete payload', () => {
        assert.equal(notificationText({}), '<b>ioBroker</b>');
        assert.equal(notificationText(null), '<b>ioBroker</b>');
    });
});
