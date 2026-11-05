import test from 'node:test';

/** Avoid duplicate suite execution when `node --test tests` discovers multiple entry files. */
test.skip('Suites run from tests/model.test.mjs (see tests/index.js for npm test).');
