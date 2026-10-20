const wonderland = require('solhint-config-wonderland');

module.exports = {
  ...wonderland,
  rules: {
    ...wonderland.rules,
    'named-parameters-function': ['warn', 3],
  },
};
