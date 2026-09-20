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
    bot.stopped = false;
    bot.errorHandler = null;
    bot.api = {
        /**
         * @param {number} userId - target user
         * @param {string} text - message text
         */
        async sendMessageToUser(userId, text) {
            bot.sent.push({ userId, text });
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

        it('sends the message and remembers the user', async () => {
            const bot = createBotMock();
            manager.bot = bot;
            await manager.sendMessage('123', 'hi');
            assert.deepEqual(bot.sent, [{ userId: 123, text: 'hi' }]);
            assert.equal(manager.knownUsers.has('123'), true);
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
            await manager.sendToAll('broadcast');
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
            await manager.sendToAll('broadcast');
            assert.deepEqual(bot.sent, [{ userId: 2, text: 'broadcast' }]);
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


