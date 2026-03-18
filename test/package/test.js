'use strict';

const path = require('path');
const { tests } = require('@iobroker/testing');

// Run package tests (validates io-package.json, package.json, admin files)
tests.packageFiles(path.join(__dirname, '../..'));
