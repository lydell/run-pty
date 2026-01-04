// @ts-check

import eslint from "@eslint/js";
import vitest from "@vitest/eslint-plugin";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// console.log(tseslint.configs.strictTypeChecked);
// process.exit(1);

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    plugins: {
      vitest,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...vitest.configs.recommended.rules,
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
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-var-requires": "off",
      "@typescript-eslint/prefer-destructuring": [
        "error",
        { array: false, object: true },
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowAny: false,
          allowBoolean: false,
          allowNullish: false,
          allowNumber: true,
          allowRegExp: false,
        },
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
);
