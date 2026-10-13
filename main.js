'use strict';

/*
 * ioBroker.max — MAX Messenger Bot Adapter
 * Sends and receives messages via MAX messenger bot
 */

const utils = require('@iobroker/adapter-core');
const BotManager = require('./lib/bot-manager');
const { normalizeSecrets } = require('./lib/secrets');
const { describeError } = require('./lib/max-fetch');
const { collectMedia } = require('./lib/media');
const { buildKeyboard } = require('./lib/keyboard');

/** Delay before a failed bot start (network problem) is retried (ms) */
const START_RETRY_DELAY = 60000;

/** Name of the message.send state, also used in io-package.json */
const SEND_STATE_NAME = 'Send message (format: userId|text, -chatId|text, plain text to all users, or JSON)';

/** Objects of the communicate channel, also listed in io-package.json (instanceObjects) */
const COMMUNICATE_OBJECTS = [
    {
        _id: 'communicate',
        type: 'channel',
        common: { name: 'Requests and responses (like the Telegram adapter)' },
        native: {},
    },
    {
        _id: 'communicate.request',
        type: 'state',
        common: {
            name: 'Last request: [name]text or [name]button payload',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: '',
        },
        native: {},
    },
    {
        _id: 'communicate.requestChatId',
        type: 'state',
        common: {
            name: 'Group chat ID of the last request (0 = private dialog)',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            def: 0,
        },
        native: {},
    },
    {
        _id: 'communicate.requestUserId',
        type: 'state',
        common: {
            name: 'User ID of the last request',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            def: 0,
        },
        native: {},
    },
    {
        _id: 'communicate.requestMessageId',
        type: 'state',
        common: {
            name: 'Message ID of the last request',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
            def: '',
        },
        native: {},
    },
    {
        _id: 'communicate.response',
        type: 'state',
        common: {
            name: 'Response to the user or group chat of the last request (text or JSON)',
            type: 'string',
            role: 'text',
            read: false,
            write: true,
            def: '',
        },
        native: {},
    },
];

/** Objects for group chats, also listed in io-package.json (instanceObjects) */
const GROUP_OBJECTS = [
    {
        _id: 'message.chatId',
        type: 'state',
        common: {
            name: 'Group chat ID of the last message (0 = private dialog)',
            type: 'number',
            role: 'value',
            read: true,
            write: false,
            def: 0,
        },
        native: {},
    },
    { _id: 'chats', type: 'channel', common: { name: 'Group chats' }, native: {} },
];

/** "id|text" — a numeric prefix is a user id, a negative one a group chat id; any other text is a broadcast */
const DIRECT_MESSAGE_PATTERN = /^\s*(-?\d+)\s*\|([\s\S]*)$/;

/**
 * Move a negative user id to chatId: group chat ids of MAX are negative
 *
 * @param {{ userId: string | null, chatId?: string | null }} request - send request (changed in place)
 * @returns {{ userId: string | null, chatId?: string | null }} the request
 */
function normalizeTarget(request) {
    if (request.userId && request.userId.startsWith('-')) {
        if (request.chatId && request.chatId !== request.userId) {
            throw new Error('Use either userId or chatId');
        }
        request.chatId = request.userId;
        request.userId = null;
    }
    if (request.chatId && request.userId) {
        throw new Error('Use either userId or chatId');
    }
    if (!request.chatId) {
        delete request.chatId;
    }
    return request;
}

/**
 * Split the value of message.send into recipient and text
 *
 * @param {string} value - state value
 * @returns {{ userId: string | null, chatId?: string, text: string }} recipient (null = all users) and text
 */
function parseSendValue(value) {
    const match = DIRECT_MESSAGE_PATTERN.exec(value);
    if (match) {
        return normalizeTarget({ userId: match[1], text: match[2].trim() });
    }
    return { userId: null, text: value.trim() };
}

/**
 * Build a send request from a sendTo() message or a JSON object:
 * a string (broadcast) or `{ userId? | chatId?, text?, image?, video?, audio?, file?, keyboard?, notify? }`;
 * `notify: false` (or `disable_notification: true` as in the Telegram adapter) sends without notification
 *
 * @param {unknown} data - message
 * @returns {{ userId: string | null, text: string, media: { type: string, source: string }[], keyboard?: object }} request
 */
function parseSendRequest(data) {
    if (typeof data === 'string') {
        return { userId: null, text: data.trim(), media: [] };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { userId: null, text: '', media: [] };
    }
    const obj = data;
    const text = obj.text === null || obj.text === undefined ? '' : String(obj.text).trim();
    const userId =
        obj.userId === null || obj.userId === undefined || obj.userId === '' ? null : String(obj.userId).trim();
    const chatId =
        obj.chatId === null || obj.chatId === undefined || obj.chatId === '' ? null : String(obj.chatId).trim();
    const request = normalizeTarget({ userId, chatId, text, media: collectMedia(obj) });
    if (obj.notify === false || obj.disable_notification === true) {
        request.notify = false;
    }
    const keyboard = buildKeyboard(obj.keyboard);
    if (keyboard) {
        request.keyboard = keyboard;
    }
    return request;
}

/**
 * Build a send request from the value of a send state: a JSON object (see parseSendRequest),
 * otherwise "userId|text" or plain text. Text that only looks like JSON is sent as text.
 *
 * @param {string} value - state value
 * @returns {{ userId: string | null, text: string, media: { type: string, source: string }[] }} request
 */
function parseStateValue(value) {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
        let data;
        try {
            data = JSON.parse(trimmed);
        } catch {
            data = undefined;
        }
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            return parseSendRequest(data);
        }
    }
    return { ...parseSendValue(value), media: [] };
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
        for (const { _id, ...obj } of [...GROUP_OBJECTS, ...COMMUNICATE_OBJECTS]) {
            await this.extendObjectAsync(_id, obj);
        }

        await this.subscribeStatesAsync('message.send');
        await this.subscribeStatesAsync('users.*.send');
        await this.subscribeStatesAsync('chats.*.send');
        await this.subscribeStatesAsync('communicate.response');

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
            const message = describeError(e);
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
        const value = state.val === null || state.val === undefined ? '' : String(state.val);

        // message.send — "userId|text", plain text (send to all) or JSON with attachments
        if (id === `${this.namespace}.message.send`) {
            await this._sendFromState(value, null);
            await this.setStateAsync('message.send', '', true);
            return;
        }

        // communicate.response — answer in the group chat or to the user of the last request
        if (id === `${this.namespace}.communicate.response`) {
            const chat = await this.getStateAsync('communicate.requestChatId');
            const requester = await this.getStateAsync('communicate.requestUserId');
            const chatId = chat && chat.val ? String(chat.val) : '';
            const userId = requester && requester.val ? String(requester.val) : '';
            if (chatId !== '' && chatId !== '0') {
                await this._sendFromState(value, { chatId });
            } else if (userId !== '' && userId !== '0') {
                await this._sendFromState(value, { userId });
            } else {
                this.log.warn('communicate.response ignored: there was no request yet');
            }
            await this.setStateAsync('communicate.response', '', true);
            return;
        }

        // users.<id>.send / chats.<id>.send — text or JSON with attachments to this user or chat
        for (const folder of ['users', 'chats']) {
            const prefix = `${this.namespace}.${folder}.`;
            if (id.startsWith(prefix) && id.endsWith('.send')) {
                const target = id.substring(prefix.length, id.length - '.send'.length);
                if (target === '' || target.includes('.')) {
                    return;
                }
                await this._sendFromState(value, folder === 'users' ? { userId: target } : { chatId: target });
                await this.setStateAsync(`${folder}.${target}.send`, '', true);
                return;
            }
        }
    }

    /**
     * Send the value of a send state
     *
     * @param {string} value - state value
     * @param {{ userId?: string, chatId?: string } | null} fixed - fixed recipient (users/chats.<id>.send,
     *        communicate.response) or null (message.send)
     */
    async _sendFromState(value, fixed) {
        let request;
        try {
            request = parseStateValue(value);
        } catch (e) {
            this.log.error(`Cannot send: ${e.message}`);
            return;
        }
        if (fixed) {
            if (!value.trim().startsWith('{') || request.text === value.trim()) {
                // a fixed recipient takes the whole value as text, "|" included
                request = { userId: null, text: value.trim(), media: [] };
            }
            request.userId = fixed.userId || null;
            delete request.chatId;
            if (fixed.chatId) {
                request.chatId = fixed.chatId;
            }
        }
        if (request.text === '' && request.media.length === 0) {
            return;
        }
        await this._send(request);
    }

    /**
     * Handle sendTo() calls. Accepted forms of the message:
     * - a string: broadcast to all known users
     * - `{ text?, userId?, image?, video?, audio?, file?, keyboard? }`: to one user, or to all users without
     *   `userId`; attachments are local paths or http(s) URLs, a single string or a list; keyboard see lib/keyboard.js
     *
     * Command `answerCallback` with `{ userId, text }` answers the last button press of that user.
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

        if (obj.command === 'answerCallback') {
            reply(await this._answerCallback(obj.message));
            return;
        }
        if (obj.command !== 'send') {
            reply({ error: `Unknown command: ${obj.command}` });
            return;
        }

        let request;
        try {
            request = parseSendRequest(obj.message);
        } catch (e) {
            this.log.warn(`sendTo "send" ignored: ${e.message}`);
            reply({ error: e.message });
            return;
        }
        if (request.text === '' && request.media.length === 0) {
            this.log.warn('sendTo "send" without text or attachment ignored');
            reply({ error: 'No text or attachment given' });
            return;
        }

        reply(await this._send(request));
    }

    /**
     * Answer the last button press of a user (sendTo command answerCallback)
     *
     * @param {unknown} data - `{ userId, text }`
     * @returns {Promise<object>} outcome for sendTo callers
     */
    async _answerCallback(data) {
        const obj = data && typeof data === 'object' ? data : {};
        const userId = obj.userId === undefined || obj.userId === null ? '' : String(obj.userId);
        const text = obj.text === undefined || obj.text === null ? '' : String(obj.text).trim();
        if (userId === '' || text === '') {
            return { error: 'answerCallback needs userId and text' };
        }
        if (!this.botManager) {
            return { error: 'Bot not initialized' };
        }
        try {
            await this.botManager.answerCallback(userId, text);
            return { result: 'answered' };
        } catch (e) {
            this.log.warn(`Cannot answer the button press of ${userId}: ${describeError(e)}`);
            return { error: describeError(e) };
        }
    }

    /**
     * Upload the attachments once and send the message to one user or to all users
     *
     * @param {{ userId: string | null, chatId?: string, text: string, media: { type: string, source: string }[], keyboard?: object }} request - send request
     * @returns {Promise<object>} outcome for sendTo callers
     */
    async _send(request) {
        const { userId, chatId, text, media, keyboard } = request;
        const options = request.notify === false ? { notify: false } : {};
        if (!this.botManager) {
            this.log.warn('Bot not initialized, cannot send message');
            return { error: 'Bot not initialized' };
        }
        if (userId === null && !chatId && !this.config.sendToAllUsers) {
            return this._sendToAll(text);
        }
        let attachments = [];
        if (media.length > 0) {
            try {
                attachments = await this.botManager.prepareAttachments(media);
            } catch (e) {
                this.log.error(`Failed to send message: ${describeError(e)}`);
                return { error: describeError(e) };
            }
        }
        if (keyboard) {
            attachments = [...attachments, keyboard];
        }
        if (chatId) {
            return this._sendToChat(chatId, text, attachments, options);
        }
        return userId !== null
            ? this._sendMessage(userId, text, attachments, options)
            : this._sendToAll(text, attachments, options);
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
     * @param {{ type: string, payload: object }[]} [attachments] - prepared attachments
     * @param {{ notify?: boolean }} [options] - send options
     * @returns {Promise<{result: string} | {error: string}>} outcome for sendTo callers
     */
    async _sendMessage(userId, text, attachments = [], options = {}) {
        if (!this.botManager) {
            this.log.warn('Bot not initialized, cannot send message');
            return { error: 'Bot not initialized' };
        }
        try {
            await this.botManager.sendMessage(userId, text, attachments, options);
            this.log.debug(`Message sent to user ${userId}`);
            return { result: 'sent' };
        } catch (e) {
            this.log.error(`Failed to send message to ${userId}: ${describeError(e)}`);
            return { error: describeError(e) };
        }
    }

    /**
     * Send message to a group chat
     *
     * @param {string} chatId - chat ID
     * @param {string} text - Message text
     * @param {{ type: string, payload: object }[]} [attachments] - prepared attachments
     * @param {{ notify?: boolean }} [options] - send options
     * @returns {Promise<{result: string} | {error: string}>} outcome for sendTo callers
     */
    async _sendToChat(chatId, text, attachments = [], options = {}) {
        try {
            await this.botManager.sendToChat(chatId, text, attachments, options);
            this.log.debug(`Message sent to chat ${chatId}`);
            return { result: 'sent' };
        } catch (e) {
            this.log.error(`Failed to send message to chat ${chatId}: ${describeError(e)}`);
            return { error: describeError(e) };
        }
    }

    /**
     * Create or update the objects of a group chat
     *
     * @param {string|number} chatId - chat ID
     * @param {string} [title] - chat title
     */
    async ensureChatObjects(chatId, title) {
        const cid = String(chatId);
        const states = {
            last_message: { name: 'Last message in the chat', type: 'string', role: 'text', write: false, def: '' },
            last_user_id: { name: 'User ID of the last sender', type: 'number', role: 'value', write: false, def: 0 },
            last_username: { name: 'Name of the last sender', type: 'string', role: 'text', write: false, def: '' },
            callback_data: { name: 'Callback data', type: 'string', role: 'text', write: false, def: '' },
            send: {
                name: 'Send message to the chat (text or JSON)',
                type: 'string',
                role: 'text',
                write: true,
                def: '',
            },
        };
        await this.extendObjectAsync('chats', { type: 'channel', common: { name: 'Group chats' }, native: {} });
        const channel = { type: 'channel', common: { name: title || `Chat ${cid}` }, native: {} };
        if (title) {
            await this.extendObjectAsync(`chats.${cid}`, channel);
        } else {
            await this.setObjectNotExistsAsync(`chats.${cid}`, channel);
        }
        for (const [name, common] of Object.entries(states)) {
            await this.extendObjectAsync(`chats.${cid}.${name}`, {
                type: 'state',
                common: { ...common, read: !common.write },
                native: {},
            });
        }
        await this.subscribeStatesAsync(`chats.${cid}.send`);
    }

    /**
     * Send message to all known users
     *
     * @param {string} text - Message text to send to all users
     * @param {{ type: string, payload: object }[]} [attachments] - prepared attachments
     * @param {{ notify?: boolean }} [options] - send options
     * @returns {Promise<{result: string, sent: number, failed: number, skipped: number} | {error: string}>} outcome
     */
    async _sendToAll(text, attachments = [], options = {}) {
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
            const summary = await this.botManager.sendToAll(text, attachments, options);
            this.log.debug(`Broadcast sent to ${summary.sent} user(s), ${summary.failed} failed`);
            if (summary.sent === 0) {
                return { error: summary.failed > 0 ? 'Delivery failed for all users' : 'No known users', ...summary };
            }
            return { result: 'sent', ...summary };
        } catch (e) {
            this.log.error(`Failed to send to all: ${describeError(e)}`);
            return { error: describeError(e) };
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
    module.exports.parseSendRequest = parseSendRequest;
    module.exports.parseStateValue = parseStateValue;
    module.exports.COMMUNICATE_OBJECTS = COMMUNICATE_OBJECTS;
    module.exports.GROUP_OBJECTS = GROUP_OBJECTS;
} else {
    new MaxAdapter();
}
