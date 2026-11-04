'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// adapter-core needs an installed js-controller; the unit tests only need the base class
const corePath = require.resolve('@iobroker/adapter-core');
const realCore = require.cache[corePath];
require.cache[corePath] = /** @type {any} */ ({
    id: corePath,
    filename: corePath,
    loaded: true,
    exports: { Adapter: class {}, getAbsoluteDefaultDataDir: () => '/opt/iobroker/iobroker-data' },
});
const mainPath = require.resolve('../main');
delete require.cache[mainPath];
const {
    MaxAdapter,
    parseSendValue,
    parseSendRequest,
    parseStateValue,
    COMMUNICATE_OBJECTS,
    GROUP_OBJECTS,
} = require('../main');
delete require.cache[mainPath];
if (realCore) {
    require.cache[corePath] = realCore;
} else {
    delete require.cache[corePath];
}

/**
 * Create an adapter instance without the js-controller: the prototype methods run on a
 * plain object that carries only what they use.
 *
 * @param {object} [config] - adapter config overrides
 * @returns {object} adapter under test
 */
function createAdapter(config = {}) {
    const adapter = Object.create(MaxAdapter.prototype);
    const logs = { debug: [], info: [], warn: [], error: [] };
    Object.assign(adapter, {
        namespace: 'max.0',
        config: { token: 'token', allowedUsers: '', sendToAllUsers: true, logUnknownCommands: false, ...config },
        logs,
        log: {
            debug: msg => logs.debug.push(msg),
            info: msg => logs.info.push(msg),
            warn: msg => logs.warn.push(msg),
            error: msg => logs.error.push(msg),
        },
        states: new Map(),
        replies: [],
        timers: [],
        unloading: false,
        startTimer: null,
        botManager: null,
        async setStateAsync(id, val) {
            this.states.set(id, val);
        },
        async getStateAsync(id) {
            return this.states.has(id) ? { val: this.states.get(id), ack: true } : null;
        },
        sendTo(to, command, message, callback) {
            this.replies.push({ to, command, message, callback });
        },
        setTimeout(fn, ms) {
            const timer = { fn, ms, cleared: false };
            this.timers.push(timer);
            return timer;
        },
        clearTimeout(timer) {
            timer.cleared = true;
        },
    });
    return adapter;
}

/**
 * Fake BotManager that records what it is asked to send
 *
 * @returns {object} fake manager
 */
function createManagerMock() {
    return {
        sent: [],
        chats: [],
        options: [],
        broadcasts: [],
        prepared: [],
        prepareError: null,
        stopped: false,
        answered: [],
        answerError: null,
        sendError: null,
        summary: { sent: 2, failed: 0, skipped: 0 },
        async prepareAttachments(media) {
            if (this.prepareError) {
                throw this.prepareError;
            }
            this.prepared.push(media);
            return media.map(m => ({ type: m.type, payload: { token: `${m.type}:${m.source}` } }));
        },
        async sendMessage(userId, text, attachments = [], options = {}) {
            if (this.sendError) {
                throw this.sendError;
            }
            this.sent.push(attachments.length ? { userId, text, attachments } : { userId, text });
            this.options.push(options);
        },
        async sendToChat(chatId, text, attachments = [], options = {}) {
            this.chats.push(attachments.length ? { chatId, text, attachments } : { chatId, text });
            this.options.push(options);
        },
        async sendToAll(text, attachments = [], options = {}) {
            this.broadcasts.push(attachments.length ? { text, attachments } : text);
            this.options.push(options);
            return this.summary;
        },
        async answerCallback(userId, text) {
            if (this.answerError) {
                throw this.answerError;
            }
            this.answered.push({ userId, text });
        },
        edits: [],
        deletes: [],
        asks: [],
        notifications: [],
        actionError: null,
        askResult: { data: '0', text: 'Yes', userId: 5, chatId: 0, messageId: 'mid.9' },
        notifySummary: { sent: 1, failed: 0, skipped: 0, messages: [], failures: [] },
        async editMessage(messageId, text, keyboard, options) {
            if (this.actionError) {
                throw this.actionError;
            }
            this.edits.push({ messageId, text, keyboard, options });
        },
        async deleteMessage(messageId) {
            if (this.actionError) {
                throw this.actionError;
            }
            this.deletes.push(messageId);
        },
        async ask(target, text, answers, options) {
            if (this.actionError) {
                throw this.actionError;
            }
            this.asks.push({ target, text, answers, options });
            return this.askResult;
        },
        async notifyAll(text, options) {
            this.notifications.push({ text, options });
            return this.notifySummary;
        },
        stop() {
            this.stopped = true;
        },
    };
}

describe('main.js', () => {
    describe('parseSendValue', () => {
        it('splits "userId|text"', () => {
            assert.deepEqual(parseSendValue('123|Hello'), { userId: '123', text: 'Hello' });
            assert.deepEqual(parseSendValue(' 123 | Hello | World '), { userId: '123', text: 'Hello | World' });
        });

        it('sends a negative prefix to a group chat, never as broadcast', () => {
            assert.deepEqual(parseSendValue('-987654321012|Hello group'), {
                userId: null,
                chatId: '-987654321012',
                text: 'Hello group',
            });
        });

        it('treats text with a non-numeric prefix as a broadcast', () => {
            assert.deepEqual(parseSendValue('Status|ok'), { userId: null, text: 'Status|ok' });
        });

        it('treats plain text as a broadcast', () => {
            assert.deepEqual(parseSendValue('  Hello everyone '), { userId: null, text: 'Hello everyone' });
        });
    });

    describe('parseSendRequest', () => {
        it('reads recipient, text and attachments', () => {
            assert.deepEqual(parseSendRequest({ userId: 5, text: ' Hi ', image: '/a.jpg' }), {
                userId: '5',
                text: 'Hi',
                media: [{ type: 'image', source: '/a.jpg' }],
            });
        });

        it('reads a chat id', () => {
            const request = parseSendRequest({ chatId: -100, text: 'Hi' });
            assert.equal(request.chatId, '-100');
            assert.equal(request.userId, null);
        });

        it('takes a negative user id as chat id', () => {
            assert.equal(parseSendRequest({ userId: -100, text: 'Hi' }).chatId, '-100');
        });

        it('rejects userId and chatId together', () => {
            assert.throws(() => parseSendRequest({ userId: 5, chatId: -100, text: 'Hi' }), /either userId or chatId/);
        });

        it('adds an inline keyboard', () => {
            const request = parseSendRequest({ userId: 5, text: 'Menu', keyboard: [['Pool', 'Light']] });
            assert.equal(request.keyboard.type, 'inline_keyboard');
            assert.equal(request.keyboard.payload.buttons[0].length, 2);
        });

        it('rejects an invalid keyboard', () => {
            assert.throws(() => parseSendRequest({ text: 'x', keyboard: 'Pool' }), /Invalid keyboard/);
        });

        it('treats a string as a broadcast', () => {
            assert.deepEqual(parseSendRequest('Hi'), { userId: null, text: 'Hi', media: [] });
        });
    });

    describe('parseStateValue', () => {
        it('reads a JSON object', () => {
            assert.deepEqual(parseStateValue('{"userId":7,"file":"/r.pdf"}'), {
                userId: '7',
                text: '',
                media: [{ type: 'file', source: '/r.pdf' }],
            });
        });

        it('sends text that only looks like JSON as text', () => {
            assert.deepEqual(parseStateValue('{status} ok'), { userId: null, text: '{status} ok', media: [] });
        });

        it('keeps the "userId|text" format', () => {
            assert.deepEqual(parseStateValue('12|Hi'), { userId: '12', text: 'Hi', media: [] });
        });
    });

    describe('onStateChange', () => {
        let adapter;
        let manager;

        beforeEach(() => {
            adapter = createAdapter();
            manager = createManagerMock();
            adapter.botManager = manager;
        });

        it('ignores acknowledged and deleted states', async () => {
            await adapter.onStateChange('max.0.message.send', { val: '1|hi', ack: true });
            await adapter.onStateChange('max.0.message.send', null);
            assert.equal(manager.sent.length, 0);
            assert.equal(adapter.states.size, 0);
        });

        it('sends "userId|text" to one user and resets the state', async () => {
            await adapter.onStateChange('max.0.message.send', { val: '123|Hello', ack: false });
            assert.deepEqual(manager.sent, [{ userId: '123', text: 'Hello' }]);
            assert.equal(adapter.states.get('message.send'), '');
        });

        it('broadcasts plain text', async () => {
            await adapter.onStateChange('max.0.message.send', { val: 'Hello all', ack: false });
            assert.deepEqual(manager.broadcasts, ['Hello all']);
        });

        it('sends nothing for empty text but resets the state', async () => {
            await adapter.onStateChange('max.0.message.send', { val: '123|  ', ack: false });
            assert.equal(manager.sent.length, 0);
            assert.equal(manager.broadcasts.length, 0);
            assert.equal(adapter.states.get('message.send'), '');
        });

        it('sends users.<id>.send to that user and resets the state', async () => {
            await adapter.onStateChange('max.0.users.42.send', { val: ' Hi ', ack: false });
            assert.deepEqual(manager.sent, [{ userId: '42', text: 'Hi' }]);
            assert.equal(adapter.states.get('users.42.send'), '');
        });

        it('sends JSON with an image from message.send', async () => {
            await adapter.onStateChange('max.0.message.send', {
                val: '{"userId": 123, "text": "Door", "image": "/snap.jpg"}',
                ack: false,
            });
            assert.deepEqual(manager.sent, [
                { userId: '123', text: 'Door', attachments: [{ type: 'image', payload: { token: 'image:/snap.jpg' } }] },
            ]);
            assert.equal(adapter.states.get('message.send'), '');
        });

        it('broadcasts JSON without userId', async () => {
            await adapter.onStateChange('max.0.message.send', { val: '{"image": "/snap.jpg"}', ack: false });
            assert.equal(manager.broadcasts.length, 1);
            assert.equal(manager.broadcasts[0].attachments.length, 1);
        });

        it('sends JSON from users.<id>.send to that user, ignoring another userId', async () => {
            await adapter.onStateChange('max.0.users.42.send', { val: '{"userId": 1, "file": "/r.pdf"}', ack: false });
            assert.equal(manager.sent[0].userId, '42');
            assert.equal(manager.sent[0].attachments[0].type, 'file');
            assert.equal(adapter.states.get('users.42.send'), '');
        });

        it('keeps "|" in the text of users.<id>.send', async () => {
            await adapter.onStateChange('max.0.users.42.send', { val: '5|5', ack: false });
            assert.deepEqual(manager.sent, [{ userId: '42', text: '5|5' }]);
        });

        it('logs an invalid attachment and resets the state', async () => {
            await adapter.onStateChange('max.0.message.send', { val: '{"userId": 1, "image": 5}', ack: false });
            assert.equal(manager.sent.length, 0);
            assert.match(adapter.logs.error[0], /Invalid image/);
            assert.equal(adapter.states.get('message.send'), '');
        });

        it('answers the user of the last request via communicate.response', async () => {
            adapter.states.set('communicate.requestUserId', 77);
            await adapter.onStateChange('max.0.communicate.response', { val: 'Pool: 1.2 m', ack: false });
            assert.deepEqual(manager.sent, [{ userId: '77', text: 'Pool: 1.2 m' }]);
            assert.equal(adapter.states.get('communicate.response'), '');
        });

        it('accepts JSON with a keyboard in communicate.response', async () => {
            adapter.states.set('communicate.requestUserId', 77);
            await adapter.onStateChange('max.0.communicate.response', {
                val: '{"text": "Menu", "keyboard": [["Pool"]]}',
                ack: false,
            });
            assert.equal(manager.sent[0].userId, '77');
            assert.equal(manager.sent[0].attachments[0].type, 'inline_keyboard');
        });

        it('answers in the group chat of the last request via communicate.response', async () => {
            adapter.states.set('communicate.requestChatId', -100);
            adapter.states.set('communicate.requestUserId', 77);
            await adapter.onStateChange('max.0.communicate.response', { val: 'Pool: 1.2 m', ack: false });
            assert.deepEqual(manager.chats, [{ chatId: '-100', text: 'Pool: 1.2 m' }]);
            assert.deepEqual(manager.sent, []);
        });

        it('sends "-chatId|text" from message.send to the group chat', async () => {
            await adapter.onStateChange('max.0.message.send', { val: '-100|Hello group', ack: false });
            assert.deepEqual(manager.chats, [{ chatId: '-100', text: 'Hello group' }]);
            assert.deepEqual(manager.broadcasts, []);
        });

        it('sends chats.<chatId>.send to that chat', async () => {
            await adapter.onStateChange('max.0.chats.-100.send', { val: '{"text": "Door", "image": "/snap.jpg"}', ack: false });
            assert.equal(manager.chats[0].chatId, '-100');
            assert.equal(manager.chats[0].attachments[0].type, 'image');
            assert.equal(adapter.states.get('chats.-100.send'), '');
        });

        it('ignores communicate.response before the first request', async () => {
            await adapter.onStateChange('max.0.communicate.response', { val: 'Hi', ack: false });
            assert.equal(manager.sent.length, 0);
            assert.match(adapter.logs.warn[0], /no request yet/);
            assert.equal(adapter.states.get('communicate.response'), '');
        });

        it('ignores states of other instances', async () => {
            await adapter.onStateChange('max.1.users.42.send', { val: 'Hi', ack: false });
            await adapter.onStateChange('max.1.message.send', { val: 'Hi', ack: false });
            assert.equal(manager.sent.length, 0);
            assert.equal(manager.broadcasts.length, 0);
        });
    });

    describe('onMessage', () => {
        let adapter;
        let manager;

        beforeEach(() => {
            adapter = createAdapter();
            manager = createManagerMock();
            adapter.botManager = manager;
        });

        /**
         * @param {unknown} message - payload of sendTo
         * @param {string} [command] - command
         * @returns {object} message object as delivered by the js-controller
         */
        function msg(message, command = 'send') {
            return { command, message, from: 'system.adapter.javascript.0', callback: { id: 1 } };
        }

        it('sends to a single user and answers with the result', async () => {
            await adapter.onMessage(msg({ userId: 123, text: 'Hi' }));
            assert.deepEqual(manager.sent, [{ userId: '123', text: 'Hi' }]);
            assert.deepEqual(adapter.replies[0].message, { result: 'sent', messageId: null });
            assert.equal(adapter.replies[0].to, 'system.adapter.javascript.0');
        });

        it('broadcasts a string and returns the delivery summary', async () => {
            await adapter.onMessage(msg('Hello'));
            assert.deepEqual(manager.broadcasts, ['Hello']);
            assert.deepEqual(adapter.replies[0].message, { result: 'sent', sent: 2, failed: 0, skipped: 0 });
        });

        it('broadcasts an object without userId', async () => {
            await adapter.onMessage(msg({ text: 'Hello' }));
            assert.deepEqual(manager.broadcasts, ['Hello']);
        });

        it('reports a failed delivery instead of "sent"', async () => {
            manager.sendError = new Error('user blocked the bot');
            await adapter.onMessage(msg({ userId: 1, text: 'Hi' }));
            assert.deepEqual(adapter.replies[0].message, { error: 'user blocked the bot' });
        });

        it('reports a broadcast that reached nobody', async () => {
            manager.summary = { sent: 0, failed: 0, skipped: 0 };
            await adapter.onMessage(msg('Hello'));
            assert.equal(adapter.replies[0].message.error, 'No known users');
        });

        it('reports a disabled broadcast', async () => {
            adapter.config.sendToAllUsers = false;
            await adapter.onMessage(msg('Hello'));
            assert.deepEqual(manager.broadcasts, []);
            assert.deepEqual(adapter.replies[0].message, { error: 'sendToAllUsers is disabled' });
        });

        it('answers an empty message instead of letting the caller time out', async () => {
            await adapter.onMessage(msg(undefined));
            await adapter.onMessage(msg({ userId: 1 }));
            await adapter.onMessage(msg('   '));
            assert.equal(manager.sent.length, 0);
            assert.equal(adapter.replies.length, 3);
            assert.ok(adapter.replies.every(r => r.message.error === 'No text or attachment given'));
        });

        it('sends attachments without text', async () => {
            await adapter.onMessage(msg({ userId: 9, image: ['/a.jpg', '/b.jpg'], audio: '/c.ogg' }));
            assert.deepEqual(manager.prepared, [
                [
                    { type: 'image', source: '/a.jpg' },
                    { type: 'image', source: '/b.jpg' },
                    { type: 'audio', source: '/c.ogg' },
                ],
            ]);
            assert.equal(manager.sent[0].text, '');
            assert.equal(manager.sent[0].attachments.length, 3);
            assert.deepEqual(adapter.replies[0].message, { result: 'sent', messageId: null });
        });

        it('reports an attachment that cannot be uploaded', async () => {
            manager.prepareError = new Error('Cannot attach image /a.jpg: Cannot read /a.jpg: ENOENT');
            await adapter.onMessage(msg({ userId: 9, image: '/a.jpg' }));
            assert.equal(manager.sent.length, 0);
            assert.match(adapter.replies[0].message.error, /ENOENT/);
        });

        it('rejects an invalid attachment', async () => {
            await adapter.onMessage(msg({ userId: 9, video: { path: '/x' } }));
            assert.match(adapter.replies[0].message.error, /Invalid video/);
        });

        it('does not upload a broadcast that is disabled', async () => {
            adapter.config.sendToAllUsers = false;
            await adapter.onMessage(msg({ image: '/a.jpg' }));
            assert.deepEqual(manager.prepared, []);
            assert.deepEqual(adapter.replies[0].message, { error: 'sendToAllUsers is disabled' });
        });

        it('sends a keyboard after the uploaded attachments', async () => {
            await adapter.onMessage(msg({ userId: 9, text: 'Menu', image: '/a.jpg', keyboard: [['Pool']] }));
            const types = manager.sent[0].attachments.map(a => a.type);
            assert.deepEqual(types, ['image', 'inline_keyboard']);
        });

        it('sends a keyboard without uploads', async () => {
            await adapter.onMessage(msg({ userId: 9, text: 'Menu', keyboard: [['Pool', { text: 'Gate', callback: 'g' }]] }));
            assert.deepEqual(manager.prepared, []);
            assert.equal(manager.sent[0].attachments[0].payload.buttons[0][1].type, 'callback');
        });

        it('sends without notification on notify: false', async () => {
            await adapter.onMessage(msg({ chatId: -100, text: 'quiet', notify: false }));
            assert.deepEqual(manager.options, [{ notify: false }]);
        });

        it('accepts disable_notification of the Telegram adapter', async () => {
            await adapter.onMessage(msg({ userId: 5, text: 'quiet', disable_notification: true }));
            await adapter.onMessage(msg('broadcast'));
            assert.deepEqual(manager.options, [{ notify: false }, {}]);
        });

        it('keeps notifications by default and for disable_notification: false', async () => {
            await adapter.onMessage(msg({ userId: 5, text: 'loud', disable_notification: false }));
            assert.deepEqual(manager.options, [{}]);
        });

        it('sends JSON state values silently', async () => {
            await adapter.onStateChange('max.0.users.42.send', { val: '{"text": "quiet", "notify": false}', ack: false });
            assert.deepEqual(manager.options, [{ notify: false }]);
        });

        it('sends to a group chat with sendTo', async () => {
            await adapter.onMessage(msg({ chatId: -100, text: 'Hi', keyboard: [['Pool']] }));
            assert.equal(manager.chats[0].chatId, '-100');
            assert.equal(manager.chats[0].attachments[0].type, 'inline_keyboard');
            assert.deepEqual(adapter.replies[0].message, { result: 'sent', messageId: null });
        });

        it('sends to a group chat even when broadcasts are disabled', async () => {
            adapter.config.sendToAllUsers = false;
            await adapter.onMessage(msg({ chatId: -100, text: 'Hi' }));
            assert.equal(manager.chats.length, 1);
        });

        it('answers a button press', async () => {
            await adapter.onMessage(msg({ userId: 9, text: 'Gate opens' }, 'answerCallback'));
            assert.deepEqual(manager.answered, [{ userId: '9', text: 'Gate opens' }]);
            assert.deepEqual(adapter.replies[0].message, { result: 'answered' });
        });

        it('reports an answer without userId or text', async () => {
            await adapter.onMessage(msg({ userId: 9 }, 'answerCallback'));
            assert.deepEqual(adapter.replies[0].message, { error: 'answerCallback needs userId and text' });
        });

        it('reports a failed answer', async () => {
            manager.answerError = new Error('No button press of user 9 to answer');
            await adapter.onMessage(msg({ userId: 9, text: 'x' }, 'answerCallback'));
            assert.match(adapter.replies[0].message.error, /No button press/);
        });

        it('answers an unknown command', async () => {
            await adapter.onMessage(msg('x', 'foo'));
            assert.deepEqual(adapter.replies[0].message, { error: 'Unknown command: foo' });
        });

        it('reports a bot that is not running', async () => {
            adapter.botManager = null;
            await adapter.onMessage(msg({ userId: 1, text: 'Hi' }));
            assert.deepEqual(adapter.replies[0].message, { error: 'Bot not initialized' });
        });

        it('works without a callback', async () => {
            await adapter.onMessage({ command: 'send', message: 'Hello', from: 'x' });
            assert.deepEqual(manager.broadcasts, ['Hello']);
            assert.equal(adapter.replies.length, 0);
        });
    });

    describe('_startBot', () => {
        it('logs ready when the bot started', async () => {
            const adapter = createAdapter();
            adapter.botManager = { start: async () => {} };
            await adapter._startBot();
            assert.ok(adapter.logs.info.includes('MAX adapter ready'));
            assert.equal(adapter.timers.length, 0);
        });

        it('retries a start that failed because of the network', async () => {
            const adapter = createAdapter();
            let calls = 0;
            adapter.botManager = {
                start: async () => {
                    calls++;
                    throw new TypeError('fetch failed');
                },
            };
            await adapter._startBot();
            assert.equal(adapter.timers.length, 1);
            assert.equal(adapter.timers[0].ms, 60000);
            assert.match(adapter.logs.error[0], /fetch failed/);
            adapter.timers[0].fn();
            await new Promise(resolve => setTimeout(resolve, 10));
            assert.equal(calls, 2);
        });

        it('does not retry a rejected token', async () => {
            const adapter = createAdapter();
            adapter.botManager = {
                start: async () => {
                    throw Object.assign(new Error('Unauthorized'), { status: 401 });
                },
            };
            await adapter._startBot();
            assert.equal(adapter.timers.length, 0);
            assert.match(adapter.logs.error[0], /token was rejected/);
        });

        it('stays silent when the adapter is unloading', async () => {
            const adapter = createAdapter();
            adapter.botManager = {
                start: async () => {
                    adapter.unloading = true;
                    throw new Error('aborted');
                },
            };
            await adapter._startBot();
            assert.equal(adapter.timers.length, 0);
            assert.equal(adapter.logs.error.length, 0);
        });
    });

    describe('onUnload', () => {
        it('stops the bot, cancels a pending start and resets info.connection', async () => {
            const adapter = createAdapter();
            const manager = createManagerMock();
            const timer = { cleared: false };
            adapter.botManager = manager;
            adapter.startTimer = timer;
            let called = false;
            await adapter.onUnload(() => (called = true));
            assert.equal(called, true);
            assert.equal(manager.stopped, true);
            assert.equal(timer.cleared, true);
            assert.equal(adapter.botManager, null);
            assert.equal(adapter.unloading, true);
            assert.equal(adapter.states.get('info.connection'), false);
        });
    });

    describe('voiceDir', () => {
        it('uses max_<instance>/voice below the ioBroker data folder', () => {
            const adapter = createAdapter();
            adapter.instance = 1;
            const dir = adapter.voiceDir().split(require('node:path').sep).join('/');
            assert.equal(dir, '/opt/iobroker/iobroker-data/max_1/voice');
        });
    });

    describe('photoDir', () => {
        it('uses max_<instance>/photo below the ioBroker data folder', () => {
            const adapter = createAdapter();
            adapter.instance = 1;
            const dir = adapter.photoDir().split(require('node:path').sep).join('/');
            assert.equal(dir, '/opt/iobroker/iobroker-data/max_1/photo');
        });
    });

    describe('io-package.json and admin', () => {
        const root = path.join(__dirname, '..');
        const ioPackage = JSON.parse(fs.readFileSync(path.join(root, 'io-package.json'), 'utf8'));
        const jsonConfig = JSON.parse(fs.readFileSync(path.join(root, 'admin/jsonConfig.json'), 'utf8'));

        it('enables the messagebox so that sendTo() reaches the adapter', () => {
            assert.equal(ioPackage.common.messagebox, true);
        });

        it('hides the bot token in the admin', () => {
            assert.equal(jsonConfig.items.token.type, 'password');
        });

        it('lists the communicate objects of the code as instance objects', () => {
            for (const obj of [...GROUP_OBJECTS, ...COMMUNICATE_OBJECTS]) {
                const listed = ioPackage.instanceObjects.find(o => o._id === obj._id);
                assert.deepEqual(listed, obj, obj._id);
            }
        });

        it('describes message.send like the code does', () => {
            const obj = ioPackage.instanceObjects.find(o => o._id === 'message.send');
            assert.equal(obj.common.name, 'Send message (format: userId|text, -chatId|text, plain text to all users, or JSON)');
        });

        it('has the same keys in all admin translations and no untranslated text', () => {
            const dir = path.join(root, 'admin/i18n');
            const en = JSON.parse(fs.readFileSync(path.join(dir, 'en.json'), 'utf8'));
            const keys = Object.keys(en).sort();
            for (const lang of ['de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn']) {
                const texts = JSON.parse(fs.readFileSync(path.join(dir, `${lang}.json`), 'utf8'));
                assert.deepEqual(Object.keys(texts).sort(), keys, lang);
                for (const key of keys) {
                    assert.notEqual(texts[key], en[key], `${lang}.${key} is still English`);
                }
            }
        });

        it('uses only translation keys that the admin config references', () => {
            const en = JSON.parse(fs.readFileSync(path.join(root, 'admin/i18n/en.json'), 'utf8'));
            const used = new Set();
            for (const item of Object.values(jsonConfig.items)) {
                for (const attr of ['label', 'text', 'tooltip', 'help']) {
                    if (item[attr]) {
                        used.add(item[attr]);
                    }
                }
            }
            assert.deepEqual(Object.keys(en).sort(), [...used].sort());
        });
    });
});

describe('main.js 0.2.0: format, message ids, edit/delete, ask, notifications', () => {
    let adapter;
    let manager;

    beforeEach(() => {
        adapter = createAdapter();
        manager = createManagerMock();
        adapter.botManager = manager;
    });

    /**
     * @param {unknown} message - payload
     * @param {string} [command] - command
     * @returns {object} message object
     */
    function msg(message, command = 'send') {
        return { command, message, from: 'system.adapter.javascript.0', callback: { id: 1 } };
    }

    describe('format', () => {
        it('reads format and parse_mode', () => {
            assert.equal(parseSendRequest({ userId: 5, text: 'x', format: 'html' }).format, 'html');
            assert.equal(parseSendRequest({ userId: 5, text: 'x', parse_mode: 'MarkdownV2' }).format, 'markdown');
            assert.equal(parseSendRequest({ userId: 5, text: 'x' }).format, undefined);
        });

        it('passes the format to the bot', async () => {
            await adapter.onMessage(msg({ userId: 5, text: '<b>x</b>', format: 'html', keyboard: [['A']] }));
            assert.deepEqual(manager.options, [{ format: 'html' }]);
            assert.equal(manager.sent[0].attachments[0].type, 'inline_keyboard');
        });

        it('takes the format from JSON in message.send', async () => {
            await adapter.onStateChange('max.0.message.send', {
                val: '{"userId": 5, "text": "**x**", "format": "markdown"}',
                ack: false,
            });
            assert.deepEqual(manager.options, [{ format: 'markdown' }]);
        });

        it('rejects an unknown format', async () => {
            await adapter.onMessage(msg({ userId: 5, text: 'x', format: 'rtf' }));
            assert.match(adapter.replies[0].message.error, /Invalid format/);
            assert.equal(manager.sent.length, 0);
        });
    });

    describe('message ids', () => {
        it('answers with the id of the sent message', async () => {
            manager.sendMessage = async () => 'mid.42';
            await adapter.onMessage(msg({ userId: 5, text: 'x' }));
            assert.deepEqual(adapter.replies[0].message, { result: 'sent', messageId: 'mid.42' });
        });

        it('answers with the id of a message to a group chat', async () => {
            manager.sendToChat = async () => 'mid.43';
            await adapter.onMessage(msg({ chatId: -100, text: 'x' }));
            assert.deepEqual(adapter.replies[0].message, { result: 'sent', messageId: 'mid.43' });
        });

        it('passes the ids and failures of a broadcast on', async () => {
            manager.summary = {
                sent: 1,
                failed: 1,
                skipped: 0,
                messages: [{ userId: 1, messageId: 'mid.1' }],
                failures: [{ userId: 2, error: '404: Chat not found' }],
            };
            await adapter.onMessage(msg('hello'));
            assert.deepEqual(adapter.replies[0].message, { result: 'sent', ...manager.summary });
        });
    });

    describe('editMessage', () => {
        it('edits text, format and keyboard', async () => {
            await adapter.onMessage(msg({ messageId: 'mid.1', text: 'new', format: 'html', keyboard: [['A']] }, 'editMessage'));
            assert.equal(manager.edits[0].messageId, 'mid.1');
            assert.equal(manager.edits[0].text, 'new');
            assert.deepEqual(manager.edits[0].options, { format: 'html' });
            assert.equal(manager.edits[0].keyboard.type, 'inline_keyboard');
            assert.deepEqual(adapter.replies[0].message, { result: 'edited', messageId: 'mid.1' });
        });

        it('removes the keyboard with keyboard: null and keeps it without keyboard', async () => {
            await adapter.onMessage(msg({ messageId: 'mid.1', keyboard: null }, 'editMessage'));
            await adapter.onMessage(msg({ messageId: 'mid.1', text: 'only text' }, 'editMessage'));
            assert.equal(manager.edits[0].keyboard, null);
            assert.equal(manager.edits[0].text, undefined);
            assert.equal(manager.edits[1].keyboard, undefined);
        });

        it('reports missing data and errors', async () => {
            await adapter.onMessage(msg({ text: 'x' }, 'editMessage'));
            await adapter.onMessage(msg({ messageId: 'mid.1' }, 'editMessage'));
            await adapter.onMessage(msg({ messageId: 'mid.1', text: 'x', keyboard: 'bad' }, 'editMessage'));
            manager.actionError = new Error('404: Message not found');
            await adapter.onMessage(msg({ messageId: 'mid.1', text: 'x' }, 'editMessage'));
            assert.deepEqual(
                adapter.replies.map(r => r.message.error),
                [
                    'editMessage needs messageId',
                    'editMessage needs text or keyboard',
                    'Invalid keyboard: expected a list of rows',
                    '404: Message not found',
                ],
            );
        });
    });

    describe('deleteMessage', () => {
        it('deletes a message', async () => {
            await adapter.onMessage(msg({ messageId: 'mid.1' }, 'deleteMessage'));
            assert.deepEqual(manager.deletes, ['mid.1']);
            assert.deepEqual(adapter.replies[0].message, { result: 'deleted', messageId: 'mid.1' });
        });

        it('reports a missing messageId and errors of the MAX API', async () => {
            await adapter.onMessage(msg({}, 'deleteMessage'));
            manager.actionError = new Error('Delete failed: message.not.found');
            await adapter.onMessage(msg({ messageId: 'mid.1' }, 'deleteMessage'));
            assert.deepEqual(
                adapter.replies.map(r => r.message.error),
                ['deleteMessage needs messageId', 'Delete failed: message.not.found'],
            );
        });
    });

    describe('ask', () => {
        it('asks one user and answers with the pressed answer', async () => {
            await adapter.onMessage(msg({ userId: 5, text: 'Open?', answers: ['Yes', 'No'], timeout: 30, format: 'html' }, 'ask'));
            assert.deepEqual(manager.asks, [
                {
                    target: { userId: '5' },
                    text: 'Open?',
                    answers: ['Yes', 'No'],
                    options: { format: 'html', notify: undefined, timeout: 30 },
                },
            ]);
            assert.deepEqual(adapter.replies[0].message, manager.askResult);
        });

        it('asks a group chat', async () => {
            await adapter.onMessage(msg({ chatId: -100, text: 'Open?', answers: ['Yes'] }, 'ask'));
            assert.deepEqual(manager.asks[0].target, { chatId: '-100' });
        });

        it('needs a recipient and a text', async () => {
            await adapter.onMessage(msg({ text: 'Open?', answers: ['Yes'] }, 'ask'));
            await adapter.onMessage(msg({ userId: 5, answers: ['Yes'] }, 'ask'));
            manager.actionError = new Error('ask needs 1 to 30 answers');
            await adapter.onMessage(msg({ userId: 5, text: 'x', answers: [] }, 'ask'));
            assert.deepEqual(
                adapter.replies.map(r => r.message.error),
                ['ask needs userId or chatId', 'ask needs a text', 'ask needs 1 to 30 answers'],
            );
        });
    });

    describe('sendNotification', () => {
        const notification = {
            host: 'system.host.raspi',
            category: {
                name: 'Disk space',
                description: 'Low',
                instances: { 'system.adapter.backitup.0': { messages: [{ ts: 1, message: 'm' }] } },
            },
        };

        it('sends the notification as html without sound and answers { sent: true }', async () => {
            adapter.config.sendToAllUsers = false;
            await adapter.onMessage(msg(notification, 'sendNotification'));
            assert.equal(manager.notifications.length, 1);
            assert.match(manager.notifications[0].text, /^<b>Disk space<\/b>/);
            assert.deepEqual(manager.notifications[0].options, { format: 'html', notify: false });
            assert.deepEqual(adapter.replies[0].message, { sent: true });
            assert.equal(adapter.replies[0].command, 'sendNotification');
        });

        it('answers { sent: false } when nobody got it', async () => {
            manager.notifySummary = { sent: 0, failed: 1, skipped: 0, messages: [], failures: [] };
            await adapter.onMessage(msg(notification, 'sendNotification'));
            assert.deepEqual(adapter.replies[0].message, { sent: false });
        });

        it('answers { sent: false } without a running bot', async () => {
            adapter.botManager = null;
            await adapter.onMessage(msg(notification, 'sendNotification'));
            assert.deepEqual(adapter.replies[0].message, { sent: false });
        });
    });

    describe('io-package.json', () => {
        const ioPackage = require('../io-package.json');

        it('declares Blockly and notifications', () => {
            assert.equal(ioPackage.common.blockly, true);
            assert.deepEqual(ioPackage.common.supportedMessages, { notifications: true });
            assert.equal(ioPackage.common.messagebox, true);
        });
    });
});
