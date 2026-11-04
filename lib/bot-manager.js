'use strict';

/*
 * BotManager — wraps @maxhub/max-bot-api
 * Handles bot lifecycle, message handlers, and sending
 */

const path = require('node:path');
const { Bot } = require('@maxhub/max-bot-api');
const { createMaxFetch, describeError } = require('./max-fetch');
const { uploadMedia } = require('./media');
const { describeAttachments, findVoiceAttachment, downloadVoice, pruneVoiceDir } = require('./voice');
const { findPhotoAttachments, photoFileName, downloadPhoto, prunePhotoDir } = require('./photo');

/** First delay before long polling is restarted after it ended unexpectedly (ms) */
const RESTART_BASE_DELAY = 5000;
/** Upper limit for the restart delay (ms) */
const RESTART_MAX_DELAY = 60000;

/** Prefix of the callback payload of the answers of ask() */
const ASK_PREFIX = 'max-ask:';
/** Default and limits of the answer timeout of ask() (seconds) */
const ASK_TIMEOUT = 60;
const ASK_TIMEOUT_MAX = 3600;

/**
 * Message id of a message returned by the MAX API
 *
 * @param {{ body?: { mid?: string } } | null | undefined} message - message of sendMessageToUser/sendMessageToChat
 * @returns {string | null} mid
 */
function messageIdOf(message) {
    return (message && message.body && message.body.mid) || null;
}

/**
 * Throw when an action of the MAX API (edit, delete) reports a failure
 *
 * @param {{ success?: boolean, message?: string } | null | undefined} result - ActionResponse
 * @param {string} action - name of the action for the error message
 */
function checkAction(result, action) {
    if (result && result.success === false) {
        throw new Error(`${action} failed: ${result.message || 'no reason given'}`);
    }
}

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
        /** open questions of ask(), by id */
        this.pendingAsks = new Map();
        this.askCounter = 0;
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
            const voice = findVoiceAttachment(body);
            const photos = findPhotoAttachments(body);

            if (!this._isAllowed(userId)) {
                this._logBlocked(userId, text || (voice ? '<voice message>' : photos.length > 0 ? '<photo>' : ''));
                return;
            }

            this.adapter.log.debug(`Message from ${userId}${chatId !== null ? ` in chat ${chatId}` : ''}: ${text}`);
            if (body && Array.isArray(body.attachments) && body.attachments.length > 0) {
                this.adapter.log.debug(`Attachments of message ${messageId}: ${describeAttachments(body.attachments)}`);
            }

            try {
                if (chatId !== null) {
                    // group members do not become known users: broadcasts would reach them privately
                    await this._handleChat(chatId);
                    await this.adapter.setStateAsync(`chats.${chatId}.last_user_id`, Number(userId), true);
                    await this.adapter.setStateAsync(`chats.${chatId}.last_username`, username, true);
                } else {
                    await this._handleNewUser(userId, username);
                }

                // Sender and chat are written first: a script triggered by the text reads matching ids
                await this.adapter.setStateAsync('message.chatId', chatId !== null ? Number(chatId) : 0, true);
                await this.adapter.setStateAsync('message.userId', Number(userId), true);

                // Photos come before the caption: request ids, then one communicate.pathFile per photo, then the
                // caption in communicate.request — all with the same requestMessageId
                if (photos.length > 0) {
                    await this._publishPhotos(userId, messageId, chatId, photos);
                }

                // A message without text (e.g. a pure voice message) does not write empty text states:
                // scripts reacting on them would answer an empty command
                if (text !== '') {
                    await this.adapter.setStateAsync('message.received', text, true);
                    if (chatId !== null) {
                        await this.adapter.setStateAsync(`chats.${chatId}.last_message`, text, true);
                    } else {
                        await this.adapter.setStateAsync(`users.${userId}.last_message`, text, true);
                    }
                    await this._publishRequest(userId, username, text, messageId, chatId);
                }
                if (voice) {
                    await this._publishVoice(userId, messageId, chatId, voice);
                }
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
            // the answer of an open question (ask) goes to the waiting script, not to communicate.request
            if (typeof payload === 'string' && payload.startsWith(ASK_PREFIX)) {
                await this._answerAsk(payload, userId, chatId, ctx);
                return;
            }
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
        await this._publishRequestIds(userId, messageId, chatId);
        await this.adapter.setStateAsync('communicate.request', `[${username || userId}]${text}`, true);
    }

    /**
     * Write sender, chat and message id of a request (before communicate.request / communicate.pathFile)
     *
     * @param {string|number} userId - sender
     * @param {string} messageId - MAX message id
     * @param {string|number|null} chatId - group chat, null for a private dialog
     */
    async _publishRequestIds(userId, messageId, chatId) {
        await this.adapter.setStateAsync('communicate.requestChatId', chatId !== null ? Number(chatId) : 0, true);
        await this.adapter.setStateAsync('communicate.requestUserId', Number(userId), true);
        await this.adapter.setStateAsync('communicate.requestMessageId', String(messageId || ''), true);
    }

    /**
     * Download a voice message and publish its path in communicate.pathFile (contract of the Telegram adapter:
     * the request ids are written first, then the path; the path contains the folder /voice/)
     *
     * @param {string|number} userId - sender
     * @param {string} messageId - MAX message id
     * @param {string|number|null} chatId - group chat, null for a private dialog
     * @param {{ type: string, url: string }} voice - voice attachment
     */
    async _publishVoice(userId, messageId, chatId, voice) {
        const dir = this.adapter.voiceDir();
        const fetchFn = this.http ? this.http.fetch : globalThis.fetch;
        let file;
        try {
            file = await downloadVoice(fetchFn, voice.url, dir, messageId);
        } catch (e) {
            this.adapter.log.warn(`Voice message from ${userId} could not be saved: ${describeError(e)}`);
            return;
        }
        try {
            await pruneVoiceDir(dir);
        } catch (e) {
            this.adapter.log.debug(`Could not clean up the voice folder: ${e.message}`);
        }
        // forward slashes on every platform, so that consumers can check for "/voice/"
        const published = file.split(path.sep).join('/');
        // the ids are written right before the path, after the download: they belong to this message
        await this._publishRequestIds(userId, messageId, chatId);
        await this.adapter.setStateAsync('communicate.pathFile', published, true);
        this.adapter.log.debug(`Voice message from ${userId} saved as ${published}`);
    }

    /**
     * Download the photos of a message and publish their paths in communicate.pathFile, one after the other.
     * All photos are downloaded first, then the request ids are written once, then the paths: a script triggered by
     * communicate.pathFile reads the ids of this message.
     *
     * @param {string|number} userId - sender
     * @param {string} messageId - MAX message id
     * @param {string|number|null} chatId - group chat, null for a private dialog
     * @param {{ type: string, url: string }[]} photos - photo attachments
     */
    async _publishPhotos(userId, messageId, chatId, photos) {
        const dir = this.adapter.photoDir();
        const fetchFn = this.http ? this.http.fetch : globalThis.fetch;
        const files = [];
        for (let i = 0; i < photos.length; i++) {
            try {
                files.push(
                    await downloadPhoto(fetchFn, photos[i].url, dir, photoFileName(messageId, i + 1, photos.length)),
                );
            } catch (e) {
                this.adapter.log.warn(
                    `Photo ${i + 1} of ${photos.length} from ${userId} could not be saved: ${describeError(e)}`,
                );
            }
        }
        if (files.length === 0) {
            return;
        }
        try {
            await prunePhotoDir(dir);
        } catch (e) {
            this.adapter.log.debug(`Could not clean up the photo folder: ${e.message}`);
        }
        await this._publishRequestIds(userId, messageId, chatId);
        for (const file of files) {
            // forward slashes on every platform, like the path of a voice message
            const published = file.split(path.sep).join('/');
            await this.adapter.setStateAsync('communicate.pathFile', published, true);
            this.adapter.log.debug(`Photo from ${userId} saved as ${published}`);
        }
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
     * Resolve an open question with the pressed answer
     *
     * @param {string} payload - callback payload "max-ask:<id>:<index>"
     * @param {string|number} userId - user who pressed the button
     * @param {string|number|null} chatId - group chat, null for a private dialog
     * @param {{ callback?: { callback_id?: string } } | null | undefined} ctx - update context
     */
    async _answerAsk(payload, userId, chatId, ctx) {
        const [id, index] = payload.substring(ASK_PREFIX.length).split(':');
        const ask = this.pendingAsks.get(id);
        const fromTarget = ask
            ? ask.chatId !== null
                ? chatId !== null && String(chatId) === String(ask.chatId)
                : chatId === null && String(userId) === String(ask.userId)
            : false;
        const answer = ask && ask.answers[Number(index)];
        if (!ask || !fromTarget || answer === undefined) {
            this.adapter.log.debug(`Ignored answer ${payload} of ${userId}: no matching open question`);
            return;
        }
        this.pendingAsks.delete(id);
        if (ask.timer) {
            this.adapter.clearTimeout(ask.timer);
        }
        const callbackId = ctx && ctx.callback && ctx.callback.callback_id;
        if (callbackId && this.bot) {
            try {
                await this.bot.api.answerOnCallback(callbackId, { notification: answer });
            } catch (e) {
                this.adapter.log.debug(`Could not confirm the answer of ${userId}: ${describeError(e)}`);
            }
        }
        ask.resolve({
            data: String(index),
            text: answer,
            userId: Number(userId),
            chatId: chatId !== null ? Number(chatId) : 0,
            messageId: ask.messageId,
        });
    }

    /**
     * Ask a question with answer buttons and wait for the answer of the recipient
     *
     * @param {{ userId?: string, chatId?: string }} target - one user or one group chat
     * @param {string} text - question
     * @param {string[]} answers - texts of the answer buttons (one row each)
     * @param {{ format?: string, notify?: boolean, timeout?: number }} [options] - format, notification,
     *        answer timeout in seconds (default 60)
     * @returns {Promise<object>} { data: index of the answer, text, userId, chatId, messageId }, or { timeout: true, messageId }
     */
    async ask(target, text, answers, options = {}) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        if (!Array.isArray(answers) || answers.length === 0 || answers.length > 30) {
            throw new Error('ask needs 1 to 30 answers');
        }
        const texts = answers.map(a => (a === null || a === undefined ? '' : String(a).trim()));
        if (texts.some(a => a === '')) {
            throw new Error('ask: every answer needs a text');
        }
        const timeout = Math.min(Math.max(Number(options.timeout) || ASK_TIMEOUT, 1), ASK_TIMEOUT_MAX);
        const id = `${Date.now().toString(36)}${(++this.askCounter).toString(36)}`;
        const keyboard = {
            type: 'inline_keyboard',
            payload: {
                buttons: texts.map((answer, i) => [
                    { type: 'callback', text: answer, payload: `${ASK_PREFIX}${id}:${i}` },
                ]),
            },
        };
        const sendOptions = { format: options.format, notify: options.notify };
        const messageId = target.chatId
            ? await this.sendToChat(target.chatId, text, [keyboard], sendOptions)
            : await this.sendMessage(target.userId, text, [keyboard], sendOptions);
        return new Promise(resolve => {
            const ask = {
                answers: texts,
                userId: target.chatId ? null : String(target.userId),
                chatId: target.chatId ? String(target.chatId) : null,
                messageId,
                resolve,
                timer: null,
            };
            ask.timer = this.adapter.setTimeout(() => {
                this.pendingAsks.delete(id);
                resolve({ timeout: true, messageId });
            }, timeout * 1000);
            this.pendingAsks.set(id, ask);
        });
    }

    /**
     * Edit a sent message
     *
     * @param {string} messageId - MAX message id
     * @param {string | undefined} text - new text (undefined keeps the text)
     * @param {{ type: string, payload: object } | null | undefined} keyboard - new keyboard, null removes it,
     *        undefined keeps the attachments
     * @param {{ format?: string }} [options] - text format
     */
    async editMessage(messageId, text, keyboard, options = {}) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        const extra = {};
        if (text !== undefined) {
            extra.text = text;
        }
        if (options.format) {
            extra.format = options.format;
        }
        if (keyboard !== undefined) {
            extra.attachments = keyboard ? [keyboard] : [];
        }
        checkAction(await this.bot.api.editMessage(String(messageId), extra), 'Edit');
    }

    /**
     * Delete a sent message
     *
     * @param {string} messageId - MAX message id
     */
    async deleteMessage(messageId) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        checkAction(await this.bot.api.deleteMessage(String(messageId)), 'Delete');
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
     * @param {{ notify?: boolean, format?: string }} options - send options; notify: false sends without
     *        notification, format: 'markdown' | 'html'
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
        if (options && options.format) {
            extra.format = options.format;
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
     * @param {{ notify?: boolean, format?: string }} [options] - send options
     * @returns {Promise<string | null>} id of the sent message
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
        const message = extra
            ? await this.bot.api.sendMessageToUser(id, body, extra)
            : await this.bot.api.sendMessageToUser(id, body);
        return messageIdOf(message);
    }

    /**
     * Send a message to a group chat
     *
     * @param {string|number} chatId - chat ID (negative for group chats)
     * @param {string} text - Message text (may be empty when attachments are given)
     * @param {{ type: string, payload: object }[]} [attachments] - prepared attachments
     * @param {{ notify?: boolean, format?: string }} [options] - send options
     * @returns {Promise<string | null>} id of the sent message
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
        const message = extra
            ? await this.bot.api.sendMessageToChat(id, body, extra)
            : await this.bot.api.sendMessageToChat(id, body);
        return messageIdOf(message);
    }

    /**
     * Send a message to all known users that are allowed by the `allowedUsers` setting
     *
     * @param {string} text - Message text to send to all users
     * @param {{ type: string, payload: object }[]} [attachments] - prepared attachments
     * @param {{ notify?: boolean, format?: string }} [options] - send options
     * @returns {Promise<object>} delivery summary { sent, failed, skipped, messages: [{ userId, messageId }],
     *          failures: [{ userId, error }] }
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
            return { sent: 0, failed: 0, skipped, messages: [], failures: [] };
        }
        return { ...(await this._sendToUsers(recipients, text, attachments, options)), skipped };
    }

    /**
     * Send an ioBroker notification: to every user in "Allowed User IDs", or — without that list — to every
     * known user. The setting "Send to all known users" does not apply.
     *
     * @param {string} text - message text
     * @param {{ notify?: boolean, format?: string }} [options] - send options
     * @returns {Promise<object>} delivery summary like sendToAll()
     */
    async notifyAll(text, options = {}) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        const allowed = this._allowedList();
        const recipients = allowed.length > 0 ? allowed : [...this.knownUsers];
        if (recipients.length === 0) {
            this.adapter.log.warn('No users to send the notification to');
            return { sent: 0, failed: 0, skipped: 0, messages: [], failures: [] };
        }
        return { ...(await this._sendToUsers(recipients, text, [], options)), skipped: 0 };
    }

    /**
     * Send one message to several users
     *
     * @param {string[]} recipients - user ids
     * @param {string} text - message text
     * @param {{ type: string, payload: object }[]} attachments - prepared attachments
     * @param {{ notify?: boolean, format?: string }} options - send options
     * @returns {Promise<{ sent: number, failed: number, messages: object[], failures: object[] }>} summary
     */
    async _sendToUsers(recipients, text, attachments, options) {
        const messages = [];
        const failures = [];
        await Promise.all(
            recipients.map(userId =>
                this.sendMessage(userId, text, attachments, options).then(
                    messageId => {
                        messages.push({ userId: Number(userId), messageId });
                    },
                    e => {
                        failures.push({ userId: Number(userId), error: describeError(e) });
                        this.adapter.log.warn(`Failed to send to ${userId}: ${describeError(e)}`);
                    },
                ),
            ),
        );
        return { sent: messages.length, failed: failures.length, messages, failures };
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
        for (const ask of this.pendingAsks.values()) {
            if (ask.timer) {
                this.adapter.clearTimeout(ask.timer);
            }
            ask.resolve({ error: 'Adapter stopped' });
        }
        this.pendingAsks.clear();
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
        const list = this._allowedList();
        return list.length === 0 || list.includes(String(userId));
    }

    /**
     * User ids of the setting "Allowed User IDs"
     *
     * @returns {string[]} ids, empty when every user is allowed
     */
    _allowedList() {
        const allowed = this.adapter.config.allowedUsers;
        if (!allowed || String(allowed).trim() === '') {
            return [];
        }
        return String(allowed)
            .split(',')
            .map(s => s.trim())
            .filter(s => s !== '');
    }
}

module.exports = BotManager;
