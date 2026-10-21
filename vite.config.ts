import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { vaultPlugin } from "./server/vite-plugin-vault.ts";

// Vaults registered in Tolaria are served automatically; `VAULT=~/some/vault pnpm dev` adds one more
// (and makes it the default). Without Tolaria and without VAULT, ~/Second-Brain is served.
const vaultPath = process.env.VAULT;

export default defineConfig({
  plugins: [react(), vaultPlugin({ vaultPath, label: process.env.VAULT_LABEL, slug: process.env.VAULT_SLUG })],
  server: { port: 5178, strictPort: true, open: false },
});
