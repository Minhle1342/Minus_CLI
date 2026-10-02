import fs from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";
import { Type } from "@google/genai";
import { ToolDefinition } from "./types.js";
import { Workspace } from "../workspace/workspace.js";

/**
 * Tool 2: list_files
 * Liệt kê danh sách các file và thư mục bên trong một đường dẫn, tự động lọc các thư mục nội bộ.
 * Hỗ trợ pattern (glob), pagination để bảo vệ context window trên workspace lớn.
 */
export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description:
    "List files and subdirectories in a workspace directory. Supports glob patterns (e.g. '**/*.ts'), pagination (limit/offset) and continuation tokens for safe browsing on large workspaces.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description:
          'Relative path to the directory to view (e.g. "." or "src"). Default is ".". Accepts the dirPath alias.',
      },
      dirPath: {
        type: Type.STRING,
        description: "Alias for path: the directory to list.",
      },
      pattern: {
        type: Type.STRING,
        description:
          'Optional glob to filter or recursively search files (e.g. "**/*.ts", "*.json", "src/**/*.js"). If provided, fast-glob scans from path.',
      },
      limit: {
        type: Type.INTEGER,
        description:
          "Maximum number of entries returned (default: 100, max: 500).",
      },
      offset: {
        type: Type.INTEGER,
        description: "Number of entries to skip (for pagination, default: 0).",
      },
      continuationToken: {
        type: Type.STRING,
        description:
          "Continuation token from the previous call (base64 encoded offset). Takes precedence over offset if both are provided.",
      },
    },
    required: [],
  },
  async execute(
    args: Record<string, any>,
    workspace: Workspace,
  ): Promise<Record<string, any>> {
    const rawPath = String(args.path || args.dirPath || ".").trim() || ".";
    const MAX_LIMIT = 500;
    const DEFAULT_LIMIT = 100;
    let limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(args.limit) || DEFAULT_LIMIT),
    );
    let offset = Math.max(0, Number(args.offset) || 0);

    // Parse continuationToken if provided (base64 encoded offset)
    if (args.continuationToken && typeof args.continuationToken === "string") {
      try {
        const decoded = Buffer.from(args.continuationToken, "base64").toString(
          "utf-8",
        );
        const tokenOffset = parseInt(decoded, 10);
        if (!isNaN(tokenOffset) && tokenOffset >= 0) {
          offset = tokenOffset;
        }
      } catch {
        // Invalid token, ignore and use offset
      }
    }

    try {
      const safePath = workspace.resolveSafePath(rawPath);
      const stat = await fs.stat(safePath);

      if (!stat.isDirectory()) {
        return {
          path: rawPath,
          error: `Path "${rawPath}" is not a directory.`,
        };
      }

      const rawPattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
      let filteredEntries: Array<{
        name: string;
        type: "file" | "directory";
      }> = [];

      if (rawPattern) {
        const globEntries = await fg(rawPattern, {
          cwd: safePath,
          dot: false,
          onlyFiles: false,
          ignore: [
            "**/node_modules/**",
            "**/.git/**",
            "**/dist/**",
            "**/.codingagent/**",
            "**/.gemini/**",
            "**/build/**",
            "**/coverage/**",
          ],
          stats: true,
        });

        filteredEntries = globEntries.map((e) => ({
          name: e.path.replace(/\\/g, "/"),
          type: e.stats?.isDirectory() ? "directory" : "file",
        }));
      } else {
        const entries = await fs.readdir(safePath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            if (!workspace.isIgnoredDirectory(entry.name)) {
              filteredEntries.push({ name: entry.name, type: "directory" });
            }
          } else if (entry.isFile()) {
            filteredEntries.push({ name: entry.name, type: "file" });
          }
        }
      }

      const total = filteredEntries.length;
      const paginatedEntries = filteredEntries.slice(offset, offset + limit);
      const returned = paginatedEntries.length;
      const hasMore = offset + returned < total;
      const nextOffset = offset + returned;
      const continuationToken = hasMore
        ? Buffer.from(String(nextOffset)).toString("base64")
        : undefined;

      return {
        path: rawPath,
        ...(rawPattern ? { pattern: rawPattern } : {}),
        entries: paginatedEntries,
        total,
        returned,
        truncated: hasMore,
        continuationToken,
      };
    } catch (err: any) {
      return {
        path: rawPath,
        error: `Failed to list directory: ${err.message}`,
      };
    }
  },
};
