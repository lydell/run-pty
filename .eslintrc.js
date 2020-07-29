"use strict";

module.exports = {
  root: true,
  extends: ["eslint:recommended"],
  env: {
    es6: true,
    node: true,
  },
  rules: {
    "arrow-body-style": "error",
    curly: "error",
    "dot-notation": "error",
    "no-fallthrough": "off",
    "no-shadow": "error",
    "no-var": "error",
    "prefer-const": "error",
    "object-shorthand": "error",
    "one-var": ["error", "never"],
    "prefer-arrow-callback": "error",
    "prefer-destructuring": ["error", { array: false, object: true }],
    "prefer-rest-params": "error",
    "prefer-spread": "error",
    "prefer-template": "error",
    eqeqeq: "error",
    strict: "error",
  },
  overrides: [
    {
      files: "*.test.js",
      extends: ["plugin:jest/recommended"],
      env: {
        "jest/globals": true,
      },
    },
  ],
};
