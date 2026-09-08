import { AgentPlugin, KernelContext } from '../kernel.js';
import { unityGameplayStudioTool } from '../../tools/unity-tools.js';
import { GamePlugin } from './game-plugin.js';

/**
 * UnityPlugin - Công cụ chuyên biệt Unity Engine
 * 
 * Cung cấp:
 * - unity_gameplay_studio: Scene Composition, Prefab Instantiation, Reference Wiring,
 *   Build Settings Configuration, và sinh Editor Script C# tự động.
 * 
 * Plugin tùy chọn (Optional): Chỉ được nạp khi phát hiện dự án Unity hoặc người dùng yêu cầu.
 */
export const UnityPlugin: AgentPlugin = {
  name: 'unity-plugin',
  version: '1.0.0',
  description: 'Công cụ chuyên biệt Unity Engine: Scene Composition, Prefab, Build Settings',
  apply(ctx: KernelContext) {
    if (!ctx.tools.get(unityGameplayStudioTool.name)) ctx.registerTool(unityGameplayStudioTool);
  },
};

/**
 * GameStudioPlugin - Composite Plugin gộp cả GamePlugin + UnityPlugin
 * 
 * Tiện lợi để nạp toàn bộ hệ sinh thái phát triển Game trong một lần gọi:
 *   await kernel.use(GameStudioPlugin);
 */
export const GameStudioPlugin: AgentPlugin = {
  name: 'game-studio',
  version: '1.0.0',
  description: 'Nạp đồng thời toàn bộ công cụ Game 2D + Unity Engine',
  apply(ctx: KernelContext) {
    GamePlugin.apply(ctx);
    UnityPlugin.apply(ctx);
  },
};
