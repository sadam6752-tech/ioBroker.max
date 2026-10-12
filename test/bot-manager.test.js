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
        viewRows: [],
        timers: [],
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
        },
    };
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

    describe('attachments', () => {
        it('sends prepared attachments with the message', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            const attachments = [{ type: 'image', payload: { token: 't' } }];
            await manager.sendMessage('5', '', attachments);
            assert.deepEqual(bot.sent, [{ userId: 5, text: undefined }]);
            assert.deepEqual(bot.extras, [{ attachments }]);
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
            assert.deepEqual(summary, { sent: 2, failed: 0, skipped: 0 });
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
            assert.deepEqual(summary, { sent: 1, failed: 1, skipped: 0 });
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
            assert.deepEqual(summary, { sent: 1, failed: 0, skipped: 1 });
            assert.deepEqual(bot.sent, [{ userId: 2, text: 'broadcast' }]);
        });

        it('warns when no known user is allowed', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            adapter.config.allowedUsers = '5';
            manager.knownUsers.add('1');
            const summary = await manager.sendToAll('broadcast');
            assert.deepEqual(summary, { sent: 0, failed: 0, skipped: 1 });
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
