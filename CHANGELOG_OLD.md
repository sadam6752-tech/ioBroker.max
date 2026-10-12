# Older Changelog

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
