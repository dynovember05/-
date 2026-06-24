import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { gradeWithOpenAI } from "./lib/grader.mjs";

const root = process.cwd();
const publicRoot = resolve(root, "public");
const startPort = Number(process.env.PORT || 5173);

function loadDotEnv() {
  try {
    const envText = readFileSync(resolve(root, ".env"), "utf8");
    for (const line of envText.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
        continue;
      }
      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional. PowerShell environment variables still work.
  }
}

loadDotEnv();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function safePath(urlPath) {
  const cleanPath = decodeURIComponent(urlPath.split("?")[0]);
  const candidate = normalize(join(publicRoot, cleanPath === "/" ? "index.html" : cleanPath));
  if (!candidate.startsWith(publicRoot)) {
    return null;
  }
  return candidate;
}

function collectRequestBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        request.destroy();
        rejectBody(new Error("Request body too large"));
      }
    });
    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/api/grade") {
      const body = await collectRequestBody(request);
      const payload = JSON.parse(body || "{}");
      const result = await gradeWithOpenAI(payload);

      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(result ?? { items: null, summary: "OPENAI_API_KEY 또는 OPENAI_MODEL이 없어 브라우저 채점으로 전환합니다." }));
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405);
      response.end("Method Not Allowed");
      return;
    }

    const filePath = safePath(request.url || "/");
    if (!filePath) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const fileStat = await stat(filePath);
    const finalPath = fileStat.isDirectory() ? resolve(filePath, "index.html") : filePath;
    const content = await readFile(finalPath);
    response.writeHead(200, {
      "Content-Type": contentTypes[extname(finalPath)] || "application/octet-stream"
    });
    if (request.method !== "HEAD") {
      response.end(content);
    } else {
      response.end();
    }
  } catch (error) {
    response.writeHead(error?.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error?.code === "ENOENT" ? "Not Found" : String(error.message || error));
  }
});

function listen(port) {
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      listen(port + 1);
      return;
    }
    throw error;
  });

  server.listen(port, () => {
    console.log(`Study app running at http://localhost:${port}`);
    if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL) {
      console.log("OpenAI grading is optional. Set OPENAI_API_KEY and OPENAI_MODEL to enable server-side AI grading.");
    }
  });
}

listen(startPort);
