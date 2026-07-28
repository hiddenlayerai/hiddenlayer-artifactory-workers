import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Promise: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { vars: "all", argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "no-unused-vars": "off",
      "import/order": "off",
      "no-console": "off",
    },
  },
  {
    ignores: ["**/node_modules/**", "**/coverage/**"],
  },
];
