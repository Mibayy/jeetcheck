import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

// Le build sort dans ../public, servi tel quel par express. Il est COMMITE :
// le deploiement reste `git pull && restart`, et une machine sans toolchain
// front sert quand meme la bonne page.
export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    outDir: "../public",
    emptyOutDir: true,
    // Pas de hash de contenu inutile a lire : un nom stable par entree rend le
    // diff d'un build lisible dans git, ce qui est le point d'un dist commite.
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
