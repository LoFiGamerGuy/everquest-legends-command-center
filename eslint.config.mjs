// ESLint 9 flat config (M0-2 toolchain). Kept minimal: eslint + typescript-eslint
// recommended sets, no stylistic rules (formatting is .editorconfig's job).
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/", "**/dist/", "**/target/", "coverage/", "data/"],
  },
  eslint.configs.recommended,
  tseslint.configs.recommended,
);
