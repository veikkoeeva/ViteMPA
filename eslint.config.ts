import compat from "eslint-plugin-compat";
import css from "@eslint/css";
import { defineConfig } from "eslint/config";
import oxlint from 'eslint-plugin-oxlint';

export default defineConfig([
	 {
    files: ["src/**/*.js"],
    plugins: { compat },
		settings: {
      browserslistOpts: {
        env: "modern"
      }
    },
    rules: {
      semi: "error",
      "compat/compat": "warn",
    },
  },
	//ESLint for CSS files.
	{
		files: ["src/**/*.css"],
		plugins: { css },
		language: "css/css",
		rules: {
			"css/use-baseline": ["warn", { available: "widely" }],
		}
	},
	//Oxlint for TypeScript and all that it supports.
  ...oxlint.buildFromOxlintConfigFile('./.oxlintrc.json')
]);
