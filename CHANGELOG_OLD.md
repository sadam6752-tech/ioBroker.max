# Older Changelog

### 0.1.5 (2026-09-21)
- (sadam6752-tech) Update `@maxhub/max-bot-api` to 0.3.x - the library now talks to the MAX API host
  `platform-api2.max.ru` (make sure the root certificate of the Russian Ministry of Digital Development
  is in the trust store), plus comments API, sessions/conversation middleware and retry fixes
- (sadam6752-tech) Move the changelog entries for 0.1.0 and 0.1.1 to CHANGELOG_OLD.md (checker W6020)
- (sadam6752-tech) Update `@alcalzone/release-script-plugin-license` to 5.2.2 (checker S0064)

### 0.1.4 (2026-09-21)
- (sadam6752-tech) **HOTFIX for 0.1.3**: declaring the bot token as `protectedNative` / `encryptedNative`
  made the js-controller transform previously stored plain text tokens into unusable data before the
  adapter started, so the adapter could no longer authenticate against the MAX API. `encryptedNative`
  has been removed again — the token is only declared as `protectedNative`, stored tokens keep working
- (sadam6752-tech) Unusable tokens are detected on startup and reported, so the token can simply be
  entered again; new `lib/secrets.js` plus unit tests for the repair logic

### 0.1.3 (2026-09-20)
- (sadam6752-tech) Store the bot token as protected and encrypted native field (`protectedNative` / `encryptedNative`) so other adapters cannot read it
- (sadam6752-tech) `.releaseconfig.json` migrated to the plugin array format
- (sadam6752-tech) Added `prettier.config.mjs` and complete VSCode JSON schema mappings (io-package, package, jsonConfig/jsonCustom/jsonTab)
- (sadam6752-tech) Removed obsolete devDependencies (mocha, eslint plugins, prettier, typescript-eslint), updated `@alcalzone/release-script` to 5.2.x and `@iobroker/testing` to 6.x
- (sadam6752-tech) CI: added Node.js 26 to the test matrix and resynced `package-lock.json` so `npm ci` succeeds again
- (sadam6752-tech) Added unit tests for the bot manager (`npm run test:js`), `npm test` now runs package and unit tests
- (sadam6752-tech) README: removed direct npm installation instructions, added license and copyright section
- (sadam6752-tech) 0.1.2 was never published to npm — its changes are included in 0.1.3

### 0.1.2 (2026-09-20)
- (sadam6752-tech) Honor the `sendToAllUsers` setting: broadcasts are only sent when it is enabled
- (sadam6752-tech) Apply the allowed-users filter to all incoming events (`bot_started`, `message_created`, `message_callback`)
- (sadam6752-tech) Reload known users on adapter restart so broadcasts keep working
- (sadam6752-tech) Use `setStateAsync`/`extendObjectAsync`/`subscribeStatesAsync` consistently
- (sadam6752-tech) Add CI workflow, dependabot config, `tsconfig.json` and VSCode JSON schemas

### 0.1.1 (2026-03-30)
- (sadam6752-tech) Add CI/CD workflow, dependabot, release-script
- (sadam6752-tech) Fix async onUnload, null references after cleanup
- (sadam6752-tech) Fix object hierarchy: add parent 'users' channel
- (sadam6752-tech) Fix JSDoc descriptions

### 0.1.0 (2026-03-18)
- Initial release: MAX messenger bot integration for ioBroker
