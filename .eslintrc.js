"use strict";

module.exports = {
  root: true,
  extends: ["eslint:recommended"],
  plugins: ["@typescript-eslint"],
  env: {
    es2020: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  rules: {
    ...require("@typescript-eslint/eslint-plugin").configs["eslint-recommended"]
      .overrides[0].rules,
    ...require("@typescript-eslint/eslint-plugin").configs.recommended.rules,
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/no-var-requires": "off",
    "@typescript-eslint/switch-exhaustiveness-check": "error",
    "arrow-body-style": "error",
    curly: "error",
    "dot-notation": "error",
    "no-fallthrough": "off",
    "no-shadow": "error",
    "object-shorthand": "error",
    "one-var": ["error", "never"],
    "prefer-arrow-callback": "error",
    "prefer-destructuring": ["error", { array: false, object: true }],
    "prefer-template": "error",
    eqeqeq: "error",
  },
  overrides: [
    {
      files: "run-pty.js",
      parserOptions: {
        project: "./tsconfig.json",
      },
      rules: {
        ...require("@typescript-eslint/eslint-plugin").configs[
          "recommended-requiring-type-checking"
        ].rules,
      },
    },
    {
      files: "*.js",
      rules: {
        strict: "error",
      },
    },
    {
      files: "*.test.js",
      extends: ["plugin:jest/recommended"],
      env: {
        "jest/globals": true,
      },
    },
  ],
};
