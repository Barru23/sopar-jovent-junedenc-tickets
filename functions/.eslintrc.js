module.exports = {
  root: true,
  env: {
    es2022: true,
    node: true,
  },
  extends: ["eslint:recommended", "google"],
  rules: {
    "quotes": ["error", "double"],
    "indent": ["error", 2],
    "object-curly-spacing": ["error", "always"],
    "max-len": ["warn", { code: 120 }],
    "require-jsdoc": "off",
  },
  parserOptions: {
    ecmaVersion: 2022,
  },
};
