import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "coverage/**",
      "out/**",
      "next-env.d.ts",
      "eslint.config.mjs",
    ],
  },
  ...nextVitals,
  ...nextTs,
];
