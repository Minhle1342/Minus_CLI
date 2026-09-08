import { AgentPlugin, KernelContext } from '../kernel.js';
import {
  gameTilemapStudioTool,
  gamePixelSpriteStudioTool,
  game2DPhysicsConfigTool,
  gameScaffoldEngineTool,
} from '../../tools/game-tools.js';

/**
 * GamePlugin - Công cụ chuyên biệt phát triển Game 2D, Pixel Art & Engine Scaffolding
 * 
 * Cung cấp 4 công cụ:
 * - game_tilemap_studio: Tạo/xử lý Tilemap 2D (Cellular Automata, BSP Dungeon, Random Walk)
 * - game_pixel_sprite_studio: Thiết kế Sprite Sheet, Palette Validation, Animation Frames
 * - game_2d_physics_config: Tính toán Jump Kinematics, Collision Matrix 32-bit bitmask
 * - game_scaffold_engine: Sinh code Game Loop, Fixed Timestep, ECS Architecture
 * 
 * Plugin tùy chọn (Optional): Chỉ được nạp khi phát hiện dự án game hoặc người dùng yêu cầu.
 */
export const GamePlugin: AgentPlugin = {
  name: 'game-plugin',
  version: '1.0.0',
  description: 'Bộ công cụ chuyên biệt phát triển Game 2D, Pixel Art, Tilemap và Physics',
  apply(ctx: KernelContext) {
    if (!ctx.tools.get(gameTilemapStudioTool.name)) ctx.registerTool(gameTilemapStudioTool);
    if (!ctx.tools.get(gamePixelSpriteStudioTool.name)) ctx.registerTool(gamePixelSpriteStudioTool);
    if (!ctx.tools.get(game2DPhysicsConfigTool.name)) ctx.registerTool(game2DPhysicsConfigTool);
    if (!ctx.tools.get(gameScaffoldEngineTool.name)) ctx.registerTool(gameScaffoldEngineTool);
  },
};
