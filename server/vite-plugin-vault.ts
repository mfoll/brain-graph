import type { Plugin, ViteDevServer } from "vite";
import { createVaultApi, type VaultApiOptions } from "./api.ts";

export type VaultPluginOptions = VaultApiOptions;
export type { SavedLayout } from "./api.ts";

/** Mounts Brain Graph's local API on the Vite dev server; see server/api.ts. */
export function vaultPlugin(opts: VaultPluginOptions = {}): Plugin {
  const api = createVaultApi(opts);
  return {
    name: "brain-graph-vault",
    configureServer(server: ViteDevServer) {
      server.httpServer?.on("close", () => void api.close());
      server.middlewares.use((req, res, next) => {
        api
          .handle(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch(next);
      });
    },
  };
}
