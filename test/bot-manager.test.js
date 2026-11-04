'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const BotManager = require('../lib/bot-manager');

/**
 * Create a minimal adapter mock for BotManager tests
 *
 * @param {object} [config] - adapter config overrides
 * @returns {object} mocked adapter
 */
function createAdapterMock(config = {}) {
    const states = new Map();
    const objects = new Map();
    const logs = { debug: [], info: [], warn: [], error: [] };

    return {
        namespace: 'max.0',
        config: {
            allowedUsers: '',
            sendToAllUsers: false,
            logUnknownCommands: false,
            ...config,
        },
        states,
        objects,
        logs,
        createdUsers: [],
        createdChats: [],
        viewRows: [],
        timers: [],
        writes: [],
        log: {
            debug: (msg) => logs.debug.push(msg),
            info: (msg) => logs.info.push(msg),
            warn: (msg) => logs.warn.push(msg),
            error: (msg) => logs.error.push(msg),
        },
        /**
         * @param {string} id - state id (without namespace)
         * @param {unknown} value - state value
         */
        async setStateAsync(id, value) {
            states.set(id, value);
            this.writes.push(id);
        },
        /**
         * @param {string} id - object id (without namespace)
         * @param {object} obj - object definition
         */
        async extendObjectAsync(id, obj) {
            objects.set(id, obj);
        },
        /**
         * @param {string|number} userId - user id
         * @param {string} username - display name
         */
        async ensureUserObjects(userId, username) {
            objects.set(`users.${userId}`, { name: username });
            this.createdUsers.push(String(userId));
        },
        /**
         * @param {string|number} chatId - chat id
         * @param {string} [title] - chat title
         */
        async ensureChatObjects(chatId, title) {
            objects.set(`chats.${chatId}`, { name: title });
            this.createdChats.push({ chatId: String(chatId), title });
        },
        /**
         * @param {string} _type - object type
         * @param {string} _subType - sub type
         * @param {object} options - view options with startkey/endkey
         * @returns {Promise<{rows: {id: string}[]}>} mocked object view
         */
        async getObjectViewAsync(_type, _subType, options) {
            return { rows: this.viewRows.filter((row) => row.id >= options.startkey && row.id < options.endkey) };
        },
        /**
         * Timers are only recorded; tests run them by hand
         *
         * @param {() => void} fn - callback
         * @param {number} ms - delay
         * @returns {object} timer handle
         */
        setTimeout(fn, ms) {
            const timer = { fn, ms, cleared: false };
            this.timers.push(timer);
            return timer;
        },
        /**
         * @param {object} timer - timer handle
         */
        clearTimeout(timer) {
            timer.cleared = true;
        },
    };
}

/**
 * Create a fake MAX bot with the API surface used by BotManager
 *
 * @returns {EventEmitter & object} fake bot
 */
function createBotMock() {
    const bot = new EventEmitter();
    bot.sent = [];
    bot.extras = [];
    bot.stopped = false;
    bot.errorHandler = null;
    bot.api = {
        /**
         * @param {number} userId - target user
         * @param {string} text - message text
         */
        async sendMessageToUser(userId, text, extra) {
            bot.sent.push({ userId, text });
            bot.extras.push(extra);
            return { body: { mid: `mid.${bot.sent.length}` } };
        },
        async sendMessageToChat(chatId, text, extra) {
            bot.sent.push({ chatId, text });
            bot.extras.push(extra);
            return { body: { mid: `mid.${bot.sent.length}` } };
        },
        async editMessage(messageId, extra) {
            bot.edited.push({ messageId, extra });
            return bot.actionResult;
        },
        async deleteMessage(messageId) {
            bot.deleted.push(messageId);
            return bot.actionResult;
        },
        async answerOnCallback(callbackId, extra) {
            bot.answers.push({ callbackId, extra });
            return { success: true };
        },
    };
    bot.edited = [];
    bot.deleted = [];
    bot.answers = [];
    bot.actionResult = { success: true };
    bot.catch = (handler) => {
        bot.errorHandler = handler;
    };
    bot.stop = () => {
        bot.stopped = true;
    };
    return bot;
}

/**
 * Wait until the pending async event handlers are finished
 *
 * @returns {Promise<void>} resolves after a short delay
 */
function flush() {
    return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('BotManager', () => {
    let adapter;
    let manager;

    beforeEach(() => {
        adapter = createAdapterMock();
        manager = new BotManager(adapter);
    });

    describe('_displayName', () => {
        it('prefers the full name', () => {
            assert.equal(manager._displayName({ user_id: 1, name: 'Max Mustermann', username: 'max' }), 'Max Mustermann');
        });

        it('falls back to the username', () => {
            assert.equal(manager._displayName({ user_id: 1, username: 'max' }), 'max');
        });

        it('falls back to the user id', () => {
            assert.equal(manager._displayName({ user_id: 42 }), '42');
        });

        it('handles missing users', () => {
            assert.equal(manager._displayName(null), 'unknown');
        });
    });

    describe('_isAllowed', () => {
        it('allows everyone when no list is configured', () => {
            assert.equal(manager._isAllowed(123), true);
        });

        it('allows everyone when the list is only whitespace', () => {
            adapter.config.allowedUsers = '   ';
            assert.equal(manager._isAllowed(123), true);
        });

        it('allows listed users and trims spaces', () => {
            adapter.config.allowedUsers = ' 111 , 222 ';
            assert.equal(manager._isAllowed(111), true);
            assert.equal(manager._isAllowed('222'), true);
        });

        it('blocks users that are not listed', () => {
            adapter.config.allowedUsers = '111,222';
            assert.equal(manager._isAllowed(333), false);
        });
    });

    describe('_logBlocked', () => {
        it('stays silent when logUnknownCommands is disabled', () => {
            manager._logBlocked(1, 'hello');
            assert.equal(adapter.logs.info.length, 0);
        });

        it('logs when logUnknownCommands is enabled', () => {
            adapter.config.logUnknownCommands = true;
            manager._logBlocked(1, 'hello');
            assert.equal(adapter.logs.info.length, 1);
            assert.match(adapter.logs.info[0], /unknown\/blocked user 1: hello/);
        });
    });

    describe('sendMessage', () => {
        it('throws when the bot was not started', async () => {
            await assert.rejects(() => manager.sendMessage(1, 'hi'), /Bot not started/);
        });

        it('throws for a non-numeric user id', async () => {
            manager.bot = createBotMock();
            await assert.rejects(() => manager.sendMessage('abc', 'hi'), /Invalid userId/);
        });

        it('throws for an empty or fractional user id', async () => {
            manager.bot = createBotMock();
            await assert.rejects(() => manager.sendMessage('', 'hi'), /Invalid userId/);
            await assert.rejects(() => manager.sendMessage('1.5', 'hi'), /Invalid userId/);
        });

        it('sends the message without registering the user as known', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            await manager.sendMessage('123', 'hi');
            assert.deepEqual(bot.sent, [{ userId: 123, text: 'hi' }]);
            assert.equal(manager.knownUsers.has('123'), false);
        });

        it('creates the user objects when a user contacted only by sendMessage writes later', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            manager.setupHandlers();
            await manager.sendMessage('123', 'hi');
            bot.emit('message_created', { user: { user_id: 123, name: 'Max' }, message: { body: { text: 'hello' } } });
            await flush();
            assert.deepEqual(adapter.createdUsers, ['123']);
            assert.equal(adapter.states.get('users.123.username'), 'Max');
        });
    });

    describe('sendToChat', () => {
        it('sends text and attachments to a group chat', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            await manager.sendToChat('-100', 'hi');
            await manager.sendToChat(-100, '', [{ type: 'image', payload: { token: 't' } }]);
            assert.deepEqual(bot.sent, [
                { chatId: -100, text: 'hi' },
                { chatId: -100, text: undefined },
            ]);
            assert.deepEqual(bot.extras[1], { attachments: [{ type: 'image', payload: { token: 't' } }] });
        });

        it('rejects an invalid chat id', async () => {
            manager.bot = createBotMock();
            await assert.rejects(() => manager.sendToChat('group', 'hi'), /Invalid chatId/);
        });

        it('throws when the bot was not started', async () => {
            await assert.rejects(() => manager.sendToChat(-1, 'hi'), /Bot not started/);
        });

        it('restores known chats from the object tree', async () => {
            adapter.viewRows = [{ id: 'max.0.chats.-100' }, { id: 'max.0.chats.-100.send' }];
            await manager._loadKnownChats();
            assert.deepEqual([...manager.knownChats], ['-100']);
        });
    });

    describe('answerCallback', () => {
        it('answers the last button press once', async () => {
            const bot = createBotMock();
            const answers = [];
            bot.api.answerOnCallback = async (id, extra) => answers.push({ id, extra });
            manager.bot = bot;
            manager.lastCallbacks.set('5', 'cb-1');
            await manager.answerCallback(5, 'Gate opens');
            assert.deepEqual(answers, [{ id: 'cb-1', extra: { notification: 'Gate opens' } }]);
            await assert.rejects(() => manager.answerCallback(5, 'again'), /No button press of user 5/);
        });

        it('throws when the bot was not started', async () => {
            await assert.rejects(() => manager.answerCallback(5, 'x'), /Bot not started/);
        });
    });

    describe('attachments', () => {
        it('sends prepared attachments with the message', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            const attachments = [{ type: 'image', payload: { token: 't' } }];
            await manager.sendMessage('5', '', attachments);
            assert.deepEqual(bot.sent, [{ userId: 5, text: undefined }]);
            assert.deepEqual(bot.extras, [{ attachments }]);
        });

        it('sends silently with notify: false', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            await manager.sendMessage('5', 'quiet', [], { notify: false });
            await manager.sendToChat('-100', 'quiet', [], { notify: false });
            assert.deepEqual(bot.sent, [
                { userId: 5, text: 'quiet' },
                { chatId: -100, text: 'quiet' },
            ]);
            assert.deepEqual(bot.extras, [{ notify: false }, { notify: false }]);
        });

        it('passes notify: false to every user of a broadcast', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            manager.knownUsers.add('1');
            manager.knownUsers.add('2');
            await manager.sendToAll('quiet', [], { notify: false });
            assert.deepEqual(bot.extras, [{ notify: false }, { notify: false }]);
        });

        it('sends text only without extra options', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            await manager.sendMessage('5', 'hi');
            assert.deepEqual(bot.extras, [undefined]);
        });

        it('uploads each attachment once and reuses it for a broadcast', async () => {
            const bot = createBotMock();
            const uploads = [];
            bot.api.raw = {
                uploads: {
                    getUploadUrl: async ({ type }) => {
                        uploads.push(type);
                        return { url: 'https://upload.example/u', token: `${type}-token` };
                    },
                },
            };
            manager.bot = bot;
            manager.http = {
                fetch: async () => ({ ok: true, status: 200, text: async () => '<retval>1</retval>' }),
            };
            const attachments = await manager.prepareAttachments([{ type: 'video', source: __filename }]);
            assert.deepEqual(attachments, [{ type: 'video', payload: { token: 'video-token' } }]);
            manager.knownUsers.add('1');
            manager.knownUsers.add('2');
            await manager.sendToAll('look', attachments);
            assert.deepEqual(uploads, ['video']);
            assert.equal(bot.extras.length, 2);
            assert.ok(bot.extras.every(extra => extra.attachments === attachments));
        });

        it('names the attachment that could not be prepared', async () => {
            manager.bot = createBotMock();
            await assert.rejects(
                () => manager.prepareAttachments([{ type: 'image', source: '/does/not/exist.jpg' }]),
                /Cannot attach image \/does\/not\/exist\.jpg: Cannot read/,
            );
        });

        it('throws when the bot was not started', async () => {
            await assert.rejects(() => manager.prepareAttachments([]), /Bot not started/);
        });
    });

    describe('sendToAll', () => {
        it('throws when the bot was not started', async () => {
            await assert.rejects(() => manager.sendToAll('hi'), /Bot not started/);
        });

        it('warns and does nothing without known users', async () => {
            manager.bot = createBotMock();
            await manager.sendToAll('hi');
            assert.equal(adapter.logs.warn.length, 1);
        });

        it('sends the broadcast to every known user', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            manager.knownUsers.add('1');
            manager.knownUsers.add('2');
            const summary = await manager.sendToAll('broadcast');
            assert.deepEqual({ ...summary, messages: undefined }, { sent: 2, failed: 0, skipped: 0, messages: undefined, failures: [] });
            assert.equal(summary.messages.length, 2);
            assert.deepEqual(
                bot.sent.map((entry) => entry.userId).sort(),
                [1, 2],
            );
            assert.equal(
                bot.sent.every((entry) => entry.text === 'broadcast'),
                true,
            );
        });

        it('keeps going when a single delivery fails', async () => {
            const bot = createBotMock();
            bot.api.sendMessageToUser = async (userId, text) => {
                if (userId === 1) {
                    throw new Error('blocked by user');
                }
                bot.sent.push({ userId, text });
            };
            manager.bot = bot;
            manager.knownUsers.add('1');
            manager.knownUsers.add('2');
            const summary = await manager.sendToAll('broadcast');
            assert.equal(summary.sent, 1);
            assert.equal(summary.failed, 1);
            assert.equal(summary.skipped, 0);
            assert.deepEqual(summary.failures, [{ userId: 1, error: 'blocked by user' }]);
            assert.deepEqual(bot.sent, [{ userId: 2, text: 'broadcast' }]);
            assert.equal(adapter.logs.warn.length, 1);
        });

        it('skips known users that are no longer allowed', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            adapter.config.allowedUsers = '2';
            manager.knownUsers.add('1');
            manager.knownUsers.add('2');
            const summary = await manager.sendToAll('broadcast');
            assert.equal(summary.sent, 1);
            assert.equal(summary.skipped, 1);
            assert.deepEqual(summary.failures, []);
            assert.deepEqual(bot.sent, [{ userId: 2, text: 'broadcast' }]);
        });

        it('warns when no known user is allowed', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            adapter.config.allowedUsers = '5';
            manager.knownUsers.add('1');
            const summary = await manager.sendToAll('broadcast');
            assert.deepEqual(summary, { sent: 0, failed: 0, skipped: 1, messages: [], failures: [] });
            assert.equal(bot.sent.length, 0);
            assert.equal(adapter.logs.warn.length, 1);
        });
    });

    describe('_handleNewUser', () => {
        it('creates the user objects once and stores the username', async () => {
            await manager._handleNewUser(7, 'Max');
            await manager._handleNewUser(7, 'Max');
            assert.deepEqual(adapter.createdUsers, ['7']);
            assert.equal(adapter.states.get('users.7.username'), 'Max');
        });

        it('falls back to the user id as username', async () => {
            await manager._handleNewUser(9, '');
            assert.equal(adapter.states.get('users.9.username'), '9');
        });
    });

    describe('_loadKnownUsers', () => {
        it('restores known users from the object tree', async () => {
            adapter.viewRows = [{ id: 'max.0.users.11' }, { id: 'max.0.users.22' }];
            await manager._loadKnownUsers();
            assert.deepEqual([...manager.knownUsers].sort(), ['11', '22']);
        });

        it('ignores nested objects below a user', async () => {
            adapter.viewRows = [{ id: 'max.0.users.11.last_message' }];
            await manager._loadKnownUsers();
            assert.equal(manager.knownUsers.size, 0);
        });

        it('logs a debug message when the view fails', async () => {
            adapter.getObjectViewAsync = async () => {
                throw new Error('no database');
            };
            await manager._loadKnownUsers();
            assert.equal(adapter.logs.debug.length, 1);
        });
    });

    describe('stop', () => {
        it('stops the bot and drops the reference', () => {
            const bot = createBotMock();
            manager.bot = bot;
            manager.stop();
            assert.equal(bot.stopped, true);
            assert.equal(manager.bot, null);
        });

        it('does nothing without a bot', () => {
            manager.stop();
            assert.equal(manager.bot, null);
        });
    });

    describe('event handlers', () => {
        let bot;

        beforeEach(() => {
            bot = createBotMock();
            manager.bot = bot;
            manager.setupHandlers();
        });

        it('handles bot_started', async () => {
            bot.emit('bot_started', { user: { user_id: 5, name: 'Max' } });
            await flush();
            assert.equal(adapter.states.get('users.5.started'), true);
            assert.equal(manager.knownUsers.has('5'), true);
        });

        it('handles message_created', async () => {
            bot.emit('message_created', {
                user: { user_id: 5, name: 'Max' },
                message: { body: { text: 'hello' } },
            });
            await flush();
            assert.equal(adapter.states.get('message.received'), 'hello');
            assert.equal(adapter.states.get('message.userId'), 5);
            assert.equal(adapter.states.get('users.5.last_message'), 'hello');
        });

        it('writes the sender before the text and publishes a Telegram-like request', async () => {
            bot.emit('message_created', {
                user: { user_id: 5, name: 'Alex' },
                message: { body: { text: 'pool', mid: 'mid.1' } },
            });
            await flush();
            const writes = adapter.writes;
            assert.ok(writes.indexOf('message.userId') < writes.indexOf('message.received'));
            assert.ok(writes.indexOf('communicate.requestUserId') < writes.indexOf('communicate.request'));
            assert.ok(writes.indexOf('communicate.requestMessageId') < writes.indexOf('communicate.request'));
            assert.equal(adapter.states.get('communicate.request'), '[Alex]pool');
            assert.equal(adapter.states.get('communicate.requestUserId'), 5);
            assert.equal(adapter.states.get('communicate.requestMessageId'), 'mid.1');
        });

        it('publishes a button press as request and remembers it for an answer', async () => {
            bot.emit('message_callback', {
                user: { user_id: 5, name: 'Alex' },
                callback: { payload: 'gate_open', callback_id: 'cb-1' },
            });
            await flush();
            assert.equal(adapter.states.get('communicate.request'), '[Alex]gate_open');
            assert.equal(manager.lastCallbacks.get('5'), 'cb-1');
        });

        it('keeps group messages in chats.<chatId> and does not register group members as users', async () => {
            bot.emit('message_created', {
                user: { user_id: 5, name: 'Alex' },
                message: { recipient: { chat_type: 'chat', chat_id: -100 }, body: { text: 'pool', mid: 'm1' } },
            });
            await flush();
            assert.deepEqual(adapter.createdUsers, []);
            assert.equal(manager.knownUsers.has('5'), false);
            assert.deepEqual(adapter.createdChats, [{ chatId: '-100', title: undefined }]);
            assert.equal(adapter.states.get('chats.-100.last_message'), 'pool');
            assert.equal(adapter.states.get('chats.-100.last_user_id'), 5);
            assert.equal(adapter.states.get('chats.-100.last_username'), 'Alex');
            assert.equal(adapter.states.has('users.5.last_message'), false);
            assert.equal(adapter.states.get('message.chatId'), -100);
            assert.equal(adapter.states.get('communicate.requestChatId'), -100);
            assert.equal(adapter.states.get('communicate.request'), '[Alex]pool');
            const writes = adapter.writes;
            assert.ok(writes.indexOf('message.chatId') < writes.indexOf('message.received'));
            assert.ok(writes.indexOf('communicate.requestChatId') < writes.indexOf('communicate.request'));
        });

        it('marks private messages with chat id 0', async () => {
            bot.emit('message_created', {
                user: { user_id: 5, name: 'Alex' },
                message: { recipient: { chat_type: 'dialog', chat_id: 777 }, body: { text: 'hi' } },
            });
            await flush();
            assert.equal(adapter.states.get('message.chatId'), 0);
            assert.equal(adapter.states.get('communicate.requestChatId'), 0);
            assert.equal(adapter.states.get('users.5.last_message'), 'hi');
            assert.deepEqual(adapter.createdChats, []);
        });

        it('applies the allowed list to group members', async () => {
            adapter.config.allowedUsers = '1';
            bot.emit('message_created', {
                user: { user_id: 5 },
                message: { recipient: { chat_type: 'chat', chat_id: -100 }, body: { text: 'hi' } },
            });
            await flush();
            assert.equal(adapter.states.size, 0);
        });

        it('stores a button press in a group in chats.<chatId>.callback_data', async () => {
            bot.emit('message_callback', {
                user: { user_id: 5, name: 'Alex' },
                callback: { payload: 'light', callback_id: 'cb' },
                message: { recipient: { chat_type: 'chat', chat_id: -100 }, body: { mid: 'm2' } },
            });
            await flush();
            assert.equal(adapter.states.get('chats.-100.callback_data'), 'light');
            assert.equal(adapter.states.has('users.5.callback_data'), false);
            assert.equal(adapter.states.get('communicate.requestChatId'), -100);
        });

        it('creates the chat objects with the title when the bot is added', async () => {
            bot.emit('bot_added', { chatId: -100, chat: { title: 'Family' } });
            await flush();
            assert.deepEqual(adapter.createdChats, [{ chatId: '-100', title: 'Family' }]);
            assert.equal(manager.knownChats.has('-100'), true);
        });

        it('handles message_callback', async () => {
            bot.emit('message_callback', {
                user: { user_id: 5, username: 'max' },
                callback: { payload: 'btn-1' },
            });
            await flush();
            assert.equal(adapter.states.get('users.5.callback_data'), 'btn-1');
        });

        it('blocks users that are not allowed', async () => {
            adapter.config.allowedUsers = '111';
            adapter.config.logUnknownCommands = true;
            bot.emit('message_created', { user: { user_id: 999 }, message: { body: { text: 'hello' } } });
            await flush();
            assert.equal(adapter.states.has('message.received'), false);
            assert.equal(adapter.logs.info.length, 1);
        });

        it('ignores events without a user', async () => {
            bot.emit('message_created', { message: { body: { text: 'hello' } } });
            await flush();
            assert.equal(adapter.states.size, 0);
        });

        it('logs errors thrown while handling a message', async () => {
            adapter.setStateAsync = async () => {
                throw new Error('database gone');
            };
            bot.emit('message_created', { user: { user_id: 5 }, message: { body: { text: 'hello' } } });
            await flush();
            assert.equal(adapter.logs.error.length, 1);
            assert.match(adapter.logs.error[0], /Failed to process message from 5/);
        });

        it('logs a failing bot_started handler', async () => {
            adapter.setStateAsync = async () => {
                throw new Error('database gone');
            };
            bot.emit('bot_started', { user: { user_id: 5 } });
            await flush();
            assert.equal(adapter.logs.error.length, 1);
            assert.match(adapter.logs.error[0], /Failed to process bot_started for 5/);
        });

        it('logs a failing message_callback handler', async () => {
            adapter.setStateAsync = async () => {
                throw new Error('database gone');
            };
            bot.emit('message_callback', { user: { user_id: 5 }, callback: { payload: 'btn' } });
            await flush();
            assert.equal(adapter.logs.error.length, 1);
            assert.match(adapter.logs.error[0], /Failed to process callback from 5/);
        });

        it('registers an error handler that keeps the adapter alive', () => {
            bot.errorHandler(new Error('socket closed'));
            assert.equal(adapter.logs.error.length, 1);
            assert.match(adapter.logs.error[0], /MAX bot error: socket closed/);
        });

        it('does not fail without a bot instance', () => {
            manager.bot = null;
            assert.doesNotThrow(() => manager.setupHandlers());
        });
    });
});

describe('BotManager lifecycle', () => {
    let adapter;
    let manager;
    let bots;

    /**
     * Fake bot whose start() behaves like the library: it only resolves when polling ends
     *
     * @returns {object} fake bot with polling controls
     */
    function createPollingBot() {
        const bot = createBotMock();
        bot.startCalls = [];
        bot.pollingStopped = false;
        bot.infoError = null;
        bot.api.getMyInfo = async () => {
            if (bot.infoError) {
                throw bot.infoError;
            }
            return { user_id: 1, username: 'test_bot' };
        };
        bot.updatesResult = { updates: [], marker: 1 };
        bot.updatesError = null;
        bot.api.getUpdates = async () => {
            if (bot.updatesError) {
                throw bot.updatesError;
            }
            return bot.updatesResult;
        };
        bot.start = (config) => {
            const call = { config };
            call.promise = new Promise((resolve, reject) => {
                call.resolve = resolve;
                call.reject = reject;
            });
            bot.startCalls.push(call);
            return call.promise;
        };
        bot.stopPolling = () => {
            bot.pollingStopped = true;
            const last = bot.startCalls[bot.startCalls.length - 1];
            if (last) {
                last.resolve();
            }
        };
        return bot;
    }

    beforeEach(() => {
        adapter = createAdapterMock();
        bots = [];
        manager = new BotManager(adapter, () => {
            const bot = createPollingBot();
            bots.push(bot);
            return bot;
        });
    });

    it('resolves start() while long polling keeps running and sets info.connection', async () => {
        await manager.start('token');
        const bot = bots[0];
        assert.equal(bot.startCalls.length, 1);
        assert.deepEqual(bot.startCalls[0].config, { mode: 'polling', options: { retry: false } });
        assert.deepEqual(bot.botInfo, { user_id: 1, username: 'test_bot' });
        assert.equal(adapter.states.get('info.connection'), true);
        assert.ok(adapter.logs.info.some((msg) => /MAX bot started successfully/.test(msg)));
    });

    it('rejects start() when the token is not accepted and does not poll', async () => {
        manager.createBot = () => {
            const bot = createPollingBot();
            bot.infoError = Object.assign(new Error('Unauthorized'), { status: 401 });
            bots.push(bot);
            return bot;
        };
        await assert.rejects(() => manager.start('bad'), /Unauthorized/);
        assert.equal(bots[0].startCalls.length, 0);
        assert.equal(adapter.states.has('info.connection'), false);
    });

    it('does not start polling when stopped while the token is verified', async () => {
        let release;
        manager.createBot = () => {
            const bot = createPollingBot();
            bot.api.getMyInfo = () => new Promise((resolve) => (release = resolve));
            bots.push(bot);
            return bot;
        };
        const starting = manager.start('token');
        await flush();
        manager.stop();
        release({ user_id: 1 });
        await starting;
        assert.equal(bots[0].startCalls.length, 0);
        assert.equal(adapter.states.has('info.connection'), false);
    });

    it('does not touch info.connection after a regular stop', async () => {
        await manager.start('token');
        adapter.states.clear();
        manager.stop();
        await flush();
        assert.equal(bots[0].pollingStopped, true);
        assert.equal(adapter.states.has('info.connection'), false);
        assert.equal(adapter.timers.length, 0);
        assert.equal(adapter.logs.warn.length, 0);
    });

    it('restarts polling with back-off when it ends unexpectedly', async () => {
        await manager.start('token');
        const bot = bots[0];
        bot.startCalls[0].resolve();
        await flush();
        assert.equal(adapter.states.get('info.connection'), false);
        assert.equal(adapter.timers.length, 1);
        assert.equal(adapter.timers[0].ms, 5000);
        assert.match(adapter.logs.warn[0], /long polling stopped unexpectedly/);

        adapter.timers[0].fn();
        assert.equal(bot.startCalls.length, 2);

        bot.startCalls[1].reject(new Error('boom'));
        await flush();
        assert.equal(adapter.timers[1].ms, 10000);
        assert.match(adapter.logs.warn[adapter.logs.warn.length - 1], /boom/);
    });

    it('cancels a pending restart on stop', async () => {
        await manager.start('token');
        bots[0].startCalls[0].resolve();
        await flush();
        manager.stop();
        assert.equal(adapter.timers[0].cleared, true);
        adapter.timers[0].fn();
        assert.equal(bots[0].startCalls.length, 1);
    });

    it('reports a lost and a restored connection from the polling requests', async () => {
        await manager.start('token');
        const bot = bots[0];

        bot.updatesError = new TypeError('fetch failed');
        await assert.rejects(() => bot.api.getUpdates([], {}), /fetch failed/);
        assert.equal(adapter.states.get('info.connection'), false);
        assert.ok(adapter.logs.warn.some((msg) => /Connection to the MAX API lost: fetch failed/.test(msg)));

        bot.updatesError = null;
        await bot.api.getUpdates([], {});
        assert.equal(adapter.states.get('info.connection'), true);
    });

    it('ignores aborted polling requests', async () => {
        await manager.start('token');
        const bot = bots[0];
        const abort = new Error('aborted');
        abort.name = 'AbortError';
        bot.updatesError = abort;
        await assert.rejects(() => bot.api.getUpdates([], {}));
        assert.equal(adapter.states.get('info.connection'), true);
    });

    it('replaces a running bot when start() is called again', async () => {
        await manager.start('token');
        await manager.start('token');
        assert.equal(bots.length, 2);
        assert.equal(bots[0].pollingStopped, true);
        assert.equal(manager.bot, bots[1]);
        assert.equal(adapter.states.get('info.connection'), true);
    });
});

describe('BotManager voice messages', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    let adapter;
    let manager;
    let bot;
    let tmpDir;
    let fetchCalls;

    /**
     * @param {number} status - HTTP status
     * @param {string} body - response body
     * @param {string} [type] - content type
     * @returns {object} minimal fetch response
     */
    function response(status, body, type = 'audio/ogg') {
        const buffer = Buffer.from(body);
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: name => (name.toLowerCase() === 'content-type' ? type : null) },
            arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length),
        };
    }

    /**
     * @param {object} [extra] - message fields
     * @returns {object} message_created context with a voice attachment
     */
    function voiceMessage(extra = {}) {
        return {
            user: { user_id: 5, name: 'Alex' },
            message: {
                recipient: { chat_type: 'dialog', chat_id: 777 },
                body: {
                    mid: 'mid.abc123',
                    text: '',
                    attachments: [{ type: 'audio', payload: { url: 'https://vu.example/voice?sig=1', token: 't' } }],
                    ...extra,
                },
            },
        };
    }

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iobroker-max-bm-voice-'));
        adapter = createAdapterMock();
        adapter.voiceDir = () => path.join(tmpDir, 'max_0', 'voice');
        manager = new BotManager(adapter);
        fetchCalls = [];
        manager.http = {
            fetch: async url => {
                fetchCalls.push(url);
                return response(200, 'OggS-voice');
            },
        };
        bot = createBotMock();
        manager.bot = bot;
        manager.setupHandlers();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    /**
     * Wait for the handler including the download
     *
     * @returns {Promise<void>} resolves when the handler is done
     */
    const settle = () => new Promise(resolve => setTimeout(resolve, 80));

    it('saves a pure voice message and publishes its path after the sender', async () => {
        bot.emit('message_created', voiceMessage());
        await settle();
        const file = adapter.states.get('communicate.pathFile');
        assert.match(file, /\/max_0\/voice\/mid\.abc123\.ogg$/);
        assert.equal(fs.readFileSync(file, 'utf8'), 'OggS-voice');
        assert.equal(adapter.states.get('communicate.requestUserId'), 5);
        assert.equal(adapter.states.get('communicate.requestChatId'), 0);
        assert.equal(adapter.states.get('communicate.requestMessageId'), 'mid.abc123');
        const w = adapter.writes;
        assert.ok(w.lastIndexOf('communicate.requestUserId') < w.indexOf('communicate.pathFile'));
        assert.ok(w.lastIndexOf('communicate.requestMessageId') < w.indexOf('communicate.pathFile'));
    });

    it('does not write empty text states for a pure voice message', async () => {
        bot.emit('message_created', voiceMessage());
        await settle();
        assert.equal(adapter.states.has('communicate.request'), false);
        assert.equal(adapter.states.has('message.received'), false);
        assert.equal(adapter.states.has('users.5.last_message'), false);
        assert.equal(adapter.states.get('message.userId'), 5);
    });

    it('publishes text and voice of a message with both', async () => {
        bot.emit('message_created', voiceMessage({ text: 'pool' }));
        await settle();
        assert.equal(adapter.states.get('communicate.request'), '[Alex]pool');
        assert.match(adapter.states.get('communicate.pathFile'), /\/voice\//);
    });

    it('ignores voice messages of users that are not allowed', async () => {
        adapter.config.allowedUsers = '111';
        bot.emit('message_created', voiceMessage());
        await settle();
        assert.deepEqual(fetchCalls, []);
        assert.equal(adapter.states.size, 0);
    });

    it('logs a failed download and publishes no path', async () => {
        manager.http.fetch = async () => response(403, 'denied');
        bot.emit('message_created', voiceMessage());
        await settle();
        assert.equal(adapter.states.has('communicate.pathFile'), false);
        assert.ok(adapter.logs.warn.some(msg => /Voice message from 5 could not be saved: .*HTTP 403/.test(msg)));
    });

    it('logs the attachment types without URLs', async () => {
        bot.emit('message_created', voiceMessage());
        await settle();
        const line = adapter.logs.debug.find(msg => msg.startsWith('Attachments of message'));
        assert.equal(line, 'Attachments of message mid.abc123: audio{payload:url,token}');
    });

    it('publishes the group chat of a voice message', async () => {
        const ctx = voiceMessage();
        ctx.message.recipient = { chat_type: 'chat', chat_id: -100 };
        bot.emit('message_created', ctx);
        await settle();
        assert.equal(adapter.states.get('communicate.requestChatId'), -100);
        assert.match(adapter.states.get('communicate.pathFile'), /\/voice\//);
        assert.equal(adapter.states.has('chats.-100.last_message'), false);
    });

    it('keeps only the newest voice files', async () => {
        const dir = adapter.voiceDir();
        fs.mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 25; i++) {
            const old = path.join(dir, `old${i}.ogg`);
            fs.writeFileSync(old, 'x');
            const t = new Date(Date.now() - (i + 1) * 60000);
            fs.utimesSync(old, t, t);
        }
        bot.emit('message_created', voiceMessage());
        await settle();
        const files = fs.readdirSync(dir);
        assert.equal(files.length, 20);
        assert.ok(files.includes('mid.abc123.ogg'));
    });
});

describe('BotManager 0.2.0: format, message ids, edit/delete, ask, notifications', () => {
    let adapter;
    let manager;
    let bot;

    beforeEach(() => {
        adapter = createAdapterMock();
        manager = new BotManager(adapter);
        bot = createBotMock();
        manager.bot = bot;
        manager.setupHandlers();
    });

    describe('format', () => {
        it('passes the format to the MAX API', async () => {
            await manager.sendMessage('5', '**bold**', [], { format: 'markdown' });
            assert.deepEqual(bot.extras, [{ format: 'markdown' }]);
        });

        it('passes the format together with keyboard and attachments', async () => {
            const keyboard = { type: 'inline_keyboard', payload: { buttons: [[{ type: 'message', text: 'A' }]] } };
            const image = { type: 'image', payload: { token: 't' } };
            await manager.sendToChat('-100', '<b>x</b>', [image, keyboard], { format: 'html', notify: false });
            assert.deepEqual(bot.extras, [{ attachments: [image, keyboard], format: 'html', notify: false }]);
        });

        it('sends plain text without format', async () => {
            await manager.sendMessage('5', 'plain');
            assert.deepEqual(bot.extras, [undefined]);
        });
    });

    describe('message ids', () => {
        it('returns the id of a sent message', async () => {
            assert.equal(await manager.sendMessage('5', 'a'), 'mid.1');
            assert.equal(await manager.sendToChat('-100', 'b'), 'mid.2');
        });

        it('returns null when MAX answers without a message', async () => {
            bot.api.sendMessageToUser = async () => undefined;
            assert.equal(await manager.sendMessage('5', 'a'), null);
        });

        it('lists the ids and the failed recipients of a broadcast', async () => {
            const original = bot.api.sendMessageToUser;
            bot.api.sendMessageToUser = async (userId, text, extra) => {
                if (userId === 2) {
                    throw new Error('404: Chat not found');
                }
                return original(userId, text, extra);
            };
            manager.knownUsers.add('1');
            manager.knownUsers.add('2');
            const summary = await manager.sendToAll('hi');
            assert.deepEqual(summary.messages, [{ userId: 1, messageId: 'mid.1' }]);
            assert.deepEqual(summary.failures, [{ userId: 2, error: '404: Chat not found' }]);
        });
    });

    describe('editMessage / deleteMessage', () => {
        it('edits text and format', async () => {
            await manager.editMessage('mid.7', 'new', undefined, { format: 'html' });
            assert.deepEqual(bot.edited, [{ messageId: 'mid.7', extra: { text: 'new', format: 'html' } }]);
        });

        it('replaces or removes the keyboard', async () => {
            const keyboard = { type: 'inline_keyboard', payload: { buttons: [[{ type: 'message', text: 'A' }]] } };
            await manager.editMessage('mid.7', undefined, keyboard);
            await manager.editMessage('mid.7', undefined, null);
            assert.deepEqual(bot.edited[0].extra, { attachments: [keyboard] });
            assert.deepEqual(bot.edited[1].extra, { attachments: [] });
        });

        it('deletes a message', async () => {
            await manager.deleteMessage('mid.7');
            assert.deepEqual(bot.deleted, ['mid.7']);
        });

        it('reports a failed action of the MAX API', async () => {
            bot.actionResult = { success: false, message: 'message.not.found' };
            await assert.rejects(() => manager.editMessage('mid.7', 'x'), /Edit failed: message.not.found/);
            await assert.rejects(() => manager.deleteMessage('mid.7'), /Delete failed: message.not.found/);
        });

        it('passes errors of the MAX API on', async () => {
            bot.api.deleteMessage = async () => {
                throw new Error('404: Message not found');
            };
            await assert.rejects(() => manager.deleteMessage('mid.x'), /404: Message not found/);
        });

        it('throws when the bot was not started', async () => {
            manager.bot = null;
            await assert.rejects(() => manager.editMessage('m', 'x'), /Bot not started/);
            await assert.rejects(() => manager.deleteMessage('m'), /Bot not started/);
        });
    });

    describe('ask', () => {
        /**
         * Payload of the n-th answer button of the last sent question
         *
         * @param {number} n - answer index
         * @returns {string} callback payload
         */
        const payloadOf = n => bot.extras[bot.extras.length - 1].attachments[0].payload.buttons[n][0].payload;

        it('sends the answers as callback buttons and resolves with the pressed one', async () => {
            const pending = manager.ask({ userId: '5' }, 'Open the gate?', ['Yes', 'No'], { format: 'markdown' });
            await flush();
            const extra = bot.extras[0];
            assert.equal(extra.format, 'markdown');
            assert.deepEqual(
                extra.attachments[0].payload.buttons.map(row => row[0].text),
                ['Yes', 'No'],
            );
            bot.emit('message_callback', {
                user: { user_id: 5, name: 'Alex' },
                callback: { payload: payloadOf(1), callback_id: 'cb-1' },
            });
            const answer = await pending;
            assert.deepEqual(answer, { data: '1', text: 'No', userId: 5, chatId: 0, messageId: 'mid.1' });
            assert.deepEqual(bot.answers, [{ callbackId: 'cb-1', extra: { notification: 'No' } }]);
            assert.equal(adapter.states.has('communicate.request'), false);
            assert.equal(manager.pendingAsks.size, 0);
        });

        it('ignores the answer of another user', async () => {
            const pending = manager.ask({ userId: '5' }, 'Q?', ['Yes'], { timeout: 1 });
            await flush();
            bot.emit('message_callback', { user: { user_id: 6 }, callback: { payload: payloadOf(0) } });
            await flush();
            assert.equal(manager.pendingAsks.size, 1);
            adapter.timers[0].fn();
            assert.deepEqual(await pending, { timeout: true, messageId: 'mid.1' });
        });

        it('takes the answer of any member of the asked group chat', async () => {
            const pending = manager.ask({ chatId: '-100' }, 'Q?', ['Yes']);
            await flush();
            bot.emit('message_callback', {
                user: { user_id: 9 },
                callback: { payload: payloadOf(0) },
                message: { recipient: { chat_type: 'chat', chat_id: -100 } },
            });
            const answer = await pending;
            assert.equal(answer.chatId, -100);
            assert.equal(answer.userId, 9);
        });

        it('times out with the configured timeout', async () => {
            const pending = manager.ask({ userId: '5' }, 'Q?', ['Yes'], { timeout: 30 });
            await flush();
            assert.equal(adapter.timers[0].ms, 30000);
            adapter.timers[0].fn();
            assert.deepEqual(await pending, { timeout: true, messageId: 'mid.1' });
        });

        it('answers open questions when the adapter stops', async () => {
            const pending = manager.ask({ userId: '5' }, 'Q?', ['Yes']);
            await flush();
            manager.stop();
            assert.deepEqual(await pending, { error: 'Adapter stopped' });
            assert.equal(adapter.timers[0].cleared, true);
        });

        it('ignores answers of finished questions', async () => {
            bot.emit('message_callback', { user: { user_id: 5 }, callback: { payload: 'max-ask:gone:0' } });
            await flush();
            assert.equal(adapter.states.has('communicate.request'), false);
            assert.ok(adapter.logs.debug.some(m => /no matching open question/.test(m)));
        });

        it('rejects questions without answers', async () => {
            await assert.rejects(() => manager.ask({ userId: '5' }, 'Q?', []), /1 to 30 answers/);
            await assert.rejects(() => manager.ask({ userId: '5' }, 'Q?', ['ok', ' ']), /every answer needs a text/);
        });
    });

    describe('notifyAll', () => {
        it('sends to the allowed users, even unknown ones, without sendToAllUsers', async () => {
            adapter.config.allowedUsers = '1, 2';
            adapter.config.sendToAllUsers = false;
            manager.knownUsers.add('3');
            const summary = await manager.notifyAll('<b>x</b>', { format: 'html', notify: false });
            assert.deepEqual(bot.sent.map(m => m.userId).sort(), [1, 2]);
            assert.deepEqual(bot.extras[0], { format: 'html', notify: false });
            assert.equal(summary.sent, 2);
        });

        it('sends to the known users without an allowed list', async () => {
            manager.knownUsers.add('7');
            const summary = await manager.notifyAll('x');
            assert.deepEqual(bot.sent.map(m => m.userId), [7]);
            assert.equal(summary.sent, 1);
        });

        it('reports when there is nobody to notify', async () => {
            const summary = await manager.notifyAll('x');
            assert.equal(summary.sent, 0);
            assert.ok(adapter.logs.warn.some(m => /No users to send the notification to/.test(m)));
        });
    });
});

describe('BotManager photos', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    let adapter;
    let manager;
    let bot;
    let tmpDir;
    let fetchCalls;
    let sequence;

    /**
     * @param {number} status - HTTP status
     * @param {Buffer} body - response body
     * @param {string | null} [type] - content type
     * @returns {object} minimal fetch response
     */
    function response(status, body, type = 'image/jpeg') {
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: name => (name.toLowerCase() === 'content-type' ? type : null) },
            arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length),
        };
    }

    /**
     * @param {object} [extra] - message body fields
     * @param {number} [count] - number of photos
     * @returns {object} message_created context with photo attachments
     */
    function photoMessage(extra = {}, count = 1) {
        const attachments = [];
        for (let i = 1; i <= count; i++) {
            attachments.push({ type: 'image', payload: { photo_id: i, token: 't', url: `https://i.example/p${i}?sig=1` } });
        }
        return {
            user: { user_id: 5, name: 'Alex' },
            message: {
                recipient: { chat_type: 'dialog', chat_id: 777 },
                body: { mid: 'mid.ph1', text: '', attachments, ...extra },
            },
        };
    }

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iobroker-max-bm-photo-'));
        adapter = createAdapterMock();
        adapter.photoDir = () => path.join(tmpDir, 'max_0', 'photo');
        adapter.voiceDir = () => path.join(tmpDir, 'max_0', 'voice');
        sequence = [];
        const setState = adapter.setStateAsync.bind(adapter);
        adapter.setStateAsync = async (id, value, ack) => {
            sequence.push([id, value]);
            await setState(id, value, ack);
        };
        manager = new BotManager(adapter);
        fetchCalls = [];
        manager.http = {
            fetch: async url => {
                fetchCalls.push(url);
                return response(200, JPEG);
            },
        };
        bot = createBotMock();
        manager.bot = bot;
        manager.setupHandlers();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    const settle = () => new Promise(resolve => setTimeout(resolve, 80));

    /**
     * Writes of the communicate states in their order
     *
     * @returns {unknown[][]} [id, value] pairs
     */
    const communicate = () => sequence.filter(([id]) => id.startsWith('communicate.'));

    it('publishes ids, then the photo path, then the caption — with the same message id', async () => {
        bot.emit('message_created', photoMessage({ text: 'what is this?' }));
        await settle();
        const w = communicate();
        const ids = w.map(([id]) => id);
        const firstPath = ids.indexOf('communicate.pathFile');
        assert.ok(firstPath > 0);
        assert.deepEqual(ids.slice(0, firstPath), [
            'communicate.requestChatId',
            'communicate.requestUserId',
            'communicate.requestMessageId',
        ]);
        assert.ok(ids.indexOf('communicate.request') > firstPath);
        assert.equal(ids[ids.length - 1], 'communicate.request');
        assert.deepEqual(
            w.filter(([id]) => id === 'communicate.requestMessageId').map(([, v]) => v),
            ['mid.ph1', 'mid.ph1'],
        );
        assert.match(adapter.states.get('communicate.pathFile'), /\/max_0\/photo\/mid\.ph1\.jpg$/);
        assert.equal(adapter.states.get('communicate.request'), '[Alex]what is this?');
        assert.deepEqual(fs.readFileSync(adapter.states.get('communicate.pathFile')), JPEG);
    });

    it('publishes only the path of a photo without caption', async () => {
        bot.emit('message_created', photoMessage());
        await settle();
        assert.match(adapter.states.get('communicate.pathFile'), /\/photo\/mid\.ph1\.jpg$/);
        assert.equal(adapter.states.get('communicate.requestMessageId'), 'mid.ph1');
        assert.equal(adapter.states.has('communicate.request'), false);
        assert.equal(adapter.states.has('message.received'), false);
        assert.equal(adapter.states.has('users.5.last_message'), false);
    });

    it('saves every photo of a message and publishes each path before the caption', async () => {
        bot.emit('message_created', photoMessage({ text: 'three' }, 3));
        await settle();
        const paths = communicate()
            .filter(([id]) => id === 'communicate.pathFile')
            .map(([, v]) => path.posix.basename(String(v)));
        assert.deepEqual(paths, ['mid.ph1_1.jpg', 'mid.ph1_2.jpg', 'mid.ph1_3.jpg']);
        assert.deepEqual(fetchCalls, ['https://i.example/p1?sig=1', 'https://i.example/p2?sig=1', 'https://i.example/p3?sig=1']);
        const ids = communicate().map(([id]) => id);
        assert.ok(ids.lastIndexOf('communicate.pathFile') < ids.indexOf('communicate.request'));
        assert.equal(fs.readdirSync(adapter.photoDir()).length, 3);
    });

    it('takes the extension from the content type or the file content', async () => {
        const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
        manager.http.fetch = async () => response(200, PNG, 'application/octet-stream');
        bot.emit('message_created', photoMessage());
        await settle();
        assert.match(adapter.states.get('communicate.pathFile'), /mid\.ph1\.png$/);
    });

    it('ignores photos of users that are not allowed', async () => {
        adapter.config.allowedUsers = '111';
        bot.emit('message_created', photoMessage({ text: 'caption' }));
        await settle();
        assert.deepEqual(fetchCalls, []);
        assert.equal(adapter.states.size, 0);
        assert.equal(fs.existsSync(adapter.photoDir()), false);
    });

    it('keeps the photos that could be saved and still publishes the caption', async () => {
        let n = 0;
        manager.http.fetch = async () => (++n === 1 ? response(404, Buffer.from('gone')) : response(200, JPEG));
        bot.emit('message_created', photoMessage({ text: 'two' }, 2));
        await settle();
        const paths = communicate().filter(([id]) => id === 'communicate.pathFile');
        assert.equal(paths.length, 1);
        assert.match(String(paths[0][1]), /mid\.ph1_2\.jpg$/);
        assert.equal(adapter.states.get('communicate.request'), '[Alex]two');
        assert.ok(adapter.logs.warn.some(msg => /Photo 1 of 2 from 5 could not be saved: .*HTTP 404/.test(msg)));
    });

    it('publishes the caption without a path when no photo could be saved', async () => {
        manager.http.fetch = async () => response(500, Buffer.from('x'));
        bot.emit('message_created', photoMessage({ text: 'caption' }));
        await settle();
        assert.equal(adapter.states.has('communicate.pathFile'), false);
        assert.equal(adapter.states.get('communicate.request'), '[Alex]caption');
    });

    it('keeps only the newest 50 photos', async () => {
        const dir = adapter.photoDir();
        fs.mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 55; i++) {
            const old = path.join(dir, `old${i}.jpg`);
            fs.writeFileSync(old, 'x');
            const t = new Date(Date.now() - (i + 1) * 60000);
            fs.utimesSync(old, t, t);
        }
        bot.emit('message_created', photoMessage({}, 2));
        await settle();
        const files = fs.readdirSync(dir);
        assert.equal(files.length, 50);
        assert.ok(files.includes('mid.ph1_1.jpg'));
        assert.ok(files.includes('mid.ph1_2.jpg'));
        // the oldest files are gone, the newest old ones stay
        assert.ok(!files.includes('old54.jpg'));
        assert.ok(files.includes('old0.jpg'));
    });

    it('does not touch the voice folder', async () => {
        const voiceDir = adapter.voiceDir();
        fs.mkdirSync(voiceDir, { recursive: true });
        fs.writeFileSync(path.join(voiceDir, 'v.ogg'), 'x');
        bot.emit('message_created', photoMessage());
        await settle();
        assert.deepEqual(fs.readdirSync(voiceDir), ['v.ogg']);
    });
});
