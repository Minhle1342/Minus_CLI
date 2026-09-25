/**
 * Game Development & Unity AI Game Creator Playbooks for AI Coding Agents
 * Synthesized from /game-development and /unity-ai-game-creator skill specifications.
 */

export const GAME_DEVELOPMENT_PLAYBOOK = `### GAME DEVELOPMENT & 2D ARCHITECTURE PROTOCOL (GAME-DEVELOPMENT)
1. **The Game Loop Principle (Fixed Timestep Accumulator):**
   - Pattern: \`INPUT -> UPDATE (fixed timestep) -> RENDER (interpolated)\`.
   - Physics & logic must run at a fixed rate (e.g. 50Hz / 60Hz dt = 1/60s). Never tie gameplay speed directly to variable render framerate.
   - Interpolate rendering states between previous and current physics ticks to guarantee silky smooth visuals without jitter.
   - Guard against the "spiral of death" by bounding the maximum accumulated delta time (e.g. max 0.25s per frame).

2. **Pattern Selection Matrix for 2D & Pixel Games:**
   - **Finite State Machine (FSM):** Use for 3-7 discrete states (Player: Idle -> Walk -> Jump -> Fall -> Dash -> Hurt -> Die).
   - **Object Pooling:** Mandatory for high-frequency spawning/destroying (bullets, particle effects, floating damage numbers). Eliminate garbage collection (GC) spikes in hot loops.
   - **Observer / Event Bus:** Decouple cross-system notifications (e.g. HealthChanged -> HUD updates, BossDefeated -> Audio & Achievements).
   - **Entity Component System (ECS):** Use only when managing thousands of similar entities (bullet hell, horde survival). Start with component composition, scale to ECS if needed.
   - **Command Pattern:** Decouple player input from character actions to enable key remapping, undo, and replay recording.

3. **Input Abstraction Layer:**
   - Abstract raw keyboard/mouse/gamepad signals into semantic actions (\`move_left\`, \`jump\`, \`attack\`, \`interact\`).
   - Never query \`isKeyPressed('Space')\` directly inside movement logic; query \`input.isActionPressed('jump')\`.

4. **Performance Budget (60 FPS = 16.67ms per frame):**
   - Input processing: <= 1.0ms
   - Physics & Collision: <= 3.0ms
   - AI & Pathfinding: <= 2.0ms
   - Gameplay Logic: <= 4.0ms
   - Rendering & Draw calls: <= 5.0ms
   - Safety Buffer: 1.67ms
   - Optimization Rule: 1. Algorithm complexity -> 2. Draw call batching / Texture Atlas -> 3. Object pooling -> 4. Viewport culling.

5. **2D Collision & Physics Invariants:**
   - Use Axis-Aligned Bounding Box (AABB) or Circle colliders for high-speed checks.
   - Use Spatial Hashing or Quadtree grid partitioning for large worlds with hundreds of entities.
   - Separate Hitboxes (dealing damage) from Hurtboxes (receiving damage) on distinct collision layers.
   - Kinematic jumping math: Given height $h$ and time to apex $t_p$, compute gravity $g = 2h / (t_p^2)$ and jump velocity $v_0 = 2h / t_p$.`;

export const UNITY_AI_GAME_CREATOR_PLAYBOOK = `### UNITY AI GAME CREATOR & ASSET PIPELINE PROTOCOL (UNITY-AI-GAME-CREATOR)
1. **Master 5-Phase Development Pipeline:**
   - **Phase 1: Ideation & Deep Analysis:** Extract Genre, Platform, Perspective (2D/Pixel/3D), Art Style, Core Loop (30-sec cycle), Target Audience, and Scope calibration.
   - **Phase 2: Blueprint & Game Design Document (GDD):** Executive Summary, Mechanics & Progression, World & Lore, Color Palette (Hex), Audio Direction, Technical Spec (Unity version, URP/Built-in), and Scene Blueprints.
   - **Phase 3: AI-Powered Asset Generation:** Craft targeted AI prompts for 2D Sprites, Pixel Atlases, 3D Models, Chiptune/Synth Music, Retro SFX, and UI Kits.
   - **Phase 4: Assembly & Core Architecture:** Initialize project structure, GameManager, Event System, Input Action Maps, Object Pools, and State Machines.
   - **Phase 5: Quality & Deployment:** Enforce performance budgets (Draw calls < 100 on Mobile, < 500 on PC), memory profiling, and store submission readiness.

2. **Project Structure Invariant:**
   \`\`\`
   Assets/_Project/
   ├── Scripts/ (Core, Gameplay, UI, Data, Audio, Utilities)
   ├── Prefabs/ (Characters, Environment, UI, VFX)
   ├── Scenes/
   ├── Art/ (Sprites, Atlases, Textures, Materials, Animations)
   ├── Audio/ (Music, SFX, Ambience)
   └── ScriptableObjects/ (GameConfig, ItemData, AudioConfig)
   \`\`\`

3. **Core Script Architecture Patterns:**
   - **GameManager:** Singleton or Service Locator with strict state transitions (Boot, MainMenu, Playing, Paused, GameOver).
   - **Data-Driven Architecture:** Use ScriptableObjects for tuning gameplay values without recompilation.
   - **Object Pooling:** Generic \`ObjectPool<T>\` for all dynamic entities (projectiles, enemies, particles).
   - **UI Decoupling:** Event-driven UI updates, never poll game state in \`Update()\`.

4. **Professional 3-Phase Tool Execution Pipeline:**
   - **Phase 1: Prototyping & Asset Synthesis:**
     * Generate visual assets via \`game-asset-mcp\` (\`generate_2d_asset\` for sprites/textures, \`generate_3d_asset\` for OBJ/GLB meshes).
     * Synthesize level grids via \`game_tilemap_studio\` and sprite sheets via \`game_pixel_sprite_studio\`.
     * Package raw assets into Prefabs using \`unity_gameplay_studio(action: 'assemble_prefab')\` with colliders and rigidbodies.
   - **Phase 2: Gameplay Programming & DOTS Integration:**
     * Implement C# behaviors and high-density DOTS systems (\`IComponentData\`, \`ISystem\`, Burst & Job System) for swarm AI / bullet hell.
     * Assemble scenes using \`unity_gameplay_studio(action: 'compose_scene')\`.
     * Wire cross-component references using \`unity_gameplay_studio(action: 'wire_references')\` with \`SerializedObject\`.
     * Configure build transitions via \`unity_gameplay_studio(action: 'manage_build_scenes')\`.
   - **Phase 3: Profiling, QA & Optimization:**
     * Run \`unity_gameplay_studio(action: 'inspect_and_validate')\` to detect broken GUIDs and null SerializedFields.
     * Enforce 60 FPS zero-allocation budget in frame loops (\`Update\` / \`FixedUpdate\`).
     * Verify headless compilation using \`run_command\` with Unity CLI batchmode.`;
