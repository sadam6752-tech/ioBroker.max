"use strict";

/*
 * BotManager — wraps @maxhub/max-bot-api
 * Handles bot lifecycle, message handlers, and sending
 */

const { Bot } = require("@maxhub/max-bot-api");

class BotManager {
  /**
   * @param {import('../main')} adapter
   */
  constructor(adapter) {
    this.adapter = adapter;
    this.bot = null;
    this.knownUsers = new Set();
  }

  /**
   * Start the bot with the given token
   *
   * @param {string} token
   */
  async start(token) {
    this.bot = new Bot(token);
    this.setupHandlers();

    await this.bot.start();
    this.adapter.log.info("MAX bot started successfully");
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
      this.adapter.log.info(`Bot added to chat: ${ctx.chat_id || "unknown"}`);
    });

    // Bot started by user
    this.bot.on("bot_started", async (ctx) => {
      const userId = ctx.user && ctx.user.user_id;
      const username =
        ctx.user && (ctx.user.name || ctx.user.username || String(userId));
      if (userId) {
        this.adapter.log.info(`Bot started by user ${userId} (${username})`);
        await this._handleNewUser(userId, username);
      }
    });

    // Message received
    this.bot.on("message_created", async (ctx) => {
      const userId = ctx.user && ctx.user.user_id;
      const username =
        ctx.user && (ctx.user.name || ctx.user.username || String(userId));
      const text = ctx.message && ctx.message.body && ctx.message.body.text;

      if (!userId || !text) {
        return;
      }

      this.adapter.log.debug(`Message from ${userId}: ${text}`);

      // Check allowed users
      if (!this._isAllowed(userId)) {
        if (this.adapter.config.logUnknownCommands) {
          this.adapter.log.info(
            `Message from unknown/blocked user ${userId}: ${text}`,
          );
        }
        return;
      }

      await this._handleNewUser(userId, username);

      // Update states
      await this.adapter.setStateAsync("message.received", text, true);
      await this.adapter.setStateAsync("message.userId", Number(userId), true);
      await this.adapter.setStateAsync(
        `users.${userId}.last_message`,
        text,
        true,
      );
    });

    // Callback button pressed
    this.bot.on("message_callback", async (ctx) => {
      const userId = ctx.user && ctx.user.user_id;
      const payload = ctx.callback && ctx.callback.payload;

      if (!userId || !payload) {
        return;
      }

      this.adapter.log.debug(`Callback from ${userId}: ${payload}`);
      await this.adapter.setStateAsync(
        `users.${userId}.callback_data`,
        payload,
        true,
      );
    });

    // Error handler
    this.bot.catch((err) => {
      this.adapter.log.error(`MAX bot error: ${err.message || err}`);
    });
  }

  /**
   * Send a message to a specific user
   *
   * @param {string|number} userId
   * @param {string} text
   */
  async sendMessage(userId, text) {
    if (!this.bot) {
      throw new Error("Bot not started");
    }
    await this.bot.api.sendMessageToUser(String(userId), text);
  }

  /**
   * Send a message to all known users
   *
   * @param {string} text
   */
  async sendToAll(text) {
    if (!this.bot) {
      throw new Error("Bot not started");
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
   * @param {string|number} userId
   * @param {string} username
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
   * Check if user is allowed
   *
   * @param {string|number} userId
   * @returns {boolean}
   */
  _isAllowed(userId) {
    const allowed = this.adapter.config.allowedUsers;
    if (!allowed || allowed.trim() === "") {
      return true;
    }
    const list = allowed.split(",").map((s) => s.trim());
    return list.includes(String(userId));
  }
}

module.exports = BotManager;
