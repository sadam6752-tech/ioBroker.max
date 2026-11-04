/* global window, document */
'use strict';

/*
 * Blockly blocks of ioBroker.max for the JavaScript adapter (common.blockly: true):
 * - "max":     send a message — sendTo('max.N', 'send', { ... })
 * - "max_ask": question with answer buttons and one branch per answer — sendTo('max.N', 'ask', { ... }, callback)
 * Built after the blocks of ioBroker.telegram 6.1.0.
 */
(() => {
    const Blockly = window.Blockly;
    const README = 'https://github.com/sadam6752-tech/ioBroker.max/blob/main/README.md';

    // ---- translations ------------------------------------------------------------------------------
    const WORDS = {
        max: {
            en: 'MAX',
            de: 'MAX',
            ru: 'MAX',
            pt: 'MAX',
            nl: 'MAX',
            fr: 'MAX',
            it: 'MAX',
            es: 'MAX',
            pl: 'MAX',
            uk: 'MAX',
            'zh-cn': 'MAX',
        },
        max_anyInstance: {
            en: 'all instances',
            de: 'alle Instanzen',
            ru: 'все экземпляры',
            pt: 'todas as instâncias',
            nl: 'alle instanties',
            fr: 'toutes les instances',
            it: 'tutte le istanze',
            es: 'todas las instancias',
            pl: 'wszystkie instancje',
            uk: 'усі екземпляри',
            'zh-cn': '所有实例',
        },
        max_message: {
            en: 'message',
            de: 'Meldung',
            ru: 'сообщение',
            pt: 'mensagem',
            nl: 'bericht',
            fr: 'message',
            it: 'messaggio',
            es: 'mensaje',
            pl: 'wiadomość',
            uk: 'повідомлення',
            'zh-cn': '消息',
        },
        max_userid: {
            en: 'user ID (optional)',
            de: 'Benutzer-ID (optional)',
            ru: 'ID пользователя (необязательно)',
            pt: 'ID do utilizador (opcional)',
            nl: 'gebruikers-ID (optioneel)',
            fr: 'ID utilisateur (facultatif)',
            it: 'ID utente (opzionale)',
            es: 'ID de usuario (opcional)',
            pl: 'ID użytkownika (opcjonalnie)',
            uk: 'ID користувача (необов’язково)',
            'zh-cn': '用户 ID（可选）',
        },
        max_chatid: {
            en: 'group chat ID (optional)',
            de: 'Gruppenchat-ID (optional)',
            ru: 'ID группы (необязательно)',
            pt: 'ID do chat de grupo (opcional)',
            nl: 'groepschat-ID (optioneel)',
            fr: 'ID du groupe (facultatif)',
            it: 'ID della chat di gruppo (opzionale)',
            es: 'ID del chat de grupo (opcional)',
            pl: 'ID czatu grupowego (opcjonalnie)',
            uk: 'ID групи (необов’язково)',
            'zh-cn': '群聊 ID（可选）',
        },
        max_format: {
            en: 'format',
            de: 'Format',
            ru: 'формат',
            pt: 'formato',
            nl: 'opmaak',
            fr: 'format',
            it: 'formato',
            es: 'formato',
            pl: 'format',
            uk: 'формат',
            'zh-cn': '格式',
        },
        max_format_default: {
            en: 'plain text',
            de: 'reiner Text',
            ru: 'обычный текст',
            pt: 'texto simples',
            nl: 'platte tekst',
            fr: 'texte brut',
            it: 'testo semplice',
            es: 'texto plano',
            pl: 'zwykły tekst',
            uk: 'звичайний текст',
            'zh-cn': '纯文本',
        },
        max_silent: {
            en: 'without notification',
            de: 'ohne Benachrichtigung',
            ru: 'без уведомления',
            pt: 'sem notificação',
            nl: 'zonder melding',
            fr: 'sans notification',
            it: 'senza notifica',
            es: 'sin notificación',
            pl: 'bez powiadomienia',
            uk: 'без сповіщення',
            'zh-cn': '无通知',
        },
        max_attachment: {
            en: 'attachment',
            de: 'Anhang',
            ru: 'вложение',
            pt: 'anexo',
            nl: 'bijlage',
            fr: 'pièce jointe',
            it: 'allegato',
            es: 'adjunto',
            pl: 'załącznik',
            uk: 'вкладення',
            'zh-cn': '附件',
        },
        max_attachment_none: {
            en: 'none',
            de: 'keiner',
            ru: 'нет',
            pt: 'nenhum',
            nl: 'geen',
            fr: 'aucune',
            it: 'nessuno',
            es: 'ninguno',
            pl: 'brak',
            uk: 'немає',
            'zh-cn': '无',
        },
        max_attachment_image: {
            en: 'image',
            de: 'Bild',
            ru: 'картинка',
            pt: 'imagem',
            nl: 'afbeelding',
            fr: 'image',
            it: 'immagine',
            es: 'imagen',
            pl: 'obraz',
            uk: 'зображення',
            'zh-cn': '图片',
        },
        max_attachment_file: {
            en: 'file',
            de: 'Datei',
            ru: 'файл',
            pt: 'ficheiro',
            nl: 'bestand',
            fr: 'fichier',
            it: 'file',
            es: 'archivo',
            pl: 'plik',
            uk: 'файл',
            'zh-cn': '文件',
        },
        max_attachment_video: {
            en: 'video',
            de: 'Video',
            ru: 'видео',
            pt: 'vídeo',
            nl: 'video',
            fr: 'vidéo',
            it: 'video',
            es: 'vídeo',
            pl: 'wideo',
            uk: 'відео',
            'zh-cn': '视频',
        },
        max_attachment_audio: {
            en: 'audio',
            de: 'Audio',
            ru: 'аудио',
            pt: 'áudio',
            nl: 'audio',
            fr: 'audio',
            it: 'audio',
            es: 'audio',
            pl: 'dźwięk',
            uk: 'аудіо',
            'zh-cn': '音频',
        },
        max_attachment_source: {
            en: 'path or URL',
            de: 'Pfad oder URL',
            ru: 'путь или URL',
            pt: 'caminho ou URL',
            nl: 'pad of URL',
            fr: 'chemin ou URL',
            it: 'percorso o URL',
            es: 'ruta o URL',
            pl: 'ścieżka lub URL',
            uk: 'шлях або URL',
            'zh-cn': '路径或 URL',
        },
        max_log: {
            en: 'log level',
            de: 'Loglevel',
            ru: 'уровень лога',
            pt: 'nível de registo',
            nl: 'logniveau',
            fr: 'niveau de journal',
            it: 'livello di log',
            es: 'nivel de registro',
            pl: 'poziom logu',
            uk: 'рівень журналу',
            'zh-cn': '日志级别',
        },
        max_log_none: {
            en: 'none',
            de: 'keins',
            ru: 'нет',
            pt: 'nenhum',
            nl: 'geen',
            fr: 'aucun',
            it: 'nessuno',
            es: 'ninguno',
            pl: 'brak',
            uk: 'немає',
            'zh-cn': '无',
        },
        max_log_debug: {
            en: 'debug',
            de: 'debug',
            ru: 'debug',
            pt: 'debug',
            nl: 'debug',
            fr: 'debug',
            it: 'debug',
            es: 'debug',
            pl: 'debug',
            uk: 'debug',
            'zh-cn': 'debug',
        },
        max_log_info: {
            en: 'info',
            de: 'info',
            ru: 'info',
            pt: 'info',
            nl: 'info',
            fr: 'info',
            it: 'info',
            es: 'info',
            pl: 'info',
            uk: 'info',
            'zh-cn': 'info',
        },
        max_log_warn: {
            en: 'warning',
            de: 'Warnung',
            ru: 'предупреждение',
            pt: 'aviso',
            nl: 'waarschuwing',
            fr: 'avertissement',
            it: 'avviso',
            es: 'advertencia',
            pl: 'ostrzeżenie',
            uk: 'попередження',
            'zh-cn': '警告',
        },
        max_log_error: {
            en: 'error',
            de: 'Fehler',
            ru: 'ошибка',
            pt: 'erro',
            nl: 'fout',
            fr: 'erreur',
            it: 'errore',
            es: 'error',
            pl: 'błąd',
            uk: 'помилка',
            'zh-cn': '错误',
        },
        max_tooltip: {
            en: 'Send a message via the MAX messenger. Without user ID and group chat ID it goes to all known users.',
            de: 'Nachricht über den MAX-Messenger senden. Ohne Benutzer-ID und Gruppenchat-ID geht sie an alle bekannten Benutzer.',
            ru: 'Отправить сообщение через мессенджер MAX. Без ID пользователя и ID группы — всем известным пользователям.',
            pt: 'Enviar uma mensagem pelo MAX. Sem ID de utilizador e de grupo vai para todos os utilizadores conhecidos.',
            nl: 'Een bericht via MAX versturen. Zonder gebruikers-ID en groepschat-ID gaat het naar alle bekende gebruikers.',
            fr: 'Envoyer un message via MAX. Sans ID utilisateur ni ID de groupe, il part à tous les utilisateurs connus.',
            it: 'Invia un messaggio tramite MAX. Senza ID utente e ID gruppo va a tutti gli utenti conosciuti.',
            es: 'Enviar un mensaje por MAX. Sin ID de usuario ni de grupo va a todos los usuarios conocidos.',
            pl: 'Wyślij wiadomość przez MAX. Bez ID użytkownika i ID grupy trafia do wszystkich znanych użytkowników.',
            uk: 'Надіслати повідомлення через MAX. Без ID користувача й ID групи — усім відомим користувачам.',
            'zh-cn': '通过 MAX 发送消息。不填用户 ID 和群聊 ID 时发送给所有已知用户。',
        },
        max_ask: {
            en: 'ask via MAX',
            de: 'über MAX fragen',
            ru: 'спросить в MAX',
            pt: 'perguntar pelo MAX',
            nl: 'vragen via MAX',
            fr: 'demander via MAX',
            it: 'chiedi tramite MAX',
            es: 'preguntar por MAX',
            pl: 'zapytaj przez MAX',
            uk: 'запитати в MAX',
            'zh-cn': '通过 MAX 询问',
        },
        max_ask_question: {
            en: 'question',
            de: 'Frage',
            ru: 'вопрос',
            pt: 'pergunta',
            nl: 'vraag',
            fr: 'question',
            it: 'domanda',
            es: 'pregunta',
            pl: 'pytanie',
            uk: 'питання',
            'zh-cn': '问题',
        },
        max_ask_answers: {
            en: 'answers',
            de: 'Antworten',
            ru: 'ответы',
            pt: 'respostas',
            nl: 'antwoorden',
            fr: 'réponses',
            it: 'risposte',
            es: 'respuestas',
            pl: 'odpowiedzi',
            uk: 'відповіді',
            'zh-cn': '答案',
        },
        max_ask_answer: {
            en: 'answer',
            de: 'Antwort',
            ru: 'ответ',
            pt: 'resposta',
            nl: 'antwoord',
            fr: 'réponse',
            it: 'risposta',
            es: 'respuesta',
            pl: 'odpowiedź',
            uk: 'відповідь',
            'zh-cn': '答案',
        },
        max_ask_tooltip: {
            en: 'Ask a question with answer buttons; the branch of the pressed answer runs. Needs a user ID or a group chat ID.',
            de: 'Frage mit Antwort-Tasten stellen; der Zweig der gedrückten Antwort läuft. Benötigt Benutzer-ID oder Gruppenchat-ID.',
            ru: 'Задать вопрос с кнопками ответа; выполняется ветка нажатого ответа. Нужен ID пользователя или ID группы.',
            pt: 'Fazer uma pergunta com botões de resposta; corre o ramo da resposta escolhida. Precisa de ID de utilizador ou de grupo.',
            nl: 'Een vraag met antwoordknoppen stellen; de tak van het gekozen antwoord wordt uitgevoerd. Vereist gebruikers- of groepschat-ID.',
            fr: 'Poser une question avec des boutons de réponse ; la branche de la réponse choisie s’exécute. ID utilisateur ou de groupe requis.',
            it: 'Fai una domanda con pulsanti di risposta; viene eseguito il ramo della risposta scelta. Serve un ID utente o di gruppo.',
            es: 'Hacer una pregunta con botones de respuesta; se ejecuta la rama de la respuesta elegida. Requiere ID de usuario o de grupo.',
            pl: 'Zadaj pytanie z przyciskami odpowiedzi; wykona się gałąź wybranej odpowiedzi. Wymaga ID użytkownika lub grupy.',
            uk: 'Поставити питання з кнопками відповіді; виконується гілка натиснутої відповіді. Потрібен ID користувача або групи.',
            'zh-cn': '发送带答案按钮的问题；执行所选答案的分支。需要用户 ID 或群聊 ID。',
        },
    };

    if (!Blockly.Translate) {
        Blockly.Translate = function (word, lang) {
            lang = lang || window.systemLang;
            const entry = Blockly.Words && Blockly.Words[word];
            return entry ? entry[lang || 'en'] || entry.en : word;
        };
    }
    Blockly.Words = Blockly.Words || {};
    Object.assign(Blockly.Words, WORDS);
    Blockly.Words.max_help = { en: README };
    Blockly.Words.max_ask_help = { en: `${README}#blockly` };

    // ---- helpers -----------------------------------------------------------------------------------
    /** @returns {string[][]} instances of the adapter: '' = all, '.0', '.1', ... */
    function instanceOptions() {
        const options = [[Blockly.Translate('max_anyInstance'), '']];
        const instances = window.main && window.main.instances;
        if (instances) {
            for (let i = 0; i < instances.length; i++) {
                const m = String(instances[i]).match(/^system\.adapter\.max\.(\d+)$/);
                if (m) {
                    options.push([`max.${m[1]}`, `.${m[1]}`]);
                }
            }
        }
        if (options.length === 1) {
            for (let n = 0; n <= 4; n++) {
                options.push([`max.${n}`, `.${n}`]);
            }
        }
        return options;
    }

    /** @returns {string[][]} log levels */
    function logLevelOptions() {
        return [
            [Blockly.Translate('max_log_none'), ''],
            [Blockly.Translate('max_log_debug'), 'debug'],
            [Blockly.Translate('max_log_info'), 'log'],
            [Blockly.Translate('max_log_warn'), 'warn'],
            [Blockly.Translate('max_log_error'), 'error'],
        ];
    }

    /** @returns {string[][]} text formats */
    function formatOptions() {
        return [
            [Blockly.Translate('max_format_default'), 'default'],
            ['Markdown', 'markdown'],
            ['HTML', 'html'],
        ];
    }

    /** @returns {string[][]} attachment types */
    function attachmentOptions() {
        return [
            [Blockly.Translate('max_attachment_none'), 'none'],
            [Blockly.Translate('max_attachment_image'), 'image'],
            [Blockly.Translate('max_attachment_file'), 'file'],
            [Blockly.Translate('max_attachment_video'), 'video'],
            [Blockly.Translate('max_attachment_audio'), 'audio'],
        ];
    }

    /**
     * Log line of the generated code
     *
     * @param {string} logLevel - console method or ''
     * @param {string} prefix - prefix of the line
     * @param {string} text - code of the text
     * @returns {string} code
     */
    function logLine(logLevel, prefix, text) {
        if (!logLevel) {
            return '';
        }
        return `console.${logLevel}('${prefix}: '${text ? ` + ${text}` : ''});\n`;
    }

    /**
     * Register a code generator (old and new Blockly API)
     *
     * @param {string} type - block type
     * @param {(block: object) => string} generator - generator
     */
    function registerGenerator(type, generator) {
        if (Blockly.JavaScript.forBlock) {
            Blockly.JavaScript.forBlock[type] = generator;
        } else {
            Blockly.JavaScript[type] = generator;
        }
    }

    /**
     * Optional value inputs: user ID and group chat ID
     *
     * @param {object} block - block
     */
    function appendTargets(block) {
        for (const [name, word] of [
            ['USERID', 'max_userid'],
            ['CHATID', 'max_chatid'],
        ]) {
            const input = block
                .appendValueInput(name)
                .setCheck(['Number', 'String'])
                .appendField(Blockly.Translate(word));
            if (input.connection) {
                input.connection._optional = true;
            }
        }
    }

    /**
     * Code lines of user ID and group chat ID
     *
     * @param {object} block - block
     * @returns {string[]} code lines
     */
    function targetLines(block) {
        const lines = [];
        const userId = Blockly.JavaScript.valueToCode(block, 'USERID', Blockly.JavaScript.ORDER_ATOMIC);
        const chatId = Blockly.JavaScript.valueToCode(block, 'CHATID', Blockly.JavaScript.ORDER_ATOMIC);
        if (userId) {
            lines.push(`  userId: ${userId},\n`);
        }
        if (chatId) {
            lines.push(`  chatId: ${chatId},\n`);
        }
        return lines;
    }

    // ---- block "max": send a message ---------------------------------------------------------------
    Blockly.Sendto.blocks.max = `<block type="max">
  <field name="INSTANCE"></field>
  <field name="FORMAT">default</field>
  <field name="SILENT">FALSE</field>
  <field name="ATTACHMENT_TYPE">none</field>
  <field name="LOG"></field>
  <value name="MESSAGE">
    <shadow type="text">
      <field name="TEXT">text</field>
    </shadow>
  </value>
</block>`;

    Blockly.Blocks.max = {
        init: function () {
            this.appendDummyInput('INSTANCE')
                .appendField(Blockly.Translate('max'))
                .appendField(new Blockly.FieldDropdown(instanceOptions()), 'INSTANCE');
            this.appendValueInput('MESSAGE').appendField(Blockly.Translate('max_message'));
            appendTargets(this);
            this.appendDummyInput('FORMAT')
                .appendField(Blockly.Translate('max_format'))
                .appendField(new Blockly.FieldDropdown(formatOptions()), 'FORMAT');
            this.appendDummyInput('SILENT')
                .appendField(Blockly.Translate('max_silent'))
                .appendField(new Blockly.FieldCheckbox('FALSE'), 'SILENT');
            this.appendDummyInput('ATTACHMENT_TYPE')
                .appendField(Blockly.Translate('max_attachment'))
                .appendField(new Blockly.FieldDropdown(attachmentOptions()), 'ATTACHMENT_TYPE');
            const source = this.appendValueInput('ATTACHMENT')
                .setCheck('String')
                .appendField(Blockly.Translate('max_attachment_source'));
            if (source.connection) {
                source.connection._optional = true;
            }
            this.appendDummyInput('LOG')
                .appendField(Blockly.Translate('max_log'))
                .appendField(new Blockly.FieldDropdown(logLevelOptions()), 'LOG');
            this.setInputsInline(false);
            this.setPreviousStatement(true, null);
            this.setNextStatement(true, null);
            this.setColour(Blockly.Sendto.HUE);
            this.setTooltip(Blockly.Translate('max_tooltip'));
            this.setHelpUrl(Blockly.Translate('max_help'));
        },
    };

    registerGenerator('max', block => {
        const instance = block.getFieldValue('INSTANCE');
        const format = block.getFieldValue('FORMAT');
        const silent = block.getFieldValue('SILENT');
        const attachmentType = block.getFieldValue('ATTACHMENT_TYPE');
        const logLevel = block.getFieldValue('LOG');
        const text = Blockly.JavaScript.valueToCode(block, 'MESSAGE', Blockly.JavaScript.ORDER_ATOMIC);
        const attachment = Blockly.JavaScript.valueToCode(block, 'ATTACHMENT', Blockly.JavaScript.ORDER_ATOMIC);

        const lines = [`sendTo('max${instance}', 'send', {\n`];
        if (text) {
            lines.push(`  text: ${text},\n`);
        }
        lines.push(...targetLines(block));
        if (format && format !== 'default') {
            lines.push(`  format: '${format}',\n`);
        }
        if (silent === 'TRUE') {
            lines.push('  notify: false,\n');
        }
        if (attachment && attachmentType && attachmentType !== 'none') {
            lines.push(`  ${attachmentType}: ${attachment},\n`);
        }
        lines.push(`});\n${logLine(logLevel, 'max', text)}`);
        return lines.join('');
    });

    // ---- block "max_ask": question with answer buttons ---------------------------------------------
    const ALIGN_RIGHT =
        (Blockly.inputs && Blockly.inputs.Align && Blockly.inputs.Align.RIGHT) || Blockly.ALIGN_RIGHT || 1;

    Blockly.Sendto.blocks.max_ask = `<sep gap="5"></sep>
<block type="max_ask">
  <mutation>
    <answer id="ANSWER_0" name="yes"></answer>
  </mutation>
  <field name="INSTANCE"></field>
  <field name="FORMAT">default</field>
  <field name="LOG"></field>
  <value name="QUESTION">
    <shadow type="text">
      <field name="TEXT">text</field>
    </shadow>
  </value>
  <value name="ANSWER_0">
    <shadow type="text">
      <field name="TEXT">Yes</field>
    </shadow>
  </value>
</block>`;

    Blockly.Blocks.max_ask_container = {
        init: function () {
            this.setColour(Blockly.Object ? Blockly.Object.HUE : Blockly.Sendto.HUE);
            this.appendDummyInput().appendField(Blockly.Translate('max_ask_answers'));
            this.appendStatementInput('STACK');
            this.setTooltip(Blockly.Translate('max_ask_tooltip'));
            this.contextMenu = false;
        },
    };

    Blockly.Blocks.max_ask_mutator = {
        init: function () {
            this.setColour(Blockly.Sendto.HUE);
            this.appendDummyInput('ANSWER')
                .appendField(Blockly.Translate('max_ask_answer'))
                .appendField(new Blockly.FieldTextInput('okay'), 'ANSWER');
            this.setPreviousStatement(true);
            this.setNextStatement(true);
            this.setTooltip(Blockly.Translate('max_ask_tooltip'));
            this.contextMenu = false;
        },
    };

    Blockly.Blocks.max_ask = {
        init: function () {
            this.answers_ = [];
            this.itemCount_ = 0;
            if (Blockly.icons && Blockly.icons.MutatorIcon) {
                this.setMutator(new Blockly.icons.MutatorIcon(['max_ask_mutator'], this));
            } else if (Blockly.Mutator) {
                this.setMutator(new Blockly.Mutator(['max_ask_mutator'], this));
            }
            this.appendDummyInput('INSTANCE')
                .appendField(Blockly.Translate('max_ask'))
                .appendField(new Blockly.FieldDropdown(instanceOptions()), 'INSTANCE');
            this.appendValueInput('QUESTION').appendField(Blockly.Translate('max_ask_question'));
            appendTargets(this);
            this.appendDummyInput('FORMAT')
                .appendField(Blockly.Translate('max_format'))
                .appendField(new Blockly.FieldDropdown(formatOptions()), 'FORMAT');
            this.appendDummyInput('LOG')
                .appendField(Blockly.Translate('max_log'))
                .appendField(new Blockly.FieldDropdown(logLevelOptions()), 'LOG');
            this.setInputsInline(false);
            this.setPreviousStatement(true, null);
            this.setNextStatement(true, null);
            this.setColour(Blockly.Sendto.HUE);
            this.setTooltip(Blockly.Translate('max_ask_tooltip'));
            this.setHelpUrl(Blockly.Translate('max_ask_help'));
        },

        /** @returns {Element} answers for the workspace XML */
        mutationToDom: function () {
            const container = document.createElement('mutation');
            for (let i = 0; i < this.answers_.length; i++) {
                const parameter = document.createElement('answer');
                parameter.setAttribute('id', `ANSWER_${i}`);
                parameter.setAttribute('name', this.answers_[i]);
                container.appendChild(parameter);
            }
            return container;
        },

        /** @param {Element} xmlElement - workspace XML */
        domToMutation: function (xmlElement) {
            this.answers_ = [];
            for (let i = 0; i < xmlElement.childNodes.length; i++) {
                const childNode = xmlElement.childNodes[i];
                if (childNode.nodeName.toLowerCase() === 'answer') {
                    this.answers_.push(childNode.getAttribute('name') || '');
                }
            }
            this.itemCount_ = this.answers_.length;
            this.updateShape_();
        },

        /**
         * @param {object} workspace - mutator workspace
         * @returns {object} container block
         */
        decompose: function (workspace) {
            const containerBlock = workspace.newBlock('max_ask_container');
            containerBlock.initSvg();
            let connection = containerBlock.getInput('STACK').connection;
            for (let i = 0; i < this.itemCount_; i++) {
                const itemBlock = workspace.newBlock('max_ask_mutator');
                itemBlock.setFieldValue(this.answers_[i], 'ANSWER');
                itemBlock.initSvg();
                connection.connect(itemBlock.previousConnection);
                connection = itemBlock.nextConnection;
            }
            return containerBlock;
        },

        /** @param {object} containerBlock - container block of the mutator */
        compose: function (containerBlock) {
            this.answers_ = [];
            let itemBlock = containerBlock.getInputTargetBlock('STACK');
            const connections = [];
            while (itemBlock) {
                this.answers_.push(itemBlock.getFieldValue('ANSWER'));
                connections.push(itemBlock.valueConnection_);
                itemBlock = itemBlock.nextConnection && itemBlock.nextConnection.targetBlock();
            }
            for (let k = 0; k < this.itemCount_; k++) {
                const input = this.getInput(`ANSWER_${k}`);
                const connection = input && input.connection && input.connection.targetConnection;
                if (connection && !connections.includes(connection)) {
                    connection.disconnect();
                }
            }
            this.itemCount_ = connections.length;
            this.updateShape_();
            for (let i = 0; i < this.itemCount_; i++) {
                const child = connections[i];
                const input = this.getInput(`ANSWER_${i}`);
                if (child && child.getSourceBlock().workspace && input && input.connection && !child.isConnected()) {
                    input.connection.connect(child);
                }
            }
        },

        /** @param {object} containerBlock - container block of the mutator */
        saveConnections: function (containerBlock) {
            let itemBlock = containerBlock.getInputTargetBlock('STACK');
            let i = 0;
            while (itemBlock) {
                const input = this.getInput(`ANSWER_${i}`);
                itemBlock.valueConnection_ = input && input.connection && input.connection.targetConnection;
                i++;
                itemBlock = itemBlock.nextConnection && itemBlock.nextConnection.targetBlock();
            }
        },

        /** Adds and removes the answer inputs so the block matches itemCount_ */
        updateShape_: function () {
            const workspace = this.workspace;
            for (let i = 0; i < this.itemCount_; i++) {
                let input = this.getInput(`ANSWER_${i}`);
                if (!input) {
                    input = this.appendValueInput(`ANSWER_${i}`).setAlign(ALIGN_RIGHT);
                    input.appendField(this.answers_[i]);
                } else {
                    input.fieldRow[0].setValue(this.answers_[i]);
                }
                if (!this.getInput(`STATEMENT_${i}`)) {
                    this.appendStatementInput(`STATEMENT_${i}`);
                }
                setTimeout(
                    answerInput => {
                        if (answerInput.connection && !answerInput.connection.isConnected()) {
                            const shadow = workspace.newBlock('text');
                            shadow.setShadow(true);
                            shadow.setFieldValue('text', 'TEXT');
                            shadow.initSvg();
                            shadow.render();
                            shadow.outputConnection.connect(answerInput.connection);
                        }
                    },
                    100,
                    input,
                );
            }
            for (let i = this.itemCount_; this.getInput(`ANSWER_${i}`); i++) {
                this.removeInput(`ANSWER_${i}`);
                this.removeInput(`STATEMENT_${i}`);
            }
        },
    };

    registerGenerator('max_ask', block => {
        const answers = [];
        for (let id = 0; id < block.itemCount_; id++) {
            const answer = Blockly.JavaScript.valueToCode(block, `ANSWER_${id}`, Blockly.JavaScript.ORDER_ATOMIC);
            const statement = Blockly.JavaScript.statementToCode(block, `STATEMENT_${id}`);
            if (answer) {
                answers.push({ id: answers.length, answer, statement });
            }
        }
        const instance = block.getFieldValue('INSTANCE');
        const format = block.getFieldValue('FORMAT');
        const logLevel = block.getFieldValue('LOG');
        const question = Blockly.JavaScript.valueToCode(block, 'QUESTION', Blockly.JavaScript.ORDER_ATOMIC);

        const lines = [`sendTo('max${instance}', 'ask', {\n`];
        if (question) {
            lines.push(`  text: ${question},\n`);
        }
        lines.push(...targetLines(block));
        if (format && format !== 'default') {
            lines.push(`  format: '${format}',\n`);
        }
        lines.push(`  answers: [${answers.map(a => a.answer).join(', ')}],\n`);
        lines.push('}, async (msg) => {\n');
        if (logLevel) {
            lines.push(
                `  console.${logLevel}('max ask answer: ' + (msg && msg.text !== undefined ? msg.text : '[no answer]'));\n`,
            );
        }
        for (const a of answers) {
            if (a.statement) {
                lines.push(
                    `  if (msg && msg.data == '${a.id}') {\n${Blockly.JavaScript.prefixLines(a.statement, Blockly.JavaScript.INDENT)}  }\n`,
                );
            }
        }
        lines.push(`});\n${logLine(logLevel, 'max ask', question)}`);
        return lines.join('');
    });
})();
