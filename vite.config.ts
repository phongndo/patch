import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { reviewApi } from "./server/api.ts";

export default defineConfig({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    {
      name: "patch-local-git",
      configureServer(server) {
        const api = reviewApi(
          process.env.PATCH_REPO ?? process.cwd(),
          process.env.PATCH_BASE ?? "main",
        );
        server.middlewares.use((request, response, next) => {
          void api(request, response)
            .then((handled) => {
              if (!handled) next();
            })
            .catch(next);
        });
      },
    },
  ],
});
