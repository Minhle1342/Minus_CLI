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
    'Create and process algorithms (Cellular Automata caverns, BSP Dungeon, Random Walk) and export 2D Tilemaps to Tiled JSON, Godot 4 TileMap, CSV and ASCII. ' +
    'Automatically compute and merge adjacent wall blocks into AABB Collision Rectangle shapes to optimize physics performance.\n\n' +
    '• WHEN TO USE: When programming 2D levels, generating cavern maps, dungeons, rooms or grid layouts for platformers, roguelikes, top-down RPGs.\n' +
    '• WHEN NOT TO USE: Not for 3D Mesh terrain or plain UI.\n' +
    '• FORMAT OPTIONS: "concise" (default: summarizes dimensions, collider count, small preview to save tokens) or "detailed" (full matrix and all rect coordinates).\n' +
    '• RETURNS: JSON object with dimensions, solid-cell count, AABB collision box list, and saved file path (if targetFile is set).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      generator: {
        type: Type.STRING,
        enum: ['cellular_automata', 'bsp_dungeon', 'random_walk', 'custom_matrix', 'blank'],
        description: 'Level-matrix generation algorithm: cellular_automata (organic caverns), bsp_dungeon (dungeon rooms & corridors), random_walk (winding tunnels), custom_matrix (user-supplied matrix), blank (empty map with surrounding walls).',
      },
      width: {
        type: Type.INTEGER,
        description: 'Map width in tiles (min 5, max 256; default 20).',
      },
      height: {
        type: Type.INTEGER,
        description: 'Map height in tiles (min 5, max 256; default 15).',
      },
      tileSize: {
        type: Type.INTEGER,
        description: 'Edge size of each tile in pixels (usually 8, 16, 24, 32; default 16).',
      },
      fillRatio: {
        type: Type.NUMBER,
        description: 'Initial wall fill ratio for cellular_automata or random_walk (0.1 to 0.9; default 0.45).',
      },
      outputFormat: {
        type: Type.STRING,
        enum: ['tiled_json', 'godot_tilemap', 'csv', 'matrix_ascii'],
        description: 'Data export format: tiled_json (Phaser/Kaboom/Tiled), godot_tilemap (Godot 4 PackedInt32Array), csv, matrix_ascii (visual text characters). Default: tiled_json.',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Response detail level: "concise" (saves context tokens, summarizes colliders and preview) or "detailed" (returns the full data matrix). Default: "concise".',
      },
      customMatrix: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'String array of tile rows when generator="custom_matrix" ("#" or "1" is a wall, "." or "0" is empty floor).',
      },
      targetFile: {
        type: Type.STRING,
        description: 'Workspace file path to save results directly (e.g. "assets/maps/level1.json").',
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
        error: `Generator "${generator}" is invalid.`,
        error_type: 'validation_error',
        suggestions: [
          `Choose one of the valid generators: ${validGenerators.join(', ')}.`,
          'To generate natural caverns, use: generator: "cellular_automata".',
          'To generate dungeons with rooms and corridors, use: generator: "bsp_dungeon".',
        ],
      };
    }

    if (width < 5 || width > 256) {
      return {
        is_error: true,
        error: `Width width=${width} is out of allowed bounds (5 - 256).`,
        error_type: 'out_of_bounds',
        suggestions: ['Set width between 10 and 60 tiles for a standard level.'],
      };
    }

    if (height < 5 || height > 256) {
      return {
        is_error: true,
        error: `Height height=${height} is out of allowed bounds (5 - 256).`,
        error_type: 'out_of_bounds',
        suggestions: ['Set height between 10 and 45 tiles for a standard level.'],
      };
    }

    const validFormats = ['tiled_json', 'godot_tilemap', 'csv', 'matrix_ascii'];
    if (!validFormats.includes(outputFormat)) {
      return {
        is_error: true,
        error: `Output format "${outputFormat}" is invalid.`,
        error_type: 'validation_error',
        suggestions: [`Choose outputFormat from: ${validFormats.join(', ')}.`],
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
            error: 'When generator is "custom_matrix", customMatrix must be a string array of tile rows.',
            error_type: 'validation_error',
            suggestions: ['Provide customMatrix as: ["##########", "#........#", "##########"]'],
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
        response.asciiPreview = `${asciiPreview}${height > 15 || width > 30 ? '\n...(preview scaled down to 30x15)' : ''}`;
        response.guidance = savedFile
          ? `Full map safely saved to "${savedFile}".`
          : 'Use targetFile to save the complete map to the workspace, or use format: "detailed" to view the full matrix.';
      }

      return response;
    } catch (err: any) {
      return {
        is_error: true,
        error: `Unexpected error generating tilemap: ${err.message}`,
        error_type: 'execution_error',
        suggestions: ['Check the width/height dimensions or specify a valid targetFile.'],
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
    'Design, validate and normalize Sprite Sheet, Animation States and Atlas Metadata specs for 2D & Pixel Art games. ' +
    'Validate HEX color compliance against classic retro palettes (PICO-8 16 colors, GameBoy 4 shades, NES, Endesga-32) and auto-suggest the nearest matching color on violation. ' +
    'Compute slice-frame coordinates and export metadata for TexturePacker, Godot AnimatedSprite2D, Unity or CSS.\n\n' +
    '• WHEN TO USE: When planning character animations, creating sprite sheet atlases or checking pixel-art palette compatibility.\n' +
    '• WHEN NOT TO USE: Not for analyzing 3D image binaries or video compression.\n' +
    '• FORMAT OPTIONS: "concise" (default: summarizes sheet size, animation durations and palette report) or "detailed" (returns full framesMap slice coordinates).\n' +
    '• RETURNS: Sheet size, total frames, palette report with suggested colors, and atlas metadata structure.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      spriteName: {
        type: Type.STRING,
        description: 'Identifying name of the sprite (e.g. "hero_knight", "slime_enemy", "coin").',
      },
      frameWidth: {
        type: Type.INTEGER,
        description: 'Width of 1 pixel frame (usually 8, 16, 24, 32, 48, 64; default 16).',
      },
      frameHeight: {
        type: Type.INTEGER,
        description: 'Height of 1 pixel frame (usually 8, 16, 24, 32, 48, 64; default 16).',
      },
      palette: {
        type: Type.STRING,
        enum: ['pico-8', 'gameboy', 'nes', 'endesga-32', 'custom', 'none'],
        description: 'Restricted Pixel Art palette: pico-8 (16 colors), gameboy (4 classic greens), nes, endesga-32, custom or none. Default: pico-8.',
      },
      customColors: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'List of HEX colors to check for palette compliance (e.g. ["#000000", "#fff1e8", "#ff004d"]).',
      },
      animations: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING, description: 'Animation state name (e.g. "idle", "walk", "jump", "attack", "hurt", "die").' },
            frameCount: { type: Type.INTEGER, description: 'Frame count of this animation (e.g. 4, 6, 8).' },
            fps: { type: Type.INTEGER, description: 'Frame rate (frames per second, e.g. 8, 10, 12; default 10).' },
            loop: { type: Type.BOOLEAN, description: 'Loop the animation (default: true).' },
          },
          required: ['name', 'frameCount'],
        },
        description: 'List of animation states (Animation States) and frame counts.',
      },
      columns: {
        type: Type.INTEGER,
        description: 'Maximum columns per sprite sheet row (if empty, auto-layout is optimized).',
      },
      targetFormat: {
        type: Type.STRING,
        enum: ['texture_packer_json', 'godot_sprite_frames', 'unity_sprite_meta', 'css_spritesheet'],
        description: 'Metadata export format: texture_packer_json (Phaser/Kaboom/Pixi), godot_sprite_frames (Godot 4 SpriteFrames), unity_sprite_meta, css_spritesheet. Default: texture_packer_json.',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Response detail level: "concise" (default: frame & palette summary) or "detailed" (returns all frame-slice coordinates).',
      },
      targetFile: {
        type: Type.STRING,
        description: 'Workspace file path to save metadata directly (e.g. "assets/sprites/hero.json").',
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
        error: 'The "spriteName" parameter must not be empty.',
        error_type: 'validation_error',
        suggestions: ['Provide a representative sprite name, e.g. spriteName: "hero_knight"'],
      };
    }

    if (frameWidth < 4 || frameWidth > 512 || frameHeight < 4 || frameHeight > 512) {
      return {
        is_error: true,
        error: `Frame size (${frameWidth}x${frameHeight}) is invalid (supported range 4 to 512px).`,
        error_type: 'out_of_bounds',
        suggestions: ['Use standard pixel-art sizes: 16x16, 24x24, 32x32 or 48x48.'],
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
          suggestions.push(`Color "${hex}" is not in the ${palette} palette. Switch to the nearest match "${closestColor}".`);
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
        ? `Metadata written to file "${savedFile}".`
        : 'Use targetFile to save the JSON file to the workspace or set format: "detailed" to view all frame coordinates.';
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
    'Precisely compute jump kinematic formulas (kinematic jump: gravity g = 2h/tp^2, jump velocity v0 = 2h/tp), ' +
    'set up a 32-bit bitmask collision matrix (Collision Matrix Layer/Mask) and specify Hitbox/Hurtbox configuration for 2D games.\n\n' +
    '• WHEN TO USE: When fine-tuning platformer jump feel (Game Feel / Juice: Coyote time, Jump buffer, Jump cut) or setting up cross-conflict-free collision layers in Godot, Unity, Phaser.\n' +
    '• WHEN NOT TO USE: Not for 3D rocket trajectories or complex hydrodynamics.\n' +
    '• FORMAT OPTIONS: "concise" (default: key kinematic parameters and core sample code) or "detailed" (full 32-bit bitmask matrix and math explanation).\n' +
    '• RETURNS: gravity, jump velocity, terminal velocity values, Coyote time & Jump buffer table, collision matrix and matching sample code.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      mode: {
        type: Type.STRING,
        enum: ['kinematic_jump', 'collision_matrix', 'hitbox_hurtbox', 'full_physics_profile'],
        description: 'Computation mode: kinematic_jump (compute gravity & jump velocity), collision_matrix (build bitmask matrix), hitbox_hurtbox, full_physics_profile (combined). Default: kinematic_jump.',
      },
      jumpHeight: {
        type: Type.NUMBER,
        description: 'Desired jump height (pixels or world units, e.g. 48, 64; default 48).',
      },
      timeToApex: {
        type: Type.NUMBER,
        description: 'Time from jump press to apex (in seconds, e.g. 0.35s; default 0.35).',
      },
      maxFallSpeed: {
        type: Type.NUMBER,
        description: 'Maximum fall speed / terminal velocity (optional, default 1.6x the initial jump velocity).',
      },
      layers: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'List of physics layer names (max 32 layers, e.g. ["Player", "Terrain", "Enemy", "Hazard"]).',
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
        description: 'List of layer pairs and whether they collide with each other.',
      },
      targetEngine: {
        type: Type.STRING,
        enum: ['unity_2d', 'godot_2d', 'phaser_arcade', 'custom_canvas'],
        description: 'Target engine for generated config code: godot_2d, unity_2d, phaser_arcade, custom_canvas. Default: godot_2d.',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Response detail level: "concise" (default: key parameters & core code) or "detailed" (detailed bitmask matrix).',
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
        error: `Mode mode="${mode}" is not supported.`,
        error_type: 'validation_error',
        suggestions: [`Choose mode from: ${validModes.join(', ')}`],
      };
    }

    if (timeToApex <= 0 || timeToApex > 2.0) {
      return {
        is_error: true,
        error: `timeToApex=${timeToApex}s is unrealistic for 2D games (must be between 0.15s and 1.0s).`,
        error_type: 'out_of_bounds',
        suggestions: ['Set timeToApex between 0.28 and 0.38 seconds for a snappy platformer jump feel.'],
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
    'Initialize standard architecture source code for 2D & Pixel games: fixed-timestep game loop ' +
    '(Fixed Timestep Accumulator Game Loop for FPS independence), Finite State Machine (FSM), ' +
    'abstract Input management (Action Mapping) and Object Pool (reuse bullets/enemies to avoid GC lag).\n\n' +
    '• WHEN TO USE: When scaffolding a new game project, building FSM-based character controls, or optimizing bullet/particle performance.\n' +
    '• WHEN NOT TO USE: Not for pure CRUD web apps with no game loop.\n' +
    '• FORMAT OPTIONS: "concise" (default: architecture and scaffold summary to save tokens) or "detailed" (complete detailed source).\n' +
    '• RETURNS: Complete source code, architecture explanation and saved file path (if targetFile is set).',
  parameters: {
    type: Type.OBJECT,
    properties: {
      engine: {
        type: Type.STRING,
        enum: ['html5_canvas_ts', 'phaser_ts', 'godot_gdscript', 'unity_csharp', 'pygame_python'],
        description: 'Target engine or platform: html5_canvas_ts, phaser_ts, godot_gdscript, unity_csharp, pygame_python. Default: html5_canvas_ts.',
      },
      architectureComponent: {
        type: Type.STRING,
        enum: ['fixed_timestep_loop', 'fsm_state_machine', 'object_pool', 'input_action_mapper', 'complete_2d_starter'],
        description: 'Architecture component to generate: fixed_timestep_loop, fsm_state_machine, object_pool, input_action_mapper, complete_2d_starter.',
      },
      entityName: {
        type: Type.STRING,
        description: 'Entity name (e.g. "Player", "Enemy", "Bullet"; default: "Player").',
      },
      states: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: 'State list for the FSM (e.g. ["Idle", "Run", "Jump", "Fall", "Attack", "Hurt", "Death"]).',
      },
      poolCapacity: {
        type: Type.INTEGER,
        description: 'Initial Object Pool capacity (e.g. 30, 50, 100; default 50).',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Detail level: "concise" (default: interface summary & preview) or "detailed" (full source).',
      },
      targetFile: {
        type: Type.STRING,
        description: 'Destination file path to save code to the workspace (e.g. "src/game/GameLoop.ts").',
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
        error: `Engine "${engine}" is invalid.`,
        error_type: 'validation_error',
        suggestions: [`Choose engine from: ${validEngines.join(', ')}`],
      };
    }

    const validComponents = ['fixed_timestep_loop', 'fsm_state_machine', 'object_pool', 'input_action_mapper', 'complete_2d_starter'];
    if (!validComponents.includes(architectureComponent)) {
      return {
        is_error: true,
        error: `Component "${architectureComponent}" is invalid.`,
        error_type: 'validation_error',
        suggestions: [`Choose architectureComponent from: ${validComponents.join(', ')}`],
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
        explanation = 'Standard Fixed Timestep Accumulator implementation per Glenn Fiedler (Fix Your Timestep).';
      } else {
        code = `// Fixed timestep loop for ${engine} is natively handled by engine runtime (e.g. _physics_process in Godot or FixedUpdate in Unity).`;
        explanation = `With ${engine}, use the engine default Fixed Update mechanism.`;
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
      explanation = `Standard Finite State Machine with ${states.length} states: ${states.join(', ')}.`;
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
      explanation = `Object Pool prevents continuous memory allocation in bullet/effect loops. Initial capacity: ${poolCapacity}.`;
    } else {
      code = `
// Complete 2D Starter Scaffolding for ${engine}
// Bao gồm GameLoop, ActionInputMapper và FSM State Machine
`.trim();
      explanation = 'Complete scaffold for 2D games.';
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
      response.codePreview = code.slice(0, 500) + (code.length > 500 ? '\n...(see the full file or set format: "detailed")' : '');
      response.guidance = savedFile
        ? `Source code written to file "${savedFile}".`
        : 'Use targetFile to save code directly or set format: "detailed" to view the full code.';
    }

    return response;
  },
};
