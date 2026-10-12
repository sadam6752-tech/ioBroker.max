'use strict';

/*
 * BotManager — wraps @maxhub/max-bot-api
 * Handles bot lifecycle, message handlers, and sending
 */

const { Bot } = require('@maxhub/max-bot-api');
const { createMaxFetch, describeError } = require('./max-fetch');

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

        // Bot added to chat
        this.bot.on('bot_added', ctx => {
            this.adapter.log.info(`Bot added to chat: ${ctx.chatId !== undefined ? ctx.chatId : 'unknown'}`);
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

        // Message received
        this.bot.on('message_created', async ctx => {
            const user = ctx.user;
            if (!user || user.user_id === undefined) {
                return;
            }
            const userId = user.user_id;
            const username = this._displayName(user);
            const text = (ctx.message && ctx.message.body && ctx.message.body.text) || '';

            if (!this._isAllowed(userId)) {
                this._logBlocked(userId, text);
                return;
            }

            this.adapter.log.debug(`Message from ${userId}: ${text}`);

            try {
                await this._handleNewUser(userId, username);

                // Update states
                await this.adapter.setStateAsync('message.received', text, true);
                await this.adapter.setStateAsync('message.userId', Number(userId), true);
                await this.adapter.setStateAsync(`users.${userId}.last_message`, text, true);
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

            if (!this._isAllowed(userId)) {
                this._logBlocked(userId, 'message_callback');
                return;
            }

            this.adapter.log.debug(`Callback from ${userId}: ${payload}`);

            try {
                await this._handleNewUser(userId, username);
                if (payload !== undefined && payload !== null) {
                    await this.adapter.setStateAsync(`users.${userId}.callback_data`, String(payload), true);
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
     * Send a message to a specific user
     *
     * @param {string|number} userId - User ID to send message to
     * @param {string} text - Message text
     */
    async sendMessage(userId, text) {
        if (!this.bot) {
            throw new Error('Bot not started');
        }
        const id = Number(String(userId).trim());
        if (String(userId).trim() === '' || !Number.isSafeInteger(id)) {
            throw new Error(`Invalid userId: ${userId}`);
        }
        // knownUsers is not touched here: a user becomes known (with objects) only after contacting the bot
        await this.bot.api.sendMessageToUser(id, text);
    }

    /**
     * Send a message to all known users that are allowed by the `allowedUsers` setting
     *
     * @param {string} text - Message text to send to all users
     * @returns {Promise<{sent: number, failed: number, skipped: number}>} delivery summary
     */
    async sendToAll(text) {
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
                this.sendMessage(userId, text).then(
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
     * Load already-known users from existing ioBroker objects so that
     * broadcasts keep working after an adapter restart.
     */
    async _loadKnownUsers() {
        try {
            const ns = this.adapter.namespace;
            const view = await this.adapter.getObjectViewAsync('system', 'channel', {
                startkey: `${ns}.users.`,
                endkey: `${ns}.users.\u9999`,
            });
            if (view && Array.isArray(view.rows)) {
                for (const row of view.rows) {
                    const id = row.id || (row.value && row.value._id);
                    if (!id) {
                        continue;
                    }
                    const uid = String(id).substring(`${ns}.users.`.length);
                    // only direct children (channels) of the users folder
                    if (uid && !uid.includes('.')) {
                        this.knownUsers.add(uid);
                    }
                }
            }
        } catch (e) {
            this.adapter.log.debug(`Could not load known users: ${e.message}`);
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
