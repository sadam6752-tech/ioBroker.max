'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LANGUAGES = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

/**
 * Object whose every method returns the object itself (chained Blockly calls in init())
 *
 * @returns {object} chainable mock
 */
function chain() {
    const target = { connection: { _optional: false } };
    const proxy = new Proxy(target, {
        get: (obj, key) => (key in obj ? obj[key] : () => proxy),
    });
    return proxy;
}

/**
 * Load admin/blockly.js with a minimal Blockly
 *
 * @param {string[]} [instances] - instances known to the admin
 * @returns {object} the Blockly mock after loading
 */
function loadBlockly(instances = ['system.adapter.max.0', 'system.adapter.max.2', 'system.adapter.telegram.0']) {
    const Field = class {
        constructor(options) {
            this.options = options;
        }
    };
    const Blockly = {
        Words: {},
        Blocks: {},
        Sendto: { blocks: {}, HUE: 190 },
        FieldDropdown: Field,
        FieldCheckbox: Field,
        FieldTextInput: Field,
        JavaScript: {
            forBlock: {},
            ORDER_ATOMIC: 0,
            INDENT: '  ',
            valueToCode: (block, name) => block.values[name] || '',
            statementToCode: (block, name) => block.statements[name] || '',
            prefixLines: (code, indent) =>
                code
                    .split('\n')
                    .map(line => (line ? indent + line : line))
                    .join('\n'),
        },
    };
    const window = { Blockly, systemLang: 'ru', main: { instances } };
    const code = fs.readFileSync(path.join(__dirname, '..', 'admin', 'blockly.js'), 'utf8');
    vm.runInNewContext(code, { window, document: {}, setTimeout, console });
    return Blockly;
}

/**
 * Fake block for a generator
 *
 * @param {Record<string, string>} fields - field values
 * @param {Record<string, string>} [values] - code of value inputs
 * @param {Record<string, string>} [statements] - code of statement inputs
 * @param {number} [itemCount] - number of answers (max_ask)
 * @returns {object} block
 */
function fakeBlock(fields, values = {}, statements = {}, itemCount = 0) {
    return { getFieldValue: name => fields[name], values, statements, itemCount_: itemCount };
}

/**
 * Check that generated code is valid JavaScript and return the sendTo calls it makes
 *
 * @param {string} code - generated code
 * @returns {{ calls: unknown[][], logs: unknown[] }} recorded calls
 */
function run(code) {
    const calls = [];
    const logs = [];
    const sendTo = (...args) => calls.push(args);
    const cons = { log: (...a) => logs.push(a), debug: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) };
    new Function('sendTo', 'console', code)(sendTo, cons);
    return { calls, logs };
}

describe('admin/blockly.js', () => {
    let Blockly;

    beforeEach(() => {
        Blockly = loadBlockly();
    });

    it('registers the blocks max and max_ask in the sendTo category', () => {
        assert.ok(Blockly.Blocks.max);
        assert.ok(Blockly.Blocks.max_ask);
        assert.ok(Blockly.Blocks.max_ask_container);
        assert.ok(Blockly.Blocks.max_ask_mutator);
        assert.match(Blockly.Sendto.blocks.max, /<block type="max">/);
        assert.match(Blockly.Sendto.blocks.max_ask, /<block type="max_ask">/);
        assert.equal(typeof Blockly.JavaScript.forBlock.max, 'function');
        assert.equal(typeof Blockly.JavaScript.forBlock.max_ask, 'function');
    });

    it('builds both blocks without errors', () => {
        for (const type of ['max', 'max_ask', 'max_ask_container', 'max_ask_mutator']) {
            const block = chain();
            block.setMutator = () => {};
            assert.doesNotThrow(() => Blockly.Blocks[type].init.call(block), type);
        }
    });

    it('offers the installed instances of max', () => {
        let options;
        const block = chain();
        const appendDummyInput = block.appendDummyInput;
        block.appendDummyInput = name => {
            const input = appendDummyInput(name);
            if (name === 'INSTANCE') {
                return {
                    appendField: () => ({
                        appendField: field => {
                            options = field.options;
                            return input;
                        },
                    }),
                };
            }
            return input;
        };
        Blockly.Blocks.max.init.call(block);
        // the options come from the sandbox: compare the content, not the prototypes
        assert.deepEqual(JSON.parse(JSON.stringify(options)), [
            ['все экземпляры', ''],
            ['max.0', '.0'],
            ['max.2', '.2'],
        ]);
    });

    it('has every text in all eleven languages', () => {
        const keys = Object.keys(Blockly.Words).filter(k => k.startsWith('max') && !k.endsWith('_help'));
        assert.ok(keys.length > 20);
        for (const key of keys) {
            assert.deepEqual(Object.keys(Blockly.Words[key]).sort(), [...LANGUAGES].sort(), key);
        }
    });

    describe('generator max', () => {
        const generate = (fields, values) =>
            Blockly.JavaScript.forBlock.max(
                fakeBlock({ INSTANCE: '.0', FORMAT: 'default', SILENT: 'FALSE', ATTACHMENT_TYPE: 'none', LOG: '', ...fields }, values),
            );

        it('sends a text to all users', () => {
            const code = generate({}, { MESSAGE: "'Hello'" });
            assert.deepEqual(run(code).calls, [['max.0', 'send', { text: 'Hello' }]]);
        });

        it('sends to a user with format, without notification and with an image', () => {
            const code = generate(
                { FORMAT: 'html', SILENT: 'TRUE', ATTACHMENT_TYPE: 'image' },
                { MESSAGE: "'<b>Door</b>'", USERID: '123456', ATTACHMENT: "'/tmp/a.jpg'" },
            );
            assert.deepEqual(run(code).calls, [
                ['max.0', 'send', { text: '<b>Door</b>', userId: 123456, format: 'html', notify: false, image: '/tmp/a.jpg' }],
            ]);
        });

        it('sends a file to a group chat of any instance', () => {
            const code = generate(
                { INSTANCE: '', ATTACHMENT_TYPE: 'file' },
                { MESSAGE: "'Report'", CHATID: '-987654321', ATTACHMENT: "'/opt/r.pdf'" },
            );
            assert.deepEqual(run(code).calls, [['max', 'send', { text: 'Report', chatId: -987654321, file: '/opt/r.pdf' }]]);
        });

        it('ignores an attachment path without a type', () => {
            const code = generate({}, { MESSAGE: "'x'", ATTACHMENT: "'/tmp/a.jpg'" });
            assert.deepEqual(run(code).calls[0][2], { text: 'x' });
        });

        it('writes a log line', () => {
            const code = generate({ LOG: 'log' }, { MESSAGE: "'x'" });
            assert.deepEqual(run(code).logs, [['max: x']]);
        });
    });

    describe('generator max_ask', () => {
        it('asks with answers and runs the branch of the answer', () => {
            const code = Blockly.JavaScript.forBlock.max_ask(
                fakeBlock(
                    { INSTANCE: '.0', FORMAT: 'markdown', LOG: '' },
                    { QUESTION: "'Open the gate?'", USERID: '5', ANSWER_0: "'Yes'", ANSWER_1: "'No'" },
                    { STATEMENT_0: "opened = true;\n", STATEMENT_1: "opened = false;\n" },
                    2,
                ),
            );
            const { calls } = run(`let opened;\n${code}\nglobalThis.__opened = () => opened;`);
            assert.equal(calls.length, 1);
            const [target, command, message, callback] = calls[0];
            assert.equal(target, 'max.0');
            assert.equal(command, 'ask');
            assert.deepEqual(message, { text: 'Open the gate?', userId: 5, format: 'markdown', answers: ['Yes', 'No'] });
            assert.equal(typeof callback, 'function');
        });

        it('generates code whose callback picks the right branch', async () => {
            const code = Blockly.JavaScript.forBlock.max_ask(
                fakeBlock(
                    { INSTANCE: '.0', FORMAT: 'default', LOG: 'log' },
                    { QUESTION: "'Q?'", CHATID: '-100', ANSWER_0: "'A'", ANSWER_1: "'B'" },
                    { STATEMENT_0: "result.push('A');\n", STATEMENT_1: "result.push('B');\n" },
                    2,
                ),
            );
            const result = [];
            const calls = [];
            const logs = [];
            new Function('sendTo', 'console', 'result', code)(
                (...a) => calls.push(a),
                { log: (...a) => logs.push(a) },
                result,
            );
            await calls[0][3]({ data: '1', text: 'B' });
            await calls[0][3]({ timeout: true });
            assert.deepEqual(result, ['B']);
            assert.deepEqual(calls[0][2].chatId, -100);
            assert.ok(logs.some(l => l[0] === 'max ask answer: B'));
            assert.ok(logs.some(l => l[0] === 'max ask answer: [no answer]'));
        });
    });
});
