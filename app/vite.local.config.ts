import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const app = fileURLToPath(new URL("./", import.meta.url));
const devPort = 3010;
const backendOrigin = `http://127.0.0.1:${process.env.OPENBOT_LOCAL_PORT ?? "3011"}`;

function localEntry(): Plugin {
  return {
    name: "openbot-local-entry",
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        if (request.url === "/") request.url = "/local.html";
        next();
      });
    },
    generateBundle(_options, bundle) {
      for (const artifact of Object.values(bundle)) {
        if (
          artifact.type === "chunk" &&
          artifact.moduleIds.some((id) =>
            /[/\\]@copilotkit[/\\]|@copilotkit\+/.test(id),
          )
        ) {
          this.error("The local entry cannot bundle CopilotKit packages.");
        }
      }
    },
  };
}

export default defineConfig({
  root: app,
  plugins: [localEntry(), react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  publicDir: false,
  server: {
    host: "127.0.0.1",
    port: devPort,
    strictPort: true,
    proxy: {
      "/api/local": {
        target: backendOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (forwarded, request) => {
            if (request.headers.origin === `http://127.0.0.1:${devPort}`) {
              forwarded.setHeader("Origin", backendOrigin);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: "dist-local",
    rollupOptions: {
      input: fileURLToPath(new URL("./local.html", import.meta.url)),
    },
  },
});
