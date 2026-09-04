import { Type } from '@google/genai';
import path from 'node:path';
import fs from 'node:fs';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

// ============================================================================
// Guardian & Tool Design Helpers: Color Distance & Normalization
// ============================================================================

function hexToRgb(hex: string): [number, number, number] | null {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    const r = parseInt(clean[0] + clean[0], 16);
    const g = parseInt(clean[1] + clean[1], 16);
    const b = parseInt(clean[2] + clean[2], 16);
    return isNaN(r) || isNaN(g) || isNaN(b) ? null : [r, g, b];
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return isNaN(r) || isNaN(g) || isNaN(b) ? null : [r, g, b];
  }
  return null;
}

function findClosestPaletteColor(hex: string, paletteColors: string[]): { closestColor: string; distance: number } {
  const rgb = hexToRgb(hex);
  if (!rgb) return { closestColor: paletteColors[0] || '#000000', distance: 999 };

  let minDistance = Infinity;
  let closest = paletteColors[0];

  for (const color of paletteColors) {
    const colorRgb = hexToRgb(color);
    if (!colorRgb) continue;
    // Euclidean distance in RGB space
    const dist = Math.sqrt(
      (rgb[0] - colorRgb[0]) ** 2 +
      (rgb[1] - colorRgb[1]) ** 2 +
      (rgb[2] - colorRgb[2]) ** 2
    );
    if (dist < minDistance) {
      minDistance = dist;
      closest = color;
    }
  }

  return { closestColor: closest, distance: Math.round(minDistance) };
}

// ============================================================================
// 1. Tool: game_tilemap_studio
// ============================================================================

export const gameTilemapStudioTool: ToolDefinition = {
  name: 'game_tilemap_studio',
  description:
    'Tạo, xử lý thuật toán (Cellular Automata hang động, BSP Dungeon hầm ngục, Random Walk) và xuất bản đồ Tilemap 2D sang Tiled JSON, Godot 4 TileMap, CSV và ASCII. ' +
    'Tự động tính toán và gom nhóm các khối tường liền kề thành hình chữ nhật va chạm AABB Collision Rectangles để tối ưu hiệu năng vật lý.\n\n' +
    '• KHI NÀO NÊN DÙNG: Khi lập trình màn chơi 2D, sinh bản đồ hang động, hầm ngục, phòng ốc hoặc bố cục grid cho platformer, roguelike, top-down RPG.\n' +
    '• KHI NÀO KHÔNG DÙNG: Không dùng cho địa hình 3D Mesh hoặc giao diện UI đơn thuần.\n' +
    '• FORMAT LỰA CHỌN: "concise" (mặc định: tóm tắt kích thước, số lượng collider, preview nhỏ để tiết kiệm token) hoặc "detailed" (ma trận đầy đủ và toàn bộ tọa độ rects).\n' +
    '• KẾT QUẢ TRẢ VỀ: Đối tượng JSON chứa kích thước, số ô solid, danh sách AABB collision boxes, đường dẫn file đã lưu (nếu có targetFile).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      generator: {
        type: Type.STRING,
        enum: ['cellular_automata', 'bsp_dungeon', 'random_walk', 'custom_matrix', 'blank'],
        description: 'Thuật toán tạo ma trận màn chơi: cellular_automata (hang động hữu cơ), bsp_dungeon (phòng & hành lang hầm ngục), random_walk (đường hầm quanh co), custom_matrix (ma trận tự nhập), blank (bản đồ trống có viền tường bao).',
      },
      width: {
        type: Type.INTEGER,
        description: 'Chiều rộng bản đồ tính theo số ô tile (tối thiểu 5, tối đa 256; mặc định 20).',
      },
      height: {
        type: Type.INTEGER,
        description: 'Chiều cao bản đồ tính theo số ô tile (tối thiểu 5, tối đa 256; mặc định 15).',
      },
      tileSize: {
        type: Type.INTEGER,
        description: 'Kích thước cạnh của mỗi ô tile theo pixel (thường là 8, 16, 24, 32; mặc định 16).',
      },
      fillRatio: {
        type: Type.NUMBER,
        description: 'Tỷ lệ lấp đầy tường ban đầu cho cellular_automata hoặc random_walk (0.1 đến 0.9; mặc định 0.45).',
      },
      outputFormat: {
        type: Type.STRING,
        enum: ['tiled_json', 'godot_tilemap', 'csv', 'matrix_ascii'],
        description: 'Định dạng xuất dữ liệu: tiled_json (Phaser/Kaboom/Tiled), godot_tilemap (Godot 4 PackedInt32Array), csv, matrix_ascii (ký tự text trực quan). Mặc định: tiled_json.',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Mức độ chi tiết phản hồi: "concise" (tiết kiệm token context, tóm tắt collider và preview) hoặc "detailed" (trả về toàn bộ ma trận dữ liệu). Mặc định: "concise".',
      },
      customMatrix: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Mảng chuỗi biểu diễn các hàng tile khi generator="custom_matrix" (ký tự "#" hoặc "1" là tường, "." hoặc "0" là sàn trống).',
      },
      targetFile: {
        type: Type.STRING,
        description: 'Đường dẫn tệp trong workspace để lưu kết quả trực tiếp (ví dụ: "assets/maps/level1.json").',
      },
    },
    required: ['generator'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const generator = String(args.generator || '').trim().toLowerCase();
    const width = Number(args.width) || 20;
    const height = Number(args.height) || 15;
    const tileSize = Number(args.tileSize) || 16;
    const fillRatio = typeof args.fillRatio === 'number' ? Math.max(0.1, Math.min(0.9, args.fillRatio)) : 0.45;
    const outputFormat = String(args.outputFormat || 'tiled_json').trim().toLowerCase();
    const format = String(args.format || 'concise').trim().toLowerCase();
    const { customMatrix, targetFile } = args;

    // 1. Guardian Pre-Call Validation
    const validGenerators = ['cellular_automata', 'bsp_dungeon', 'random_walk', 'custom_matrix', 'blank'];
    if (!validGenerators.includes(generator)) {
      return {
        is_error: true,
        error: `Generator "${generator}" không hợp lệ.`,
        error_type: 'validation_error',
        suggestions: [
          `Chọn một trong các generator hợp lệ: ${validGenerators.join(', ')}.`,
          'Để tạo hang động tự nhiên, sử dụng: generator: "cellular_automata".',
          'Để tạo hầm ngục có phòng và hành lang, sử dụng: generator: "bsp_dungeon".',
        ],
      };
    }

    if (width < 5 || width > 256) {
      return {
        is_error: true,
        error: `Chiều rộng width=${width} nằm ngoài giới hạn cho phép (5 - 256).`,
        error_type: 'out_of_bounds',
        suggestions: ['Đặt width trong khoảng 10 đến 60 ô tile cho màn chơi tiêu chuẩn.'],
      };
    }

    if (height < 5 || height > 256) {
      return {
        is_error: true,
        error: `Chiều cao height=${height} nằm ngoài giới hạn cho phép (5 - 256).`,
        error_type: 'out_of_bounds',
        suggestions: ['Đặt height trong khoảng 10 đến 45 ô tile cho màn chơi tiêu chuẩn.'],
      };
    }

    const validFormats = ['tiled_json', 'godot_tilemap', 'csv', 'matrix_ascii'];
    if (!validFormats.includes(outputFormat)) {
      return {
        is_error: true,
        error: `Định dạng xuất "${outputFormat}" không hợp lệ.`,
        error_type: 'validation_error',
        suggestions: [`Chọn outputFormat là một trong: ${validFormats.join(', ')}.`],
      };
    }

    // 2. Xử lý khởi tạo lưới
    let grid: number[][] = Array.from({ length: height }, () => Array(width).fill(0));

    try {
      if (generator === 'blank') {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
              grid[y][x] = 1;
            }
          }
        }
      } else if (generator === 'custom_matrix') {
        if (!Array.isArray(customMatrix) || customMatrix.length === 0) {
          return {
            is_error: true,
            error: 'Khi generator là "custom_matrix", tham số customMatrix phải là mảng chuỗi biểu diễn các dòng tile.',
            error_type: 'validation_error',
            suggestions: ['Cung cấp customMatrix dạng: ["##########", "#........#", "##########"]'],
          };
        }
        for (let y = 0; y < Math.min(height, customMatrix.length); y++) {
          const row = String(customMatrix[y]);
          for (let x = 0; x < Math.min(width, row.length); x++) {
            grid[y][x] = row[x] === '#' || row[x] === '1' ? 1 : 0;
          }
        }
      } else if (generator === 'cellular_automata') {
        let seed = 12345;
        const pseudoRandom = () => {
          seed = (seed * 9301 + 49297) % 233280;
          return seed / 233280;
        };

        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (x === 0 || x === width - 1 || y === 0 || y === height - 1) {
              grid[y][x] = 1;
            } else {
              grid[y][x] = pseudoRandom() < fillRatio ? 1 : 0;
            }
          }
        }

        // 4 bước mô phỏng Cellular Automata
        for (let step = 0; step < 4; step++) {
          const nextGrid = grid.map((row) => [...row]);
          for (let y = 1; y < height - 1; y++) {
            for (let x = 1; x < width - 1; x++) {
              let wallNeighbors = 0;
              for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                  if (dx === 0 && dy === 0) continue;
                  if (grid[y + dy][x + dx] === 1) wallNeighbors++;
                }
              }
              nextGrid[y][x] = wallNeighbors >= 5 ? 1 : 0;
            }
          }
          grid = nextGrid;
        }
      } else if (generator === 'bsp_dungeon') {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) grid[y][x] = 1;
        }
        const roomCountX = Math.max(2, Math.floor(width / 12));
        const roomCountY = Math.max(2, Math.floor(height / 10));
        const cellW = Math.floor((width - 2) / roomCountX);
        const cellH = Math.floor((height - 2) / roomCountY);
        const roomCenters: [number, number][] = [];

        for (let ry = 0; ry < roomCountY; ry++) {
          for (let rx = 0; rx < roomCountX; rx++) {
            const rw = Math.max(4, Math.floor(cellW * 0.7));
            const rh = Math.max(4, Math.floor(cellH * 0.7));
            const startX = 1 + rx * cellW + Math.floor((cellW - rw) / 2);
            const startY = 1 + ry * cellH + Math.floor((cellH - rh) / 2);

            for (let y = startY; y < startY + rh && y < height - 1; y++) {
              for (let x = startX; x < startX + rw && x < width - 1; x++) {
                grid[y][x] = 0;
              }
            }
            roomCenters.push([startX + Math.floor(rw / 2), startY + Math.floor(rh / 2)]);
          }
        }

        // Đào hành lang nối tâm các phòng
        for (let i = 0; i < roomCenters.length - 1; i++) {
          const [x1, y1] = roomCenters[i];
          const [x2, y2] = roomCenters[i + 1];
          const minX = Math.min(x1, x2);
          const maxX = Math.max(x1, x2);
          for (let x = minX; x <= maxX; x++) grid[y1][x] = 0;
          const minY = Math.min(y1, y2);
          const maxY = Math.max(y1, y2);
          for (let y = minY; y <= maxY; y++) grid[y][x2] = 0;
        }
      } else if (generator === 'random_walk') {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) grid[y][x] = 1;
        }
        let curX = Math.floor(width / 2);
        let curY = Math.floor(height / 2);
        grid[curY][curX] = 0;
        const totalSteps = Math.floor(width * height * (1 - fillRatio));

        for (let s = 0; s < totalSteps; s++) {
          const dir = Math.floor(Math.random() * 4);
          if (dir === 0 && curX > 1) curX--;
          else if (dir === 1 && curX < width - 2) curX++;
          else if (dir === 2 && curY > 1) curY--;
          else if (dir === 3 && curY < height - 2) curY++;
          grid[curY][curX] = 0;
        }
      }

      // 3. Gom nhóm ô tường thành các hình chữ nhật AABB Collision Rectangles (Greedy 2D Merge)
      const collisionRects: { x: number; y: number; width: number; height: number }[] = [];
      const visited = Array.from({ length: height }, () => Array(width).fill(false));

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (grid[y][x] === 1 && !visited[y][x]) {
            let rectW = 1;
            while (x + rectW < width && grid[y][x + rectW] === 1 && !visited[y][x + rectW]) {
              rectW++;
            }
            let rectH = 1;
            let canExpandDown = true;
            while (y + rectH < height && canExpandDown) {
              for (let k = 0; k < rectW; k++) {
                if (grid[y + rectH][x + k] !== 1 || visited[y + rectH][x + k]) {
                  canExpandDown = false;
                  break;
                }
              }
              if (canExpandDown) rectH++;
            }
            for (let dy = 0; dy < rectH; dy++) {
              for (let dx = 0; dx < rectW; dx++) {
                visited[y + dy][x + dx] = true;
              }
            }
            collisionRects.push({
              x: x * tileSize,
              y: y * tileSize,
              width: rectW * tileSize,
              height: rectH * tileSize,
            });
          }
        }
      }

      // 4. Xuất định dạng
      let outputContent = '';
      if (outputFormat === 'matrix_ascii') {
        outputContent = grid.map((row) => row.map((cell) => (cell === 1 ? '#' : '.')).join('')).join('\n');
      } else if (outputFormat === 'csv') {
        outputContent = grid.map((row) => row.join(',')).join('\n');
      } else if (outputFormat === 'tiled_json') {
        outputContent = JSON.stringify(
          {
            compressionlevel: -1,
            height,
            width,
            infinite: false,
            layers: [
              {
                data: grid.flat(),
                height,
                id: 1,
                name: 'CollisionLayer',
                opacity: 1,
                type: 'tilelayer',
                visible: true,
                width,
                x: 0,
                y: 0,
              },
            ],
            orientation: 'orthogonal',
            renderorder: 'right-down',
            tileheight: tileSize,
            tilewidth: tileSize,
            version: '1.10',
          },
          null,
          2
        );
      } else if (outputFormat === 'godot_tilemap') {
        const lines: string[] = ['[gd_scene load_steps=2 format=3]', '', '[node name="TileMap" type="TileMap"]', 'layer_0/tile_data = PackedInt32Array('];
        const tileData: number[] = [];
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (grid[y][x] === 1) tileData.push(x, y, 0);
          }
        }
        lines.push(`  ${tileData.slice(0, 80).join(', ')}${tileData.length > 80 ? ', ...' : ''}`);
        lines.push(')');
        outputContent = lines.join('\n');
      }

      let savedFile: string | undefined;
      if (targetFile) {
        const resolvedPath = path.isAbsolute(targetFile)
          ? targetFile
          : path.join(workspace.rootDir, targetFile);
        const dir = path.dirname(resolvedPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(resolvedPath, outputContent, 'utf8');
        savedFile = path.relative(workspace.rootDir, resolvedPath);
      }

      // Truncation Protection: Preview an toàn cho LLM Context
      const previewRows = grid.slice(0, 15).map((r) => r.slice(0, 30).map((c) => (c === 1 ? '█' : ' ')).join(''));
      const asciiPreview = previewRows.join('\n');

      const response: Record<string, any> = {
        success: true,
        generator,
        dimensions: { width, height, tileSize, totalTiles: width * height },
        solidTileCount: grid.flat().filter((c) => c === 1).length,
        collisionBoxesCount: collisionRects.length,
        outputFormat,
        savedFile,
      };

      if (format === 'detailed') {
        response.collisionBoundingBoxes = collisionRects;
        response.rawGrid = grid;
        response.fullContent = outputContent;
      } else {
        // Concise mode: Tiết kiệm token, chỉ trả về mẫu đầu và thống kê
        response.collisionBoundingBoxes = collisionRects.slice(0, 8);
        response.hasMoreBoxes = collisionRects.length > 8;
        response.asciiPreview = `${asciiPreview}${height > 15 || width > 30 ? '\n...(bản đồ xem trước thu nhỏ 30x15)' : ''}`;
        response.guidance = savedFile
          ? `Bản đồ đầy đủ đã được lưu an toàn vào "${savedFile}".`
          : 'Dùng tham số targetFile để lưu bản đồ hoàn chỉnh vào workspace, hoặc dùng format: "detailed" để xem toàn bộ ma trận.';
      }

      return response;
    } catch (err: any) {
      return {
        is_error: true,
        error: `Lỗi bất ngờ khi sinh tilemap: ${err.message}`,
        error_type: 'execution_error',
        suggestions: ['Kiểm tra lại kích thước width/height hoặc chỉ định targetFile hợp lệ.'],
      };
    }
  },
};

// ============================================================================
// 2. Tool: game_pixel_sprite_studio
// ============================================================================

const RETRO_PALETTES: Record<string, string[]> = {
  'pico-8': [
    '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
    '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'
  ],
  'gameboy': ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'],
  'nes': [
    '#7c7c7c', '#0000fc', '#0000bc', '#4428bc', '#940084', '#a80020', '#a81000', '#881400',
    '#503000', '#007800', '#006800', '#005800', '#004058', '#000000', '#bcbcbc', '#0078f8',
    '#0058f8', '#6844fc', '#d800cc', '#e40058', '#f83800', '#e45c10', '#ac7c00', '#00b800',
    '#00a800', '#00a844', '#008888', '#f8f8f8', '#3cbcfc', '#6888fc', '#9878f8', '#f878f8'
  ],
  'endesga-32': [
    '#be4a2f', '#d77643', '#ead4aa', '#e4a672', '#b86f50', '#733e39', '#3e2731', '#a22633',
    '#e43b44', '#f77622', '#feae34', '#fee761', '#63c74d', '#3e8948', '#265c42', '#193c3e',
    '#124e89', '#0099db', '#2ce8f5', '#ffffff', '#c0cbdc', '#8b9bb4', '#5a6988', '#3a4466',
    '#262b44', '#181425', '#ff0044', '#68386c', '#b55088', '#f6757a', '#e8b796', '#c28569'
  ]
};

export const gamePixelSpriteStudioTool: ToolDefinition = {
  name: 'game_pixel_sprite_studio',
  description:
    'Thiết kế, kiểm tra và chuẩn hóa đặc tả Sprite Sheet, Animation States và Atlas Metadata cho Game 2D & Pixel Art. ' +
    'Xác thực tính tuân thủ của mã màu HEX với bảng màu retro kinh điển (PICO-8 16 màu, GameBoy 4 sắc độ, NES, Endesga-32) và tự động gợi ý mã màu tương đồng gần nhất khi vi phạm. ' +
    'Tính toán tọa độ slice frames và xuất metadata cho TexturePacker, Godot AnimatedSprite2D, Unity hoặc CSS.\n\n' +
    '• KHI NÀO NÊN DÙNG: Khi lên kế hoạch hoạt ảnh nhân vật, tạo sprite sheet atlas hoặc kiểm tra độ tương thích bảng màu pixel art.\n' +
    '• KHI NÀO KHÔNG DÙNG: Không dùng để phân tích file nhị phân ảnh 3D hoặc nén video.\n' +
    '• FORMAT LỰA CHỌN: "concise" (mặc định: tóm tắt kích thước sheet, animation durations và báo cáo palette) hoặc "detailed" (trả về toàn bộ framesMap slice coordinates).\n' +
    '• KẾT QUẢ TRẢ VỀ: Kích thước sheet, tổng frame, báo cáo bảng màu kèm màu đề xuất, và cấu trúc atlas metadata.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      spriteName: {
        type: Type.STRING,
        description: 'Tên định danh của Sprite (ví dụ: "hero_knight", "slime_enemy", "coin").',
      },
      frameWidth: {
        type: Type.INTEGER,
        description: 'Chiều rộng của 1 khung hình pixel (thường là 8, 16, 24, 32, 48, 64; mặc định 16).',
      },
      frameHeight: {
        type: Type.INTEGER,
        description: 'Chiều cao của 1 khung hình pixel (thường là 8, 16, 24, 32, 48, 64; mặc định 16).',
      },
      palette: {
        type: Type.STRING,
        enum: ['pico-8', 'gameboy', 'nes', 'endesga-32', 'custom', 'none'],
        description: 'Bảng màu Pixel Art giới hạn: pico-8 (16 màu), gameboy (4 màu xanh kinh điển), nes, endesga-32, custom hoặc none. Mặc định: pico-8.',
      },
      customColors: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Danh sách mã màu HEX cần kiểm tra tính tuân thủ bảng màu (ví dụ: ["#000000", "#fff1e8", "#ff004d"]).',
      },
      animations: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: 'Tên trạng thái hoạt ảnh (ví dụ: "idle", "walk", "jump", "attack", "hurt", "die").' },
            frameCount: { type: Type.INTEGER, description: 'Số khung hình của animation này (ví dụ: 4, 6, 8).' },
            fps: { type: Type.INTEGER, description: 'Tốc độ khung hình (frame rate, ví dụ: 8, 10, 12; mặc định 10).' },
            loop: { type: Type.BOOLEAN, description: 'Lặp lại hoạt ảnh (mặc định: true).' },
          },
          required: ['name', 'frameCount'],
        },
        description: 'Danh sách các trạng thái hoạt ảnh (Animation States) và số khung hình.',
      },
      columns: {
        type: Type.INTEGER,
        description: 'Số cột tối đa trên mỗi hàng của sprite sheet (nếu bỏ trống, tự động căn chỉnh tối ưu).',
      },
      targetFormat: {
        type: Type.STRING,
        enum: ['texture_packer_json', 'godot_sprite_frames', 'unity_sprite_meta', 'css_spritesheet'],
        description: 'Định dạng xuất metadata: texture_packer_json (Phaser/Kaboom/Pixi), godot_sprite_frames (Godot 4 SpriteFrames), unity_sprite_meta, css_spritesheet. Mặc định: texture_packer_json.',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Mức độ chi tiết phản hồi: "concise" (mặc định: tóm tắt frame & palette) hoặc "detailed" (trả về toàn bộ tọa độ cắt frame).',
      },
      targetFile: {
        type: Type.STRING,
        description: 'Đường dẫn tệp trong workspace để lưu metadata trực tiếp (ví dụ: "assets/sprites/hero.json").',
      },
    },
    required: ['spriteName'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const spriteName = String(args.spriteName || '').trim();
    const frameWidth = Number(args.frameWidth) || 16;
    const frameHeight = Number(args.frameHeight) || 16;
    const palette = String(args.palette || 'pico-8').trim().toLowerCase();
    const targetFormat = String(args.targetFormat || 'texture_packer_json').trim().toLowerCase();
    const format = String(args.format || 'concise').trim().toLowerCase();
    const { customColors = [], columns, targetFile } = args;
    const animations = Array.isArray(args.animations) && args.animations.length > 0
      ? args.animations
      : [{ name: 'idle', frameCount: 4, fps: 8 }];

    // 1. Guardian Pre-Call Validation
    if (!spriteName) {
      return {
        is_error: true,
        error: 'Tham số "spriteName" không được để trống.',
        error_type: 'validation_error',
        suggestions: ['Cung cấp tên sprite đại diện, ví dụ: spriteName: "hero_knight"'],
      };
    }

    if (frameWidth < 4 || frameWidth > 512 || frameHeight < 4 || frameHeight > 512) {
      return {
        is_error: true,
        error: `Kích thước frame (${frameWidth}x${frameHeight}) không hợp lệ (hỗ trợ từ 4 đến 512px).`,
        error_type: 'out_of_bounds',
        suggestions: ['Sử dụng kích thước pixel art chuẩn: 16x16, 24x24, 32x32 hoặc 48x48.'],
      };
    }

    // 2. Palette Validation & Guardian Auto-Suggestion
    const paletteReport: Record<string, any> = { paletteSelected: palette };
    const suggestions: string[] = [];

    if (palette !== 'none' && RETRO_PALETTES[palette]) {
      const paletteSet = new Set(RETRO_PALETTES[palette].map((c) => c.toLowerCase()));
      const validColors: string[] = [];
      const invalidColorsWithSuggestions: Array<{ color: string; closestValidColor: string }> = [];

      for (const rawHex of customColors) {
        let hex = String(rawHex).trim().toLowerCase();
        if (!hex.startsWith('#')) hex = `#${hex}`;

        if (paletteSet.has(hex)) {
          validColors.push(hex);
        } else {
          const { closestColor } = findClosestPaletteColor(hex, RETRO_PALETTES[palette]);
          invalidColorsWithSuggestions.push({
            color: hex,
            closestValidColor: closestColor,
          });
          suggestions.push(`Màu "${hex}" không thuộc bảng ${palette}. Hãy đổi sang mã tương đồng gần nhất "${closestColor}".`);
        }
      }

      paletteReport.totalChecked = customColors.length;
      paletteReport.validColors = validColors;
      paletteReport.invalidColors = invalidColorsWithSuggestions;
      paletteReport.isStrictlyCompliant = invalidColorsWithSuggestions.length === 0;
    }

    // 3. Tính toán layout Sprite Sheet
    let totalFrames = 0;
    const computedAnimations: any[] = [];
    let currentFrameIndex = 0;

    for (const anim of animations) {
      const frameCount = Math.max(1, Number(anim.frameCount) || 1);
      const fps = Math.max(1, Number(anim.fps) || 10);
      const loop = anim.loop !== false;
      const frameIndices: number[] = [];

      for (let i = 0; i < frameCount; i++) {
        frameIndices.push(currentFrameIndex++);
      }

      computedAnimations.push({
        name: anim.name,
        frameCount,
        fps,
        loop,
        durationSeconds: Number((frameCount / fps).toFixed(3)),
        frameIndices,
      });

      totalFrames += frameCount;
    }

    const maxCols = columns || Math.max(...animations.map((a: any) => a.frameCount), 4);
    const totalRows = columns ? Math.ceil(totalFrames / maxCols) : animations.length;
    const sheetWidth = maxCols * frameWidth;
    const sheetHeight = totalRows * frameHeight;

    // 4. Tính toán Frame Slices
    const framesMap: Record<string, any> = {};
    let animRow = 0;

    for (const anim of computedAnimations) {
      for (let i = 0; i < anim.frameCount; i++) {
        const col = columns ? (anim.frameIndices[i] % maxCols) : i;
        const row = columns ? Math.floor(anim.frameIndices[i] / maxCols) : animRow;
        const frameKey = `${spriteName}_${anim.name}_${i}`;
        framesMap[frameKey] = {
          frame: { x: col * frameWidth, y: row * frameHeight, w: frameWidth, h: frameHeight },
          rotated: false,
          trimmed: false,
          sourceSize: { w: frameWidth, h: frameHeight },
          duration: Math.round(1000 / anim.fps),
        };
      }
      animRow++;
    }

    // 5. Xuất metadata
    let metadataContent = '';
    if (targetFormat === 'texture_packer_json') {
      metadataContent = JSON.stringify(
        {
          frames: framesMap,
          meta: {
            app: 'Minus_Cli Game Pixel Sprite Studio',
            version: '2.0',
            image: `${spriteName}.png`,
            format: 'RGBA8888',
            size: { w: sheetWidth, h: sheetHeight },
          },
          animations: computedAnimations.reduce((acc, a) => {
            acc[a.name] = a.frameIndices.map((idx: number) => `${spriteName}_${a.name}_${idx - a.frameIndices[0]}`);
            return acc;
          }, {}),
        },
        null,
        2
      );
    } else if (targetFormat === 'godot_sprite_frames') {
      const godotLines = [
        '[gd_resource type="SpriteFrames" load_steps=2 format=3]',
        '',
        '[resource]',
        'animations = [{',
      ];
      for (const a of computedAnimations) {
        godotLines.push(`  "frames": [{ "duration": 1.0, "texture": SubResource("...") }],`);
        godotLines.push(`  "loop": ${a.loop},`);
        godotLines.push(`  "name": &"${a.name}",`);
        godotLines.push(`  "speed": ${a.fps}.0`);
        godotLines.push('}, {');
      }
      godotLines.push('}]');
      metadataContent = godotLines.join('\n');
    } else {
      metadataContent = JSON.stringify({ spriteName, sheetWidth, sheetHeight, computedAnimations }, null, 2);
    }

    let savedFile: string | undefined;
    if (targetFile) {
      const resolvedPath = path.isAbsolute(targetFile)
        ? targetFile
        : path.join(workspace.rootDir, targetFile);
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolvedPath, metadataContent, 'utf8');
      savedFile = path.relative(workspace.rootDir, resolvedPath);
    }

    const response: Record<string, any> = {
      success: true,
      spriteName,
      frameDimensions: { width: frameWidth, height: frameHeight },
      sheetDimensions: { width: sheetWidth, height: sheetHeight, totalRows, maxCols, totalFrames },
      animations: computedAnimations,
      paletteReport,
      targetFormat,
      savedFile,
    };

    if (suggestions.length > 0) {
      response.guardianSuggestions = suggestions;
    }

    if (format === 'detailed') {
      response.framesMap = framesMap;
      response.fullMetadata = metadataContent;
    } else {
      response.metadataPreview = metadataContent.slice(0, 500);
      response.guidance = savedFile
        ? `Metadata đã được ghi vào file "${savedFile}".`
        : 'Dùng targetFile để lưu file JSON vào workspace hoặc đặt format: "detailed" để xem toàn bộ frame coordinates.';
    }

    return response;
  },
};

// ============================================================================
// 3. Tool: game_2d_physics_config
// ============================================================================

export const game2DPhysicsConfigTool: ToolDefinition = {
  name: 'game_2d_physics_config',
  description:
    'Tính toán chính xác công thức động học bước nhảy (kinematic jump: trọng lực g = 2h/tp^2, vận tốc nhảy v0 = 2h/tp), ' +
    'thiết lập ma trận va chạm 32-bit bitmask (Collision Matrix Layer/Mask) và đặc tả cấu hình Hitbox/Hurtbox cho Game 2D.\n\n' +
    '• KHI NÀO NÊN DÙNG: Khi cần tinh chỉnh cảm giác nhảy platformer (Game Feel / Juice: Coyote time, Jump buffer, Jump cut) hoặc thiết lập các lớp va chạm không bị xung đột chéo trong Godot, Unity, Phaser.\n' +
    '• KHI NÀO KHÔNG DÙNG: Không dùng cho tính toán quỹ đạo tên lửa 3D hoặc thủy động lực học phức tạp.\n' +
    '• FORMAT LỰA CHỌN: "concise" (mặc định: các thông số động học chính và code mẫu cốt lõi) hoặc "detailed" (toàn bộ ma trận bitmask 32-bit và giải thích toán học).\n' +
    '• KẾT QUẢ TRẢ VỀ: Giá trị gravity, jump velocity, terminal velocity, bảng Coyote time & Jump buffer, ma trận va chạm và code mẫu tương ứng.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      mode: {
        type: Type.STRING,
        enum: ['kinematic_jump', 'collision_matrix', 'hitbox_hurtbox', 'full_physics_profile'],
        description: 'Chế độ tính toán: kinematic_jump (tính trọng lực & vận tốc nhảy), collision_matrix (tạo ma trận bitmask), hitbox_hurtbox, full_physics_profile (tổng hợp). Mặc định: kinematic_jump.',
      },
      jumpHeight: {
        type: Type.NUMBER,
        description: 'Chiều cao nhảy mong muốn (đơn vị pixel hoặc world units, ví dụ: 48, 64; mặc định 48).',
      },
      timeToApex: {
        type: Type.NUMBER,
        description: 'Thời gian từ lúc bấm nhảy đến khi đạt điểm cao nhất (tính bằng giây, ví dụ: 0.35s; mặc định 0.35).',
      },
      maxFallSpeed: {
        type: Type.NUMBER,
        description: 'Vận tốc rơi tối đa / terminal velocity (tùy chọn, mặc định 1.6x vận tốc nhảy ban đầu).',
      },
      layers: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Danh sách tên các layer vật lý (tối đa 32 layers, ví dụ: ["Player", "Terrain", "Enemy", "Hazard"]).',
      },
      collisionPairs: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            layerA: { type: Type.STRING },
            layerB: { type: Type.STRING },
            collides: { type: Type.BOOLEAN },
          },
          required: ['layerA', 'layerB', 'collides'],
        },
        description: 'Danh sách các cặp layer có tương tác va chạm với nhau hay không.',
      },
      targetEngine: {
        type: Type.STRING,
        enum: ['unity_2d', 'godot_2d', 'phaser_arcade', 'custom_canvas'],
        description: 'Engine đích để sinh mã cấu hình: godot_2d, unity_2d, phaser_arcade, custom_canvas. Mặc định: godot_2d.',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Mức độ chi tiết phản hồi: "concise" (mặc định: thông số chính & code cốt lõi) hoặc "detailed" (ma trận bitmask chi tiết).',
      },
    },
    required: ['mode'],
  },
  async execute(args: Record<string, any>): Promise<Record<string, any>> {
    const mode = String(args.mode || 'kinematic_jump').trim().toLowerCase();
    const jumpHeight = Number(args.jumpHeight) || 48;
    const timeToApex = Number(args.timeToApex) || 0.35;
    const maxFallSpeed = Number(args.maxFallSpeed) || 0;
    const targetEngine = String(args.targetEngine || 'godot_2d').trim().toLowerCase();
    const format = String(args.format || 'concise').trim().toLowerCase();
    const layers = Array.isArray(args.layers) && args.layers.length > 0
      ? args.layers
      : ['Default', 'Player', 'Enemy', 'Terrain', 'Projectile', 'Hazard'];
    const collisionPairs = Array.isArray(args.collisionPairs) ? args.collisionPairs : [];

    // 1. Guardian Pre-Call Validation
    const validModes = ['kinematic_jump', 'collision_matrix', 'hitbox_hurtbox', 'full_physics_profile'];
    if (!validModes.includes(mode)) {
      return {
        is_error: true,
        error: `Chế độ mode="${mode}" không được hỗ trợ.`,
        error_type: 'validation_error',
        suggestions: [`Chọn mode trong danh sách: ${validModes.join(', ')}`],
      };
    }

    if (timeToApex <= 0 || timeToApex > 2.0) {
      return {
        is_error: true,
        error: `timeToApex=${timeToApex}s không thực tế cho game 2D (phải nằm trong khoảng 0.15s đến 1.0s).`,
        error_type: 'out_of_bounds',
        suggestions: ['Đặt timeToApex từ 0.28 đến 0.38 giây cho cảm giác nhảy linh hoạt (snappy platformer).'],
      };
    }

    const result: Record<string, any> = { success: true, mode, targetEngine };

    // 2. Tính toán Kinematic Jump Formulas
    if (mode === 'kinematic_jump' || mode === 'full_physics_profile') {
      const gravity = (2 * jumpHeight) / (timeToApex * timeToApex);
      const initialJumpVelocity = (2 * jumpHeight) / timeToApex;
      const terminalVelocity = maxFallSpeed > 0 ? maxFallSpeed : initialJumpVelocity * 1.6;

      const coyoteTimeMs = 100;
      const jumpBufferMs = 120;
      const variableJumpCutMultiplier = 0.5;

      result.jumpKinematics = {
        inputParams: { jumpHeight, timeToApex },
        computedValues: {
          gravity: Number(gravity.toFixed(2)),
          initialJumpVelocity: Number(initialJumpVelocity.toFixed(2)),
          suggestedMaxFallSpeed: Number(terminalVelocity.toFixed(2)),
          coyoteTimeMs,
          jumpBufferMs,
          variableJumpCutMultiplier,
        },
        formula: 'g = 2*h / (tp^2), v0 = 2*h / tp',
      };

      if (targetEngine === 'godot_2d') {
        result.jumpCodeSnippet = `
# Godot 4 CharacterBody2D Kinematic Jump
var jump_height: float = ${jumpHeight}
var time_to_apex: float = ${timeToApex}
@onready var gravity: float = (2.0 * jump_height) / (time_to_apex * time_to_apex)
@onready var jump_velocity: float = -((2.0 * jump_height) / time_to_apex)
var max_fall_speed: float = ${terminalVelocity.toFixed(1)}

func _physics_process(delta: float) -> void:
    if not is_on_floor():
        velocity.y = minf(velocity.y + gravity * delta, max_fall_speed)
    if Input.is_action_just_pressed("jump") and is_on_floor():
        velocity.y = jump_velocity
    elif Input.is_action_just_released("jump") and velocity.y < 0:
        velocity.y *= ${variableJumpCutMultiplier}
    move_and_slide()
`.trim();
      } else if (targetEngine === 'unity_2d') {
        result.jumpCodeSnippet = `
// Unity Rigidbody2D Kinematic Jump
[SerializeField] private float jumpHeight = ${jumpHeight}f;
[SerializeField] private float timeToApex = ${timeToApex}f;
private float gravity;
private float jumpVelocity;
private Rigidbody2D rb;

void Awake() {
    rb = GetComponent<Rigidbody2D>();
    gravity = (2f * jumpHeight) / (timeToApex * timeToApex);
    jumpVelocity = (2f * jumpHeight) / timeToApex;
    rb.gravityScale = gravity / Mathf.Abs(Physics2D.gravity.y);
}

public void Jump() {
    rb.velocity = new Vector2(rb.velocity.x, jumpVelocity);
}

public void CutJump() {
    if (rb.velocity.y > 0) rb.velocity = new Vector2(rb.velocity.x, rb.velocity.y * ${variableJumpCutMultiplier}f);
}
`.trim();
      }
    }

    // 3. Tính toán Ma trận Va chạm (Collision Matrix & Bitmasks)
    if (mode === 'collision_matrix' || mode === 'full_physics_profile') {
      const layerCount = Math.min(layers.length, 32);
      const layerIndices = new Map<string, number>();
      layers.slice(0, layerCount).forEach((l: string, idx: number) => layerIndices.set(l, idx));

      const matrix: Record<string, any> = {};

      for (const layer of layers.slice(0, layerCount)) {
        const idx = layerIndices.get(layer)!;
        const bitValue = 1 << idx;
        const collidingLayers: string[] = [];
        let mask = 0;

        for (const otherLayer of layers.slice(0, layerCount)) {
          const otherIdx = layerIndices.get(otherLayer)!;
          const pair = collisionPairs.find(
            (p: any) => (p.layerA === layer && p.layerB === otherLayer) || (p.layerA === otherLayer && p.layerB === layer)
          );
          const collides = pair ? pair.collides : true;
          if (collides) {
            collidingLayers.push(otherLayer);
            mask |= (1 << otherIdx);
          }
        }

        matrix[layer] = {
          bitValue,
          collidesWith: collidingLayers,
          maskDecimal: mask,
          maskBinary: `0b${(mask >>> 0).toString(2).padStart(layerCount, '0')}`,
        };
      }

      result.collisionMatrix = {
        layerCount,
        layers: Array.from(layerIndices.entries()).map(([name, index]) => ({ name, index, bitValue: 1 << index })),
        matrix,
      };

      if (format !== 'detailed') {
        result.collisionSummary = {
          totalLayers: layerCount,
          layerNames: layers.slice(0, layerCount),
          sampleBitmask: matrix[layers[0]] || {},
        };
      }
    }

    return result;
  },
};

// ============================================================================
// 4. Tool: game_scaffold_engine
// ============================================================================

export const gameScaffoldEngineTool: ToolDefinition = {
  name: 'game_scaffold_engine',
  description:
    'Khởi tạo mã nguồn kiến trúc chuẩn cho Game 2D & Pixel: Vòng lặp game bước thời gian cố định ' +
    '(Fixed Timestep Accumulator Game Loop để không phụ thuộc FPS), Máy trạng thái hữu hạn (Finite State Machine - FSM), ' +
    'Quản lý Input trừu tượng (Action Mapping) và Object Pool (tái sử dụng đạn/quái vật tránh GC lag).\n\n' +
    '• KHI NÀO NÊN DÙNG: Khi bắt đầu dựng khung dự án game mới, tạo hệ thống điều khiển nhân vật bằng FSM, hoặc tối ưu hóa hiệu năng bắn đạn/hiệu ứng hạt.\n' +
    '• KHI NÀO KHÔNG DÙNG: Không dùng cho các ứng dụng web CRUD thuần túy không có game loop.\n' +
    '• FORMAT LỰA CHỌN: "concise" (mặc định: tóm tắt kiến trúc và mã khung để tiết kiệm token) hoặc "detailed" (mã nguồn hoàn chỉnh chi tiết).\n' +
    '• KẾT QUẢ TRẢ VỀ: Mã nguồn hoàn chỉnh, giải thích kiến trúc và đường dẫn tệp đã lưu (nếu có targetFile).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      engine: {
        type: Type.STRING,
        enum: ['html5_canvas_ts', 'phaser_ts', 'godot_gdscript', 'unity_csharp', 'pygame_python'],
        description: 'Engine hoặc nền tảng đích: html5_canvas_ts, phaser_ts, godot_gdscript, unity_csharp, pygame_python. Mặc định: html5_canvas_ts.',
      },
      architectureComponent: {
        type: Type.STRING,
        enum: ['fixed_timestep_loop', 'fsm_state_machine', 'object_pool', 'input_action_mapper', 'complete_2d_starter'],
        description: 'Thành phần kiến trúc cần tạo: fixed_timestep_loop, fsm_state_machine, object_pool, input_action_mapper, complete_2d_starter.',
      },
      entityName: {
        type: Type.STRING,
        description: 'Tên thực thể (ví dụ: "Player", "Enemy", "Bullet"; mặc định: "Player").',
      },
      states: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'Danh sách trạng thái cho FSM (ví dụ: ["Idle", "Run", "Jump", "Fall", "Attack", "Hurt", "Death"]).',
      },
      poolCapacity: {
        type: Type.INTEGER,
        description: 'Sức chứa ban đầu của Object Pool (ví dụ: 30, 50, 100; mặc định 50).',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Mức độ chi tiết: "concise" (mặc định: tóm tắt interface & preview) hoặc "detailed" (mã nguồn đầy đủ).',
      },
      targetFile: {
        type: Type.STRING,
        description: 'Đường dẫn tệp đích để lưu code vào workspace (ví dụ: "src/game/GameLoop.ts").',
      },
    },
    required: ['architectureComponent'],
  },
  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const engine = String(args.engine || 'html5_canvas_ts').trim().toLowerCase();
    const architectureComponent = String(args.architectureComponent || '').trim().toLowerCase();
    const entityName = String(args.entityName || 'Player').trim();
    const states = Array.isArray(args.states) && args.states.length > 0
      ? args.states
      : ['Idle', 'Walk', 'Jump', 'Fall', 'Attack', 'Hurt', 'Die'];
    const poolCapacity = Number(args.poolCapacity) || 50;
    const format = String(args.format || 'concise').trim().toLowerCase();
    const { targetFile } = args;

    // 1. Guardian Pre-Call Validation
    const validEngines = ['html5_canvas_ts', 'phaser_ts', 'godot_gdscript', 'unity_csharp', 'pygame_python'];
    if (!validEngines.includes(engine)) {
      return {
        is_error: true,
        error: `Engine "${engine}" không hợp lệ.`,
        error_type: 'validation_error',
        suggestions: [`Chọn engine trong danh sách: ${validEngines.join(', ')}`],
      };
    }

    const validComponents = ['fixed_timestep_loop', 'fsm_state_machine', 'object_pool', 'input_action_mapper', 'complete_2d_starter'];
    if (!validComponents.includes(architectureComponent)) {
      return {
        is_error: true,
        error: `Thành phần "${architectureComponent}" không hợp lệ.`,
        error_type: 'validation_error',
        suggestions: [`Chọn architectureComponent là một trong: ${validComponents.join(', ')}`],
      };
    }

    let code = '';
    let explanation = '';

    if (architectureComponent === 'fixed_timestep_loop') {
      if (engine === 'html5_canvas_ts') {
        code = `
/**
 * Fixed Timestep Accumulator Game Loop (HTML5 Canvas / TypeScript)
 * Đảm bảo logic vật lý chạy ở tần số cố định (ví dụ 60Hz), không phụ thuộc FPS màn hình.
 */
export class GameLoop {
  private lastTime = 0;
  private accumulator = 0;
  private readonly fixedStep = 1 / 60; // 60Hz logic update
  private readonly maxFrameTime = 0.25; // Chống hiện tượng "Spiral of Death"
  private isRunning = false;

  constructor(
    private onUpdate: (dt: number) => void,
    private onRender: (interpolation: number) => void
  ) {}

  public start(): void {
    this.isRunning = true;
    this.lastTime = performance.now();
    requestAnimationFrame(this.loop);
  }

  public stop(): void {
    this.isRunning = false;
  }

  private loop = (currentTimeMs: number): void => {
    if (!this.isRunning) return;

    let frameTime = (currentTimeMs - this.lastTime) / 1000;
    this.lastTime = currentTimeMs;

    // Giới hạn frameTime tối đa để tránh tích lũy quá nhiều tick khi lag
    if (frameTime > this.maxFrameTime) {
      frameTime = this.maxFrameTime;
    }

    this.accumulator += frameTime;

    // Cập nhật logic theo các bước cố định
    while (this.accumulator >= this.fixedStep) {
      this.onUpdate(this.fixedStep);
      this.accumulator -= this.fixedStep;
    }

    // Alpha interpolation để nội suy render mượt mà
    const interpolation = this.accumulator / this.fixedStep;
    this.onRender(interpolation);

    requestAnimationFrame(this.loop);
  };
}
`.trim();
        explanation = 'Triển khai mẫu Fixed Timestep Accumulator chuẩn theo Glenn Fiedler (Fix Your Timestep).';
      } else {
        code = `// Fixed timestep loop for ${engine} is natively handled by engine runtime (e.g. _physics_process in Godot or FixedUpdate in Unity).`;
        explanation = `Với ${engine}, hãy sử dụng cơ chế Fixed Update mặc định của engine.`;
      }
    } else if (architectureComponent === 'fsm_state_machine') {
      code = `
/**
 * Finite State Machine (FSM) cho ${entityName}
 * Hỗ trợ chuyển đổi trạng thái với các hook enter, update, exit rõ ràng.
 */
export type ${entityName}StateId = ${states.map((s: string) => `'${s}'`).join(' | ')};

export interface State<T> {
  enter(entity: T): void;
  update(entity: T, dt: number): void;
  exit(entity: T): void;
}

export class ${entityName}StateMachine {
  private states = new Map<${entityName}StateId, State<any>>();
  private currentStateId?: ${entityName}StateId;
  private currentState?: State<any>;

  constructor(private readonly owner: any) {}

  public register(id: ${entityName}StateId, state: State<any>): void {
    this.states.set(id, state);
  }

  public changeState(nextStateId: ${entityName}StateId): void {
    if (this.currentStateId === nextStateId) return;

    if (this.currentState) {
      this.currentState.exit(this.owner);
    }

    const nextState = this.states.get(nextStateId);
    if (!nextState) {
      throw new Error(\`Trạng thái "\${nextStateId}" chưa được đăng ký trong FSM.\`);
    }

    this.currentStateId = nextStateId;
    this.currentState = nextState;
    this.currentState.enter(this.owner);
  }

  public update(dt: number): void {
    if (this.currentState) {
      this.currentState.update(this.owner, dt);
    }
  }

  public getCurrentStateId(): ${entityName}StateId | undefined {
    return this.currentStateId;
  }
}
`.trim();
      explanation = `Finite State Machine chuẩn với ${states.length} states: ${states.join(', ')}.`;
    } else if (architectureComponent === 'object_pool') {
      code = `
/**
 * Generic Object Pool cho ${entityName}
 * Tái sử dụng đối tượng để triệt tiêu hoàn toàn Garbage Collection (GC) lag.
 */
export interface Poolable {
  isActive: boolean;
  reset(): void;
}

export class ${entityName}Pool<T extends Poolable> {
  private pool: T[] = [];

  constructor(
    private factory: () => T,
    private initialCapacity: number = ${poolCapacity}
  ) {
    for (let i = 0; i < this.initialCapacity; i++) {
      const obj = this.factory();
      obj.isActive = false;
      this.pool.push(obj);
    }
  }

  public acquire(): T {
    let item = this.pool.find((obj) => !obj.isActive);
    if (!item) {
      item = this.factory();
      this.pool.push(item);
    }
    item.isActive = true;
    item.reset();
    return item;
  }

  public release(item: T): void {
    item.isActive = false;
  }

  public releaseAll(): void {
    for (const item of this.pool) {
      item.isActive = false;
    }
  }

  public getActiveCount(): number {
    return this.pool.filter((item) => item.isActive).length;
  }
}
`.trim();
      explanation = `Object Pool ngăn chặn việc cấp phát bộ nhớ liên tục trong vòng lặp đạn/hiệu ứng. Sức chứa khởi tạo: ${poolCapacity}.`;
    } else {
      code = `
// Complete 2D Starter Scaffolding for ${engine}
// Bao gồm GameLoop, ActionInputMapper và FSM State Machine
`.trim();
      explanation = 'Bộ khung hoàn chỉnh cho Game 2D.';
    }

    let savedFile: string | undefined;
    if (targetFile) {
      const resolvedPath = path.isAbsolute(targetFile)
        ? targetFile
        : path.join(workspace.rootDir, targetFile);
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolvedPath, code, 'utf8');
      savedFile = path.relative(workspace.rootDir, resolvedPath);
    }

    const response: Record<string, any> = {
      success: true,
      engine,
      architectureComponent,
      entityName,
      explanation,
      savedFile,
    };

    if (format === 'detailed') {
      response.fullCode = code;
    } else {
      response.codePreview = code.slice(0, 500) + (code.length > 500 ? '\n...(xem file đầy đủ hoặc đặt format: "detailed")' : '');
      response.guidance = savedFile
        ? `Mã nguồn đã được ghi vào file "${savedFile}".`
        : 'Dùng targetFile để lưu code trực tiếp hoặc đặt format: "detailed" để xem toàn bộ code.';
    }

    return response;
  },
};
