'use strict';

/*
 * BotManager — wraps @maxhub/max-bot-api
 * Handles bot lifecycle, message handlers, and sending
 */

const { Bot } = require('@maxhub/max-bot-api');
const { createMaxFetch, describeError } = require('./max-fetch');
const { uploadMedia } = require('./media');

/** First delay before long polling is restarted after it ended unexpectedly (ms) */
const RESTART_BASE_DELAY = 5000;
/** Upper limit for the restart delay (ms) */
const RESTART_MAX_DELAY = 60000;

/**
 * BotManager — manages MAX messenger bot lifecycle and message handling.
 */
class BotManager {
    /**
     * @param {import('@iobroker/adapter-core').Adapter} adapter - ioBroker adapter instance
     * @param {(token: string) => object} [createBot] - bot factory (replaced in tests)
     */
    constructor(adapter, createBot) {
        this.adapter = adapter;
        this.createBot = createBot || (token => this._createDefaultBot(token));
        this.http = null;
        this.bot = null;
        this.knownUsers = new Set();
        /** group chats with objects below chats.<chatId> */
        this.knownChats = new Set();
        /** last callback id per user, for answerCallback() */
        this.lastCallbacks = new Map();
        this.connected = false;
        this.stopping = false;
        this.restartTimer = null;
        this.restartDelay = RESTART_BASE_DELAY;
    }

    /**
     * Start the bot with the given token.
     *
     * Resolves as soon as the token has been verified against the MAX API. Long polling runs in
     * the background: `bot.start()` of the library only resolves when polling has ended, so it
     * must not be awaited here.
     *
     * @param {string} token - MAX bot API token
     */
    async start(token) {
        this.stop();
        this.stopping = false;
        this.restartDelay = RESTART_BASE_DELAY;

        const bot = this.createBot(token);
        this.bot = bot;
        this.setupHandlers();
        this._watchUpdates(bot);

        await this._loadKnownUsers();
        await this._loadKnownChats();

        // Verifies the token; bot.start() reuses the cached botInfo
        bot.botInfo = await bot.api.getMyInfo();
        if (this.stopping || this.bot !== bot) {
            return;
        }

        this._setConnected(true);
        this._runPolling(bot);
        this.adapter.log.info(`MAX bot started successfully (${this.knownUsers.size} known user(s))`);
    }

    /**
     * Create the MAX bot with a fetch that trusts the root CA of the MAX API host (see lib/max-fetch.js)
     *
     * @param {string} token - MAX bot API token
     * @returns {object} bot instance
     */
    _createDefaultBot(token) {
        this.http = createMaxFetch();
        return new Bot(token, { clientOptions: { fetch: this.http.fetch } });
    }

    /**
     * Run long polling in the background and restart it when it ends unexpectedly
     *
     * @param {object} bot - bot instance
     */
    _runPolling(bot) {
        const onEnd = err => {
            if (this.stopping || this.bot !== bot) {
                return; // regular stop
            }
            const reason = err ? `: ${describeError(err)}` : '';
            this._setConnected(false);
            this.adapter.log.warn(
                `MAX long polling stopped unexpectedly${reason}. Restarting in ${Math.round(this.restartDelay / 1000)} s`,
            );
            this.restartTimer = this.adapter.setTimeout(() => {
                this.restartTimer = null;
                if (!this.stopping && this.bot === bot) {
                    this._runPolling(bot);
                }
            }, this.restartDelay);
            this.restartDelay = Math.min(this.restartDelay * 2, RESTART_MAX_DELAY);
        };

        let polling;
        try {
            // retry: false — restarts are handled here, so they are visible in the log and in info.connection
            polling = Promise.resolve(bot.start({ mode: 'polling', options: { retry: false } }));
        } catch (e) {
            polling = Promise.reject(e);
        }
        polling.then(() => onEnd(null), onEnd);
    }

    /**
     * Track the result of every long polling request to maintain info.connection.
     * The library retries failed requests silently, so this is the only place where an
     * outage becomes visible.
     *
     * @param {object} bot - bot instance
     */
    _watchUpdates(bot) {
        const api = bot.api;
        if (!api || typeof api.getUpdates !== 'function') {
            return;
        }
        const original = api.getUpdates;
        api.getUpdates = async (...args) => {
            try {
                const result = await original.apply(api, args);
                if (this.bot === bot) {
                    this.restartDelay = RESTART_BASE_DELAY;
                    this._setConnected(true);
                }
                return result;
            } catch (e) {
                if (this.bot === bot && !(e && e.name === 'AbortError')) {
                    this._setConnected(false, e);
                }
                throw e;
            }
        };
    }

    /**
     * Update info.connection and log changes of the connection state
     *
     * @param {boolean} value - true when the MAX API is reachable
     * @param {unknown} [err] - error that caused the loss of the connection
     */
    _setConnected(value, err) {
        if (this.stopping || this.connected === value) {
            return;
        }
        this.connected = value;
        if (value) {
            this.adapter.log.info('Connected to the MAX API');
        } else if (err) {
            this.adapter.log.warn(`Connection to the MAX API lost: ${describeError(err)}`);
        }
        Promise.resolve(this.adapter.setStateAsync('info.connection', value, true)).catch(e =>
            this.adapter.log.debug(`Could not update info.connection: ${e.message}`),
        );
    }

    /**
     * Register bot event handlers
     */
    setupHandlers() {
        if (!this.bot) {
            return;
        }

        // Bot added to a group chat
        this.bot.on('bot_added', async ctx => {
            const chatId = ctx.chatId;
            const title = ctx.chat && ctx.chat.title;
            this.adapter.log.info(
                `Bot added to chat ${chatId !== undefined ? chatId : 'unknown'}${title ? ` (${title})` : ''}`,
            );
            if (chatId === undefined || chatId === null) {
                return;
            }
            try {
                await this._handleChat(chatId, title);
            } catch (e) {
                this.adapter.log.error(`Failed to process bot_added for chat ${chatId}: ${e.message}`);
            }
        });

        // Bot started by user
        this.bot.on('bot_started', async ctx => {
            const user = ctx.user;
            if (!user || user.user_id === undefined) {
                return;
            }
            const userId = user.user_id;
            const username = this._displayName(user);

            if (!this._isAllowed(userId)) {
                this._logBlocked(userId, 'bot_started');
                return;
            }

            this.adapter.log.info(`Bot started by user ${userId} (${username})`);

            try {
                await this._handleNewUser(userId, username);
                await this.adapter.setStateAsync(`users.${userId}.started`, true, true);
            } catch (e) {
                this.adapter.log.error(`Failed to process bot_started for ${userId}: ${e.message}`);
            }
        });

        // Message received (private dialog or group chat)
        this.bot.on('message_created', async ctx => {
            const user = ctx.user;
            if (!user || user.user_id === undefined) {
                return;
            }
            const userId = user.user_id;
            const username = this._displayName(user);
            const body = ctx.message && ctx.message.body;
            const text = (body && body.text) || '';
            const messageId = (body && body.mid) || '';
            const chatId = this._groupChatId(ctx);

            if (!this._isAllowed(userId)) {
                this._logBlocked(userId, text);
                return;
            }

            this.adapter.log.debug(`Message from ${userId}${chatId !== null ? ` in chat ${chatId}` : ''}: ${text}`);

            try {
                if (chatId !== null) {
                    // group members do not become known users: broadcasts would reach them privately
                    await this._handleChat(chatId);
                    await this.adapter.setStateAsync(`chats.${chatId}.last_user_id`, Number(userId), true);
                    await this.adapter.setStateAsync(`chats.${chatId}.last_username`, username, true);
                    await this.adapter.setStateAsync(`chats.${chatId}.last_message`, text, true);
                } else {
                    await this._handleNewUser(userId, username);
                }

                // Sender and chat are written first: a script triggered by the text reads matching ids
                await this.adapter.setStateAsync('message.chatId', chatId !== null ? Number(chatId) : 0, true);
                await this.adapter.setStateAsync('message.userId', Number(userId), true);
                await this.adapter.setStateAsync('message.received', text, true);
                if (chatId === null) {
                    await this.adapter.setStateAsync(`users.${userId}.last_message`, text, true);
                }
                await this._publishRequest(userId, username, text, messageId, chatId);
            } catch (e) {
                this.adapter.log.error(`Failed to process message from ${userId}: ${e.message}`);
            }
        });

        // Callback button pressed
        this.bot.on('message_callback', async ctx => {
            const user = ctx.user;
            const payload = ctx.callback && ctx.callback.payload;
            if (!user || user.user_id === undefined) {
                return;
            }
            const userId = user.user_id;
            const username = this._displayName(user);
            const chatId = this._groupChatId(ctx);

            if (!this._isAllowed(userId)) {
                this._logBlocked(userId, 'message_callback');
                return;
            }

            this.adapter.log.debug(`Callback from ${userId}${chatId !== null ? ` in chat ${chatId}` : ''}: ${payload}`);
            if (ctx.callback && ctx.callback.callback_id) {
                this.lastCallbacks.set(String(userId), ctx.callback.callback_id);
            }

            try {
                if (chatId !== null) {
                    await this._handleChat(chatId);
                } else {
                    await this._handleNewUser(userId, username);
                }
                if (payload !== undefined && payload !== null) {
                    const target = chatId !== null ? `chats.${chatId}` : `users.${userId}`;
                    await this.adapter.setStateAsync(`${target}.callback_data`, String(payload), true);
                    const mid = (ctx.message && ctx.message.body && ctx.message.body.mid) || '';
                    await this._publishRequest(userId, username, String(payload), mid, chatId);
                }
            } catch (e) {
                this.adapter.log.error(`Failed to process callback from ${userId}: ${e.message}`);
            }
        });

        // Error handler — log but keep the adapter alive instead of crashing
        this.bot.catch(err => {
            const message = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
            this.adapter.log.error(`MAX bot error: ${message}`);
        });
    }

    /**
     * Write a request in the format of the Telegram adapter: communicate.request = "[name]text".
     * The ids are written before the request, so a script triggered by the request reads matching values.
     *
     * @param {string|number} userId - sender
     * @param {string} username - display name of the sender
     * @param {string} text - message text or callback payload
     * @param {string} messageId - MAX message id
     * @param {string|number|null} [chatId] - group chat of the request, null for a private dialog
     */
    async _publishRequest(userId, username, text, messageId, chatId = null) {
        await this.adapter.setStateAsync('communicate.requestChatId', chatId !== null ? Number(chatId) : 0, true);
        await this.adapter.setStateAsync('communicate.requestUserId', Number(userId), true);
        await this.adapter.setStateAsync('communicate.requestMessageId', String(messageId || ''), true);
        await this.adapter.setStateAsync('communicate.request', `[${username || userId}]${text}`, true);
    }

    /**
     * Answer the last button press (callback) of a user with a short notification
     *
     * @param {string|number} userId - user who pressed the button
     * @param {string} text - notification shown to the user
     */
    async answerCallback(userId, text) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        const callbackId = this.lastCallbacks.get(String(userId));
        if (!callbackId) {
            throw new Error(`No button press of user ${userId} to answer`);
        }
        this.lastCallbacks.delete(String(userId));
        await this.bot.api.answerOnCallback(callbackId, { notification: text });
    }

    /**
     * Upload attachments once, so that they can be sent to one or many users
     *
     * @param {{ type: string, source: string }[]} media - attachments (local path or http(s) URL)
     * @returns {Promise<{ type: string, payload: object }[]>} attachments for the send request
     */
    async prepareAttachments(media) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        const fetchFn = this.http ? this.http.fetch : globalThis.fetch;
        const attachments = [];
        for (const item of media) {
            try {
                attachments.push(await uploadMedia(this.bot.api, fetchFn, item));
            } catch (e) {
                throw new Error(`Cannot attach ${item.type} ${item.source}: ${describeError(e)}`);
            }
        }
        return attachments;
    }

    /**
     * Arguments for sendMessageToUser/sendMessageToChat
     *
     * @param {string} text - Message text (may be empty when attachments are given)
     * @param {{ type: string, payload: object }[]} attachments - prepared attachments
     * @param {{ notify?: boolean }} options - send options; notify: false sends without notification
     * @returns {[string | undefined, object | undefined]} text and extra options of the library
     */
    _messageArgs(text, attachments, options) {
        const extra = {};
        if (attachments.length > 0) {
            // the library retries while MAX still processes an attachment (attachment.not.ready)
            extra.attachments = attachments;
        }
        if (options && options.notify === false) {
            extra.notify = false;
        }
        if (Object.keys(extra).length === 0) {
            return [text, undefined];
        }
        return [text || undefined, extra];
    }

    /**
     * Send a message to a specific user
     *
     * @param {string|number} userId - User ID to send message to
     * @param {string} text - Message text (may be empty when attachments are given)
     * @param {{ type: string, payload: object }[]} [attachments] - prepared attachments
     * @param {{ notify?: boolean }} [options] - send options
     */
    async sendMessage(userId, text, attachments = [], options = {}) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        const id = Number(String(userId).trim());
        if (String(userId).trim() === '' || !Number.isSafeInteger(id)) {
            throw new Error(`Invalid userId: ${userId}`);
        }
        // knownUsers is not touched here: a user becomes known (with objects) only after contacting the bot
        const [body, extra] = this._messageArgs(text, attachments, options);
        if (extra) {
            await this.bot.api.sendMessageToUser(id, body, extra);
        } else {
            await this.bot.api.sendMessageToUser(id, body);
        }
    }

    /**
     * Send a message to a group chat
     *
     * @param {string|number} chatId - chat ID (negative for group chats)
     * @param {string} text - Message text (may be empty when attachments are given)
     * @param {{ type: string, payload: object }[]} [attachments] - prepared attachments
     * @param {{ notify?: boolean }} [options] - send options
     */
    async sendToChat(chatId, text, attachments = [], options = {}) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        const id = Number(String(chatId).trim());
        if (String(chatId).trim() === '' || !Number.isSafeInteger(id)) {
            throw new Error(`Invalid chatId: ${chatId}`);
        }
        const [body, extra] = this._messageArgs(text, attachments, options);
        if (extra) {
            await this.bot.api.sendMessageToChat(id, body, extra);
        } else {
            await this.bot.api.sendMessageToChat(id, body);
        }
    }

    /**
     * Send a message to all known users that are allowed by the `allowedUsers` setting
     *
     * @param {string} text - Message text to send to all users
     * @param {{ type: string, payload: object }[]} [attachments] - prepared attachments
     * @param {{ notify?: boolean }} [options] - send options
     * @returns {Promise<{sent: number, failed: number, skipped: number}>} delivery summary
     */
    async sendToAll(text, attachments = [], options = {}) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        const recipients = [...this.knownUsers].filter(userId => this._isAllowed(userId));
        const skipped = this.knownUsers.size - recipients.length;
        if (skipped > 0) {
            this.adapter.log.debug(`Broadcast skips ${skipped} known user(s) that are not in the allowed list`);
        }
        if (recipients.length === 0) {
            this.adapter.log.warn('No known users to send the broadcast to');
            return { sent: 0, failed: 0, skipped };
        }
        let sent = 0;
        let failed = 0;
        await Promise.all(
            recipients.map(userId =>
                this.sendMessage(userId, text, attachments, options).then(
                    () => {
                        sent++;
                    },
                    e => {
                        failed++;
                        this.adapter.log.warn(`Failed to send to ${userId}: ${describeError(e)}`);
                    },
                ),
            ),
        );
        return { sent, failed, skipped };
    }

    /**
     * Stop the bot, cancel a pending polling restart and mark the connection as down
     */
    stop() {
        this.stopping = true;
        if (this.restartTimer) {
            this.adapter.clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        if (this.bot) {
            const bot = this.bot;
            this.bot = null;
            try {
                if (typeof bot.stopPolling === 'function') {
                    bot.stopPolling();
                } else {
                    bot.stop();
                }
            } catch {
                // ignore
            }
        }
        if (this.http) {
            const http = this.http;
            this.http = null;
            http.close().catch(() => {
                // connections are gone anyway
            });
        }
        this.connected = false;
    }

    /**
     * Ensure user objects exist and track user
     *
     * @param {string|number} userId - User ID
     * @param {string} username - Username or display name
     */
    async _handleNewUser(userId, username) {
        const uid = String(userId);
        if (!this.knownUsers.has(uid)) {
            this.knownUsers.add(uid);
            await this.adapter.ensureUserObjects(uid, username);
        }
        await this.adapter.setStateAsync(`users.${uid}.username`, username || uid, true);
    }

    /**
     * Ensure the objects of a group chat exist
     *
     * @param {string|number} chatId - chat ID
     * @param {string} [title] - chat title
     */
    async _handleChat(chatId, title) {
        const cid = String(chatId);
        if (!this.knownChats.has(cid) || title) {
            this.knownChats.add(cid);
            await this.adapter.ensureChatObjects(cid, title);
        }
    }

    /**
     * The group chat of an update, or null for a private dialog
     *
     * @param {{ message?: { recipient?: { chat_type?: string, chat_id?: number | null } } }} ctx - update context
     * @returns {string|number|null} chat ID of a group chat
     */
    _groupChatId(ctx) {
        const recipient = ctx && ctx.message && ctx.message.recipient;
        if (
            recipient &&
            recipient.chat_type === 'chat' &&
            recipient.chat_id !== null &&
            recipient.chat_id !== undefined
        ) {
            return recipient.chat_id;
        }
        return null;
    }

    /**
     * Load already-known users from existing ioBroker objects so that
     * broadcasts keep working after an adapter restart.
     */
    async _loadKnownUsers() {
        await this._loadChannels('users', this.knownUsers);
    }

    /**
     * Load already-known group chats from existing ioBroker objects
     */
    async _loadKnownChats() {
        await this._loadChannels('chats', this.knownChats);
    }

    /**
     * Collect the direct child channels of a folder
     *
     * @param {string} folder - users or chats
     * @param {Set<string>} target - set to fill
     */
    async _loadChannels(folder, target) {
        try {
            const ns = this.adapter.namespace;
            const view = await this.adapter.getObjectViewAsync('system', 'channel', {
                startkey: `${ns}.${folder}.`,
                endkey: `${ns}.${folder}.\u9999`,
            });
            if (view && Array.isArray(view.rows)) {
                for (const row of view.rows) {
                    const id = row.id || (row.value && row.value._id);
                    if (!id) {
                        continue;
                    }
                    const uid = String(id).substring(`${ns}.${folder}.`.length);
                    // only direct children (channels) of the folder
                    if (uid && !uid.includes('.')) {
                        target.add(uid);
                    }
                }
            }
        } catch (e) {
            this.adapter.log.debug(`Could not load known ${folder}: ${e.message}`);
        }
    }

    /**
     * Build a human-readable display name for a MAX user
     *
     * @param {{ user_id?: number, name?: string, username?: string | null }} user - MAX user object
     * @returns {string} display name
     */
    _displayName(user) {
        if (!user) {
            return 'unknown';
        }
        if (user.name) {
            return user.name;
        }
        if (user.username) {
            return user.username;
        }
        return String(user.user_id);
    }

    /**
     * Log a message from a blocked/unknown user (if enabled)
     *
     * @param {string|number} userId - User ID
     * @param {string} text - Message text or event name
     */
    _logBlocked(userId, text) {
        if (this.adapter.config.logUnknownCommands) {
            this.adapter.log.info(`Message from unknown/blocked user ${userId}: ${text}`);
        }
    }

    /**
     * Check if user is allowed
     *
     * @param {string|number} userId - User ID to check
     * @returns {boolean} true if user is allowed
     */
    _isAllowed(userId) {
        const allowed = this.adapter.config.allowedUsers;
        if (!allowed || String(allowed).trim() === '') {
            return true;
        }
        const list = String(allowed)
            .split(',')
            .map(s => s.trim())
            .filter(s => s !== '');
        return list.includes(String(userId));
    }
}

module.exports = BotManager;
