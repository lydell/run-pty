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
    ...require("@typescript-eslint/eslint-plugin").configs.strict.rules,
    "@typescript-eslint/no-var-requires": "off",
    "arrow-body-style": "error",
    curly: "error",
    "dot-notation": "error",
    "no-control-regex": "off",
    "no-fallthrough": "off",
    "no-shadow": "error",
    "no-unused-expressions": "error",
    "object-shorthand": "error",
    "one-var": ["error", "never"],
    "prefer-arrow-callback": "error",
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
          "strict-type-checked"
        ].rules,
        "@typescript-eslint/no-unnecessary-condition": "off",
        "@typescript-eslint/no-var-requires": "off",
        "@typescript-eslint/prefer-destructuring": [
          "error",
          { array: false, object: true },
        ],
        "@typescript-eslint/strict-boolean-expressions": [
          "error",
          {
            allowString: false,
            allowNumber: false,
            allowNullableObject: false,
          },
        ],
        "@typescript-eslint/switch-exhaustiveness-check": "error",
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
      extends: ["plugin:vitest/recommended"],
    },
  ],
};
