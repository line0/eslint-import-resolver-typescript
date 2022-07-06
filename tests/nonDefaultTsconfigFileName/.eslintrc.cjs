const path = require('path')

module.exports = require('../baseEslintConfig.cjs')(
  path.join(__dirname, 'tsconfig.custom.json'),
)
