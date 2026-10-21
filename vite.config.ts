import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { vaultPlugin } from "./server/vite-plugin-vault.ts";

// Point the viewer at a vault with `VAULT=~/Second-Brain pnpm dev` (defaults to ~/Second-Brain).
const vaultPath = process.env.VAULT ?? "~/Second-Brain";

export default defineConfig({
  plugins: [react(), vaultPlugin({ vaultPath, label: process.env.VAULT_LABEL, slug: process.env.VAULT_SLUG })],
  server: { port: 5178, strictPort: true, open: false },
});
