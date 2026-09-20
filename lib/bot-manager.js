"use strict";

/*
 * BotManager — wraps @maxhub/max-bot-api
 * Handles bot lifecycle, message handlers, and sending
 */

const { Bot } = require("@maxhub/max-bot-api");

/**
 * BotManager — manages MAX messenger bot lifecycle and message handling.
 */
class BotManager {
  /**
   * @param {import('@iobroker/adapter-core').Adapter} adapter - ioBroker adapter instance
   */
  constructor(adapter) {
    this.adapter = adapter;
    this.bot = null;
    this.knownUsers = new Set();
  }

  /**
   * Start the bot with the given token
   *
   * @param {string} token - MAX bot API token
   */
  async start(token) {
    this.bot = new Bot(token);
    this.setupHandlers();

    await this._loadKnownUsers();

    await this.bot.start();
    this.adapter.log.info(
      `MAX bot started successfully (${this.knownUsers.size} known user(s))`,
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
    this.bot.on("bot_added", (ctx) => {
      this.adapter.log.info(
        `Bot added to chat: ${ctx.chatId !== undefined ? ctx.chatId : "unknown"}`,
      );
    });

    // Bot started by user
    this.bot.on("bot_started", async (ctx) => {
      const user = ctx.user;
      if (!user || user.user_id === undefined) {
        return;
      }
      const userId = user.user_id;
      const username = this._displayName(user);

      if (!this._isAllowed(userId)) {
        this._logBlocked(userId, "bot_started");
        return;
      }

      this.adapter.log.info(`Bot started by user ${userId} (${username})`);

      try {
        await this._handleNewUser(userId, username);
        await this.adapter.setStateAsync(`users.${userId}.started`, true, true);
      } catch (e) {
        this.adapter.log.error(
          `Failed to process bot_started for ${userId}: ${e.message}`,
        );
      }
    });

    // Message received
    this.bot.on("message_created", async (ctx) => {
      const user = ctx.user;
      if (!user || user.user_id === undefined) {
        return;
      }
      const userId = user.user_id;
      const username = this._displayName(user);
      const text =
        (ctx.message && ctx.message.body && ctx.message.body.text) || "";

      if (!this._isAllowed(userId)) {
        this._logBlocked(userId, text);
        return;
      }

      this.adapter.log.debug(`Message from ${userId}: ${text}`);

      try {
        await this._handleNewUser(userId, username);

        // Update states
        await this.adapter.setStateAsync("message.received", text, true);
        await this.adapter.setStateAsync(
          "message.userId",
          Number(userId),
          true,
        );
        await this.adapter.setStateAsync(
          `users.${userId}.last_message`,
          text,
          true,
        );
      } catch (e) {
        this.adapter.log.error(
          `Failed to process message from ${userId}: ${e.message}`,
        );
      }
    });

    // Callback button pressed
    this.bot.on("message_callback", async (ctx) => {
      const user = ctx.user;
      const payload = ctx.callback && ctx.callback.payload;
      if (!user || user.user_id === undefined) {
        return;
      }
      const userId = user.user_id;
      const username = this._displayName(user);

      if (!this._isAllowed(userId)) {
        this._logBlocked(userId, "message_callback");
        return;
      }

      this.adapter.log.debug(`Callback from ${userId}: ${payload}`);

      try {
        await this._handleNewUser(userId, username);
        if (payload !== undefined && payload !== null) {
          await this.adapter.setStateAsync(
            `users.${userId}.callback_data`,
            String(payload),
            true,
          );
        }
      } catch (e) {
        this.adapter.log.error(
          `Failed to process callback from ${userId}: ${e.message}`,
        );
      }
    });

    // Error handler — log but keep the adapter alive instead of crashing
    this.bot.catch((err) => {
      const message =
        err && typeof err === "object" && "message" in err
          ? err.message
          : String(err);
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
      throw new Error("Bot not started");
    }
    const id = Number(userId);
    if (!Number.isFinite(id)) {
      throw new Error(`Invalid userId: ${userId}`);
    }
    // Track the user so that a later broadcast reaches them as well
    this.knownUsers.add(String(userId));
    await this.bot.api.sendMessageToUser(id, text);
  }

  /**
   * Send a message to all known users
   *
   * @param {string} text - Message text to send to all users
   */
  async sendToAll(text) {
    if (!this.bot) {
      throw new Error("Bot not started");
    }
    if (this.knownUsers.size === 0) {
      this.adapter.log.warn("No known users to send the broadcast to");
      return;
    }
    const promises = [];
    for (const userId of this.knownUsers) {
      promises.push(
        this.sendMessage(userId, text).catch((e) => {
          this.adapter.log.warn(`Failed to send to ${userId}: ${e.message}`);
        }),
      );
    }
    await Promise.all(promises);
  }

  /**
   * Stop the bot
   */
  stop() {
    if (this.bot) {
      try {
        this.bot.stop();
      } catch {
        // ignore
      }
      this.bot = null;
    }
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
    await this.adapter.setStateAsync(
      `users.${uid}.username`,
      username || uid,
      true,
    );
  }

  /**
   * Load already-known users from existing ioBroker objects so that
   * broadcasts keep working after an adapter restart.
   */
  async _loadKnownUsers() {
    try {
      const ns = this.adapter.namespace;
      const view = await this.adapter.getObjectViewAsync("system", "channel", {
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
          if (uid && !uid.includes(".")) {
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
      return "unknown";
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
      this.adapter.log.info(
        `Message from unknown/blocked user ${userId}: ${text}`,
      );
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
    if (!allowed || String(allowed).trim() === "") {
      return true;
    }
    const list = String(allowed)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    return list.includes(String(userId));
  }
}

module.exports = BotManager;
