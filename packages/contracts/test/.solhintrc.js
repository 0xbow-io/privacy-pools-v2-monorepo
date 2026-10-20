const wonderland = require('solhint-config-wonderland');
const tests = require('solhint-config-wonderland/tests');

module.exports = {
  ...wonderland,
  rules: {
    ...wonderland.rules,
    ...tests.rules,
    'private-vars-leading-underscore': 'off',
    'custom-errors': 'off',
    'named-return-values': 'off',
    'reason-string': 'off',
    'named-parameters-function': 'off',
  },
};
