import { AgentPlugin, KernelContext } from '../kernel.js';
import { GamePlugin } from './game-plugin.js';

/**
 * UnityPlugin - Công cụ chuyên biệt Unity Engine
 */
export const UnityPlugin: AgentPlugin = {
  name: 'unity-plugin',
  version: '1.0.0',
  description: 'Specialized Unity Engine toolkit: Scene Composition, Prefab, Build Settings',
  apply(_ctx: KernelContext) {
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
  description: 'Loads the full 2D Game + Unity Engine toolchain in one call',
  apply(ctx: KernelContext) {
    GamePlugin.apply(ctx);
    UnityPlugin.apply(ctx);
  },
};
