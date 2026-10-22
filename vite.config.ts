import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { vaultPlugin } from "./server/vite-plugin-vault.ts";

// Vaults come from Brain Graph's own registry (~/.config/brain-graph/vaults.json, edited in the app),
// from Tolaria's registry when present, and from `VAULT=~/some/vault pnpm dev` (which also makes it the
// default). With none of these, the app opens on the vault manager.
const vaultPath = process.env.VAULT;

export default defineConfig({
  plugins: [react(), vaultPlugin({ vaultPath, label: process.env.VAULT_LABEL, slug: process.env.VAULT_SLUG })],
  server: { port: 5178, strictPort: true, open: false },
});
