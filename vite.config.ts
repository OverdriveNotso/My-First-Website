import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

// Tags that never render page content, so they get no data-source attribute.
const SKIP = new Set(["html", "head", "meta", "link", "title", "base", "script", "style", "noscript", "template"]);
const MAX_PROMPT_BYTES = 256 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_PROMPT_BYTES) {
        reject(new Error("Prompt too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

/**
 * Dev-only (`vite` / `npm run dev`):
 *  - adds data-source="file:line" to every element in the HTML so Pickr can name source lines,
 *  - injects the Pickr mount script,
 *  - serves POST /__pickr/send, which opens a new Claude Code conversation in VS Code with the prompt.
 * `vite build` and the published static files are untouched.
 */
function pickrDev(): Plugin {
  let root = process.cwd();
  return {
    name: "pickr-dev",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use("/__pickr/send", async (req, res) => {
        if (req.method !== "POST") return reply(res, 405, { error: "POST only" });
        // Only this page may trigger it: same-origin, custom header, loopback client.
        const origin = req.headers.origin;
        const host = req.headers.host;
        const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
        if (!loopback || !host || origin !== `http://${host}` || req.headers["x-pickr"] !== "1") {
          return reply(res, 403, { error: "Forbidden" });
        }
        try {
          const { prompt } = JSON.parse(await readBody(req)) as { prompt?: unknown };
          if (typeof prompt !== "string" || !prompt.trim()) return reply(res, 400, { error: "Empty prompt" });

          // Save the full prompt in the project, then hand Claude Code a short instruction that
          // @-mentions it (keeps the URI short; long prompts would exceed URL limits).
          const dir = join(root, ".pickr");
          mkdirSync(dir, { recursive: true });
          const name = `prompt-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
          writeFileSync(join(dir, name), prompt, "utf8");

          const instruction = `Carry out the change requests in @.pickr/${name} — it lists each element with its source file:line, CSS selector and what should change.`;
          // Claude Code VS Code extension URI handler: opens a new conversation with this prompt.
          const uri = `vscode://anthropic.claude-code/open?prompt=${encodeURIComponent(instruction)}`;
          // rundll32 hands the URI to Windows' protocol handler without any shell parsing.
          const child = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", uri], { detached: true, stdio: "ignore" });
          child.on("error", (err) => server.config.logger.error(`[pickr] ${err.message}`));
          child.unref();
          return reply(res, 200, { ok: true, file: `.pickr/${name}` });
        } catch (err) {
          return reply(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
      });
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const file = ctx.path.replace(/^\//, "") || "index.html";
        const newlines: number[] = [];
        for (let i = html.indexOf("\n"); i !== -1; i = html.indexOf("\n", i + 1)) newlines.push(i);
        let line = 0; // index into newlines; offsets arrive in increasing order
        const lineAt = (offset: number) => {
          while (line < newlines.length && newlines[line] < offset) line++;
          return line + 1;
        };
        // Comments, <script> and <style> bodies are matched first and left alone.
        const tagged = html.replace(
          /<!--[\s\S]*?-->|<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>|<([a-zA-Z][\w-]*)(?=[\s>/])/g,
          (match, tag: string | undefined, offset: number) => {
            if (!tag || SKIP.has(tag.toLowerCase())) return match;
            return `${match} data-source="${file}:${lineAt(offset)}"`;
          },
        );
        return {
          html: tagged,
          tags: [{ tag: "script", attrs: { type: "module", src: "/pickr/mount.tsx" }, injectTo: "body" }],
        };
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), pickrDev()],
  define: { "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development") },
}));
