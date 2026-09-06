export interface GameProgrammingIntentResult {
  isGameProgramming: boolean;
  is2DOrPixel?: boolean;
  detectedEngine?: 'unity' | 'godot' | 'phaser' | 'canvas' | 'general';
  reason?: string;
}

/**
 * Nhận diện phân loại ý định lập trình game (Game Programming Intent Classification)
 * Hỗ trợ song ngữ Tiếng Việt, Tiếng Anh và Slash Commands.
 */
export function detectGameProgrammingIntent(userRequest?: string): GameProgrammingIntentResult {
  if (!userRequest || typeof userRequest !== 'string') {
    return { isGameProgramming: false };
  }

  const lower = userRequest.toLowerCase().trim();

  // 1. Kiểm tra Slash Commands chuyên biệt
  const hasGameDevSlash = lower.includes('/game-development');
  const hasUnitySlash = lower.includes('/unity-ai-game-creator');
  if (hasGameDevSlash || hasUnitySlash) {
    return {
      isGameProgramming: true,
      is2DOrPixel: lower.includes('2d') || lower.includes('pixel'),
      detectedEngine: hasUnitySlash || lower.includes('unity') ? 'unity' : 'general',
      reason: `Slash command invoked (${hasUnitySlash ? '/unity-ai-game-creator' : '/game-development'})`,
    };
  }

  // 2. Bộ lọc phủ định tránh false positives (e.g. game theory, lý thuyết trò chơi, endgame)
  const isPureGameTheory = /\b(game theory|lý thuyết trò chơi)\b/i.test(lower) &&
    !/\b(code|lập trình|viết|tạo|phát triển|unity|godot|phaser|canvas|pixel|2d)\b/i.test(lower);
  if (isPureGameTheory) {
    return { isGameProgramming: false };
  }

  // 3. Từ khóa tiếng Việt chuyên về lập trình/phát triển game
  const vnActionKeywords = [
    'lập trình game', 'làm game', 'viết game', 'tạo game', 'phát triển game',
    'thiết kế game', 'xây dựng game', 'code game', 'dựng game', 'lập trình trò chơi',
    'phát triển trò chơi', 'làm trò chơi'
  ];

  const vnGameDomainKeywords = [
    'game 2d', 'game pixel', 'pixel game', 'game platformer', 'game đi cảnh',
    'game bắn súng 2d', 'game nhập vai 2d', 'game roguelike', 'game giải đố',
    'vòng lặp game', 'màn chơi game', 'cơ chế game'
  ];

  // 4. Từ khóa tiếng Anh chuyên về game development
  const enActionKeywords = [
    'game development', 'game programming', 'make a game', 'create a game',
    'build a game', 'develop a game', 'code a game', 'game creator',
    'game design document', 'gdd'
  ];

  const enGameDomainKeywords = [
    '2d game', 'pixel game', 'pixel art game', 'platformer game',
    'tilemap', 'spritesheet', 'sprite sheet', 'game loop', 'hitbox'
  ];

  // 5. Kiểm tra Engine
  let detectedEngine: 'unity' | 'godot' | 'phaser' | 'canvas' | 'general' = 'general';
  if (lower.includes('unity')) detectedEngine = 'unity';
  else if (lower.includes('godot')) detectedEngine = 'godot';
  else if (lower.includes('phaser')) detectedEngine = 'phaser';
  else if (lower.includes('canvas') || lower.includes('html5')) detectedEngine = 'canvas';

  const hasVnAction = vnActionKeywords.some((kw) => lower.includes(kw));
  const hasVnDomain = vnGameDomainKeywords.some((kw) => lower.includes(kw));
  const hasEnAction = enActionKeywords.some((kw) => lower.includes(kw));
  const hasEnDomain = enGameDomainKeywords.some((kw) => lower.includes(kw));

  // Kiểm tra cụm kết hợp: [động từ lập trình/tạo] + [từ khóa game/trò chơi/engine]
  const hasCodeVerb = /\b(lập trình|code|viết|tạo|phát triển|xây dựng|build|develop|program|implement)\b/i.test(lower);
  const hasGameNoun = /\b(game|trò chơi|unity|godot|phaser|tilemap|spritesheet|hitbox)\b/i.test(lower);
  const hasContextualGameCode = hasCodeVerb && hasGameNoun && (lower.includes('2d') || lower.includes('pixel') || lower.includes('unity') || lower.includes('godot') || lower.includes('phaser'));

  const isGameProgramming = hasVnAction || hasVnDomain || hasEnAction || hasEnDomain || hasContextualGameCode;

  if (isGameProgramming) {
    const is2DOrPixel = lower.includes('2d') || lower.includes('pixel') || lower.includes('tilemap') || lower.includes('sprite');
    return {
      isGameProgramming: true,
      is2DOrPixel,
      detectedEngine,
      reason: hasVnAction || hasVnDomain ? 'Vietnamese game development intent detected' : 'Game development intent detected',
    };
  }

  return { isGameProgramming: false };
}
