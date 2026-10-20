const wonderland = require('solhint-config-wonderland');
const scripts = require('solhint-config-wonderland/scripts');

module.exports = {
  ...wonderland,
  rules: {
    ...wonderland.rules,
    ...scripts.rules,
    'custom-errors': 'off',
    'reason-string': 'off',
  },
};
