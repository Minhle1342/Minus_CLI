import fs from "node:fs/promises";
import path from "node:path";
import { Type } from "@google/genai";
import { ToolDefinition } from "./types.js";
import { Workspace } from "../workspace/workspace.js";

/**
 * Tool 2: list_files
 * Liệt kê danh sách các file và thư mục bên trong một đường dẫn, tự động lọc các thư mục nội bộ.
 * Hỗ trợ pagination để bảo vệ context window trên workspace lớn.
 */
export const listFilesTool: ToolDefinition = {
  name: "list_files",
  description:
    "Liệt kê danh sách các tệp tin và thư mục con trong một thư mục thuộc workspace. Hỗ trợ pagination (limit/offset) và continuation token để duyệt an toàn trên workspace lớn.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      path: {
        type: Type.STRING,
        description:
          'Đường dẫn tương đối tới thư mục cần xem (ví dụ: "." hoặc "src"). Mặc định là ".". Chấp nhận alias dirPath.',
      },
      dirPath: {
        type: Type.STRING,
        description: "Alias cho path: thư mục cần liệt kê.",
      },
      limit: {
        type: Type.INTEGER,
        description:
          "Số lượng entry tối đa trả về (mặc định: 100, tối đa: 500).",
      },
      offset: {
        type: Type.INTEGER,
        description: "Số entry bỏ qua (để phân trang, mặc định: 0).",
      },
      continuationToken: {
        type: Type.STRING,
        description:
          "Token tiếp tục từ lần gọi trước (base64 encoded offset). Ưu tiên hơn offset nếu cả hai đều cung cấp.",
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
          error: `Đường dẫn "${rawPath}" không phải là thư mục.`,
        };
      }

      const entries = await fs.readdir(safePath, { withFileTypes: true });

      const filteredEntries: Array<{
        name: string;
        type: "file" | "directory";
      }> = [];

      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!workspace.isIgnoredDirectory(entry.name)) {
            filteredEntries.push({ name: entry.name, type: "directory" });
          }
        } else if (entry.isFile()) {
          filteredEntries.push({ name: entry.name, type: "file" });
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
        entries: paginatedEntries,
        total,
        returned,
        truncated: hasMore,
        continuationToken,
      };
    } catch (err: any) {
      return {
        path: rawPath,
        error: `Không thể liệt kê thư mục: ${err.message}`,
      };
    }
  },
};
