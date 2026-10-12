'use strict';

/*
 * ioBroker.max — MAX Messenger Bot Adapter
 * Sends and receives messages via MAX messenger bot
 */

const utils = require('@iobroker/adapter-core');
const BotManager = require('./lib/bot-manager');
const { normalizeSecrets } = require('./lib/secrets');

/** Delay before a failed bot start (network problem) is retried (ms) */
const START_RETRY_DELAY = 60000;

/** Name of the message.send state, also used in io-package.json */
const SEND_STATE_NAME = 'Send message (format: userId|text, or plain text to all users)';

/** "userId|text" — only a numeric prefix is a user id, any other text is a broadcast */
const DIRECT_MESSAGE_PATTERN = /^\s*(\d+)\s*\|([\s\S]*)$/;

/**
 * Split the value of message.send into recipient and text
 *
 * @param {string} value - state value
 * @returns {{ userId: string | null, text: string }} recipient (null = all users) and text
 */
function parseSendValue(value) {
    const match = DIRECT_MESSAGE_PATTERN.exec(value);
    if (match) {
        return { userId: match[1], text: match[2].trim() };
    }
    return { userId: null, text: value.trim() };
}

class MaxAdapter extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    constructor(options = {}) {
        super({
            ...options,
            name: 'max',
        });

        this.botManager = null;
        this.startTimer = null;
        this.unloading = false;

        this.onReady = this.onReady.bind(this);
        this.onStateChange = this.onStateChange.bind(this);
        this.onMessage = this.onMessage.bind(this);
        this.onUnload = this.onUnload.bind(this);

        this.on('ready', this.onReady);
        this.on('stateChange', this.onStateChange);
        this.on('message', this.onMessage);
        this.on('unload', this.onUnload);
    }

    async onReady() {
        this.log.debug('onReady executing...');

        await this.setStateAsync('info.connection', false, true);

        // Repair/replace an unusable token before it is used (see v0.1.4 changelog)
        await normalizeSecrets(this.config, this.log, attr => this.getEncryptedConfig(attr));

        // Create instance objects (idempotent via extendObjectAsync)
        await this.extendObjectAsync('info', {
            type: 'channel',
            common: { name: 'Information' },
            native: {},
        });
        await this.extendObjectAsync('info.connection', {
            type: 'state',
            common: {
                name: 'Connected to MAX API',
                type: 'boolean',
                role: 'indicator.connected',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.extendObjectAsync('message', {
            type: 'channel',
            common: { name: 'Messages' },
            native: {},
        });
        await this.extendObjectAsync('message.send', {
            type: 'state',
            common: {
                name: SEND_STATE_NAME,
                type: 'string',
                role: 'text',
                read: false,
                write: true,
                def: '',
            },
            native: {},
        });
        await this.extendObjectAsync('message.received', {
            type: 'state',
            common: {
                name: 'Last received message',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.extendObjectAsync('message.userId', {
            type: 'state',
            common: {
                name: 'User ID of last message sender',
                type: 'number',
                role: 'value',
                read: true,
                write: false,
                def: 0,
            },
            native: {},
        });
        await this.extendObjectAsync('users', {
            type: 'channel',
            common: { name: 'Users' },
            native: {},
        });

        await this.subscribeStatesAsync('message.send');
        await this.subscribeStatesAsync('users.*.send');

        // Validate token
        if (!this.config.token) {
            this.log.error('No MAX bot token configured! Please set the token in adapter settings.');
            return;
        }

        this.botManager = new BotManager(this);
        await this._startBot();
    }

    /**
     * Start the bot. Network problems are retried, a rejected token is not.
     * info.connection is maintained by the BotManager.
     */
    async _startBot() {
        if (this.unloading || !this.botManager) {
            return;
        }
        try {
            await this.botManager.start(this.config.token);
            if (!this.unloading) {
                this.log.info('MAX adapter ready');
            }
        } catch (e) {
            if (this.unloading) {
                return;
            }
            const message = e && typeof e === 'object' && 'message' in e ? e.message : String(e);
            const status = e && typeof e === 'object' ? e.status : undefined;
            if (status === 401 || status === 403) {
                this.log.error(
                    `Failed to start MAX bot: the token was rejected (${message}). Please check the token in the adapter settings.`,
                );
                return;
            }
            this.log.error(`Failed to start MAX bot: ${message}. Retrying in ${START_RETRY_DELAY / 1000} s`);
            this.startTimer = this.setTimeout(() => {
                this.startTimer = null;
                void this._startBot();
            }, START_RETRY_DELAY);
        }
    }

    /**
     * @param {string} id - State ID
     * @param {ioBroker.State | null | undefined} state - New state value
     */
    async onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }

        // message.send — format: "userId|text" or plain text (send to all)
        if (id === `${this.namespace}.message.send`) {
            const { userId, text } = parseSendValue(
                state.val === null || state.val === undefined ? '' : String(state.val),
            );
            if (text !== '') {
                if (userId) {
                    await this._sendMessage(userId, text);
                } else {
                    await this._sendToAll(text);
                }
            }
            await this.setStateAsync('message.send', '', true);
            return;
        }

        // users.<id>.send — direct send to specific user
        const prefix = `${this.namespace}.users.`;
        if (id.startsWith(prefix) && id.endsWith('.send')) {
            const userId = id.substring(prefix.length, id.length - '.send'.length);
            if (userId === '' || userId.includes('.')) {
                return;
            }
            const text = state.val === null || state.val === undefined ? '' : String(state.val).trim();
            if (text !== '') {
                await this._sendMessage(userId, text);
            }
            await this.setStateAsync(`users.${userId}.send`, '', true);
        }
    }

    /**
     * Handle sendTo() calls. Accepted forms of the message:
     * - a string: broadcast to all known users
     * - `{ text, userId? }`: to one user, or to all users without `userId`
     *
     * The callback receives `{ result: 'sent', ... }` or `{ error: '...' }`.
     *
     * @param {ioBroker.Message} obj - Message object
     */
    async onMessage(obj) {
        if (!obj || typeof obj !== 'object') {
            return;
        }
        const reply = response => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, response, obj.callback);
            }
        };

        if (obj.command !== 'send') {
            reply({ error: `Unknown command: ${obj.command}` });
            return;
        }

        const data = obj.message;
        let text = '';
        let userId = null;
        if (typeof data === 'string') {
            text = data;
        } else if (data && typeof data === 'object') {
            text = data.text === null || data.text === undefined ? '' : String(data.text);
            userId = data.userId === null || data.userId === undefined || data.userId === '' ? null : data.userId;
        }
        text = text.trim();

        if (text === '') {
            this.log.warn('sendTo "send" without text ignored');
            reply({ error: 'No text given' });
            return;
        }

        const response = userId !== null ? await this._sendMessage(String(userId), text) : await this._sendToAll(text);
        reply(response);
    }

    /**
     * @param {() => void} callback - Unload callback
     */
    async onUnload(callback) {
        this.unloading = true;
        try {
            if (this.startTimer) {
                this.clearTimeout(this.startTimer);
                this.startTimer = null;
            }
            if (this.botManager) {
                this.botManager.stop();
                this.botManager = null;
            }
            await this.setStateAsync('info.connection', false, true);
        } catch {
            // ignore
        } finally {
            callback();
        }
    }

    /**
     * Send message to a specific user
     *
     * @param {string} userId - User ID to send message to
     * @param {string} text - Message text
     * @returns {Promise<{result: string} | {error: string}>} outcome for sendTo callers
     */
    async _sendMessage(userId, text) {
        if (!this.botManager) {
            this.log.warn('Bot not initialized, cannot send message');
            return { error: 'Bot not initialized' };
        }
        try {
            await this.botManager.sendMessage(userId, text);
            this.log.debug(`Message sent to user ${userId}`);
            return { result: 'sent' };
        } catch (e) {
            this.log.error(`Failed to send message to ${userId}: ${e.message}`);
            return { error: e.message };
        }
    }

    /**
     * Send message to all known users
     *
     * @param {string} text - Message text to send to all users
     * @returns {Promise<{result: string, sent: number, failed: number, skipped: number} | {error: string}>} outcome
     */
    async _sendToAll(text) {
        if (!this.botManager) {
            this.log.warn('Bot not initialized, cannot send message');
            return { error: 'Bot not initialized' };
        }
        if (!this.config.sendToAllUsers) {
            this.log.warn(
                "Received a broadcast message but 'sendToAllUsers' is disabled. " +
                    "Enable it in the adapter settings or use the format 'userId|text'.",
            );
            return { error: 'sendToAllUsers is disabled' };
        }
        try {
            const summary = await this.botManager.sendToAll(text);
            this.log.debug(`Broadcast sent to ${summary.sent} user(s), ${summary.failed} failed`);
            if (summary.sent === 0) {
                return { error: summary.failed > 0 ? 'Delivery failed for all users' : 'No known users', ...summary };
            }
            return { result: 'sent', ...summary };
        } catch (e) {
            this.log.error(`Failed to send to all: ${e.message}`);
            return { error: e.message };
        }
    }

    /**
     * Create or update user states dynamically
     *
     * @param {string|number} userId - User ID
     * @param {string} username - Username or display name
     */
    async ensureUserObjects(userId, username) {
        const uid = String(userId);
        // Ensure parent 'users' channel exists
        await this.extendObjectAsync('users', {
            type: 'channel',
            common: { name: 'Users' },
            native: {},
        });
        await this.extendObjectAsync(`users.${uid}`, {
            type: 'channel',
            common: { name: username || `User ${uid}` },
            native: {},
        });
        await this.extendObjectAsync(`users.${uid}.last_message`, {
            type: 'state',
            common: {
                name: 'Last message',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.extendObjectAsync(`users.${uid}.send`, {
            type: 'state',
            common: {
                name: 'Send message',
                type: 'string',
                role: 'text',
                read: false,
                write: true,
                def: '',
            },
            native: {},
        });
        await this.extendObjectAsync(`users.${uid}.callback_data`, {
            type: 'state',
            common: {
                name: 'Callback data',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.extendObjectAsync(`users.${uid}.username`, {
            type: 'state',
            common: {
                name: 'Username',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: '',
            },
            native: {},
        });
        await this.extendObjectAsync(`users.${uid}.started`, {
            type: 'state',
            common: {
                name: 'Bot started by this user',
                type: 'boolean',
                role: 'indicator',
                read: true,
                write: false,
                def: false,
            },
            native: {},
        });
        await this.subscribeStatesAsync(`users.${uid}.send`);
    }
}

if (require.main !== module) {
    /**
     * @param {Partial<utils.AdapterOptions>} [options] - Adapter options
     */
    module.exports = options => new MaxAdapter(options);
    // exported for unit tests
    module.exports.MaxAdapter = MaxAdapter;
    module.exports.parseSendValue = parseSendValue;
} else {
    new MaxAdapter();
}
