'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { tests } = require('@iobroker/testing');
const { controllerDecrypt } = require('./lib/controller-crypto');

/** a made-up token in the shape of a MAX bot token (the MAX API rejects it, which is fine here) */
const PLAIN_TOKEN = 'f9LHodD0cOKqPUSCZwXjp4Vw3pHtcvWw7m8nGgN1bQcR8sKzT2yXe5JaUiVb';

/**
 * @param {number} ms - milliseconds
 * @returns {Promise<void>} resolves after the delay
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Token storage', getHarness => {
            it('moves a plain text token into encrypted storage', async function () {
                this.timeout(90000);
                const harness = getHarness();

                // state of an installation before v0.1.12: the token is stored as plain text.
                // changeAdapterConfig() would encrypt it, so the object is written directly.
                const instance = await harness.objects.getObjectAsync('system.adapter.max.0');
                instance.native.token = PLAIN_TOKEN;
                await harness.objects.setObjectAsync('system.adapter.max.0', instance);
                await harness.startAdapterAndWait();

                let stored = PLAIN_TOKEN;
                for (let i = 0; i < 60 && stored === PLAIN_TOKEN; i++) {
                    await delay(500);
                    const obj = await harness.objects.getObjectAsync('system.adapter.max.0');
                    stored = obj.native.token;
                }
                assert.notEqual(stored, PLAIN_TOKEN, 'the token is still stored as plain text');

                // the js-controller must be able to decrypt the stored value back to the token
                const systemConfig = await harness.objects.getObjectAsync('system.config');
                const secret = systemConfig.native.secret;
                assert.equal(controllerDecrypt(secret, stored), PLAIN_TOKEN);
                if (/^[0-9a-f]{48}$/.test(secret)) {
                    assert.match(stored, /^\$\/aes-192-cbc:/);
                }
            });
        });
    },
});
