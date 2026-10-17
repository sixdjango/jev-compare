import { copyFile, readFile } from "node:fs/promises";
import { defineConfig } from "rolldown";
import type { Plugin } from "rolldown";
import { dts } from "rolldown-plugin-dts";

const external = [/^node:/, "@typesafe-ai/sdk", "undici"];
const { version } = JSON.parse(await readFile("package.json", "utf8"));
const define = { __VERSION__: JSON.stringify(version) };

/** The declarations are identical for both formats; publish them as `.d.cts` for `require` too. */
const ctsDeclarations: Plugin = {
  name: "cts-declarations",
  async writeBundle() {
    await copyFile("dist/index.d.mts", "dist/index.d.cts");
  },
};

export default defineConfig([
  {
    input: "src/index.ts",
    external,
    platform: "node",
    transform: { define },
    plugins: [dts(), ctsDeclarations],
    output: { dir: "dist", format: "esm", entryFileNames: "[name].mjs", chunkFileNames: "[name]-[hash].mjs" },
  },
  {
    input: "src/index.ts",
    external,
    platform: "node",
    transform: { define },
    output: { dir: "dist", format: "cjs", entryFileNames: "[name].cjs", chunkFileNames: "[name]-[hash].cjs" },
  },
  {
    input: "src/cli.ts",
    // Load the library from the ESM build instead of bundling a second copy.
    external: [...external, "./index.ts"],
    platform: "node",
    output: {
      dir: "dist",
      format: "esm",
      entryFileNames: "[name].mjs",
      banner: "#!/usr/bin/env node",
    },
    plugins: [
      {
        name: "cli-library-import",
        renderChunk: (code) => code.replace(/from "\.\/index\.ts"/g, 'from "./index.mjs"'),
      },
    ],
  },
]);
