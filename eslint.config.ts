import css from "@eslint/css";
import oxlint from 'eslint-plugin-oxlint';
import tseslint from "typescript-eslint";

export default tseslint.config(
  //Oxlint for TypeScript and all that it supports.
  ...oxlint.buildFromOxlintConfigFile('./.oxlintrc.json'),

  //ESLint for CSS files.
  {
    files: ["**/*.css"],
    plugins: {
      css,
    },
    language: "css/css",
    rules: {
      "css/require-baseline": ["warn", { available: "widely" }],
    },
  }
);
