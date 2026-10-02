import { Type } from '@google/genai';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { ToolDefinition } from './types.js';
import { Workspace } from '../workspace/workspace.js';

// ============================================================================
// Tool-Use-Guardian: Validation, Normalization & Failure Classification
// ============================================================================

export interface Vector3D {
  x: number;
  y: number;
  z: number;
}

export interface PrefabInstanceConfig {
  prefabPath: string;
  instanceName?: string;
  parentPath?: string;
  position?: Vector3D | [number, number, number];
  rotation?: Vector3D | [number, number, number];
  scale?: Vector3D | [number, number, number];
  componentsToAdd?: string[];
  propertyOverrides?: Record<string, any>;
}

export interface ReferenceWiringConfig {
  sourceObject: string;
  sourceComponent: string;
  fieldName: string;
  targetObject?: string;
  targetComponent?: string;
  targetAssetPath?: string;
}

export interface BuildSceneConfig {
  path: string;
  enabled?: boolean;
}

export interface PrefabDefinitionConfig {
  rootName: string;
  components?: Array<{ name: string; properties?: Record<string, any> }>;
  childHierarchy?: Array<{
    name: string;
    components?: Array<{ name: string; properties?: Record<string, any> }>;
    position?: Vector3D | [number, number, number];
  }>;
  tag?: string;
  layer?: string;
}

/**
 * Chuẩn hóa đường dẫn Asset trong Unity (bắt đầu bằng Assets/ và đúng phần mở rộng)
 */
export function normalizeAssetPath(filePath: string, defaultExt: '.unity' | '.prefab' | '.cs' | '.asset'): string {
  let normalized = filePath.trim().replace(/\\/g, '/');
  if (!normalized.startsWith('Assets/') && !normalized.startsWith('Packages/')) {
    normalized = normalized.startsWith('/') ? `Assets${normalized}` : `Assets/${normalized}`;
  }
  if (!normalized.toLowerCase().endsWith(defaultExt)) {
    normalized += defaultExt;
  }
  return normalized;
}

/**
 * Chuẩn hóa vector 3D từ định dạng mảng hoặc object
 */
export function normalizeVector3(val: any, defaultVal: Vector3D = { x: 0, y: 0, z: 0 }): Vector3D {
  if (!val) return { ...defaultVal };
  if (Array.isArray(val)) {
    return {
      x: Number(val[0]) || 0,
      y: Number(val[1]) || 0,
      z: Number(val[2]) || 0,
    };
  }
  if (typeof val === 'object') {
    return {
      x: Number(val.x) || 0,
      y: Number(val.y) || 0,
      z: Number(val.z) || 0,
    };
  }
  return { ...defaultVal };
}

/**
 * Phân loại lỗi theo nguyên tắc Tool-Use-Guardian để phục hồi tự động
 */
export function classifyGuardianError(errorMsg: string): { failureType: string; recoveryHint: string; suggestedFix: string } {
  const lower = errorMsg.toLowerCase();
  if (lower.includes('scene') && (lower.includes('not found') || lower.includes('missing'))) {
    return {
      failureType: 'SCENE_NOT_FOUND',
      recoveryHint: 'Scene file does not exist on disk or the path is incorrect.',
      suggestedFix: 'Set action: "compose_scene" to auto-create the scene at the specified path (e.g. "Assets/Scenes/Main.unity").',
    };
  }
  if (lower.includes('prefab') && (lower.includes('not found') || lower.includes('missing'))) {
    return {
      failureType: 'PREFAB_NOT_FOUND',
      recoveryHint: 'The specified Prefab asset has not been created or the path is wrong.',
      suggestedFix: 'Use action: "assemble_prefab" to initialize the prefab asset before attaching it to the Scene, or double-check the path under Assets/Prefabs/.',
    };
  }
  if (lower.includes('component') || lower.includes('type')) {
    return {
      failureType: 'UNKNOWN_COMPONENT_TYPE',
      recoveryHint: 'The component name may be misspelled or missing a namespace.',
      suggestedFix: 'Check the standard Unity component names (e.g. "Rigidbody2D", "BoxCollider2D", "SpriteRenderer") or make sure the C# script exists under Assets/Scripts/.',
    };
  }
  if (lower.includes('bridge') || lower.includes('econnrefused') || lower.includes('timeout')) {
    return {
      failureType: 'UNITY_BRIDGE_OFFLINE',
      recoveryHint: 'The Unity Editor HTTP Bridge has not been started or is running in background mode.',
      suggestedFix: 'The tool auto-generated a C# Editor script (Assets/Editor/Generated/GameplayAssembler.cs). Open Unity Editor and choose Tools > Agent > Assemble Gameplay to apply it directly.',
    };
  }
  return {
    failureType: 'GENERAL_EXECUTION_ERROR',
    recoveryHint: errorMsg,
    suggestedFix: 'Double-check the input parameter structure and resource paths.',
  };
}

// ============================================================================
// C# Unity Editor Automation Script Generator
// ============================================================================

export function generateUnityEditorScript(params: {
  action: string;
  scenePath?: string;
  prefabPath?: string;
  gameplayType?: string;
  setupEnvironment?: Record<string, any>;
  prefabsToInstantiate?: PrefabInstanceConfig[];
  referenceWirings?: ReferenceWiringConfig[];
  prefabDefinition?: PrefabDefinitionConfig;
  buildScenes?: BuildSceneConfig[];
  customEditorCode?: string;
}): string {
  const scenePath = params.scenePath ? normalizeAssetPath(params.scenePath, '.unity') : 'Assets/Scenes/GameplayScene.unity';
  const gameplayType = params.gameplayType || 'custom';
  const prefabs = params.prefabsToInstantiate || [];
  const wirings = params.referenceWirings || [];
  const buildScenes = params.buildScenes || [];
  const prefabDef = params.prefabDefinition;
  const is2D = gameplayType.includes('2d') || gameplayType === '2d_platformer' || gameplayType === '2d_topdown';

  return `// <auto-generated>
// Tạo bởi Unity Gameplay Studio (Coding Agent LLM Tool)
// Cung cấp khả năng tự động hóa lắp ráp Scene, Prefab và liên kết Gameplay Reference
// </auto-generated>
#if UNITY_EDITOR
using System;
using System.IO;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.UI;
using UnityEngine.EventSystems;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine.SceneManagement;

namespace AgentAutomation
{
    public static class GameplayAssembler
    {
        private const string TargetScenePath = "${scenePath}";

        [MenuItem("Tools/Agent/Assemble Gameplay", false, 10)]
        public static void RunAssembly()
        {
            Debug.Log("[GameplayAssembler] Bắt đầu quá trình lắp ráp gameplay tự động...");
            try
            {
                AssetDatabase.StartAssetEditing();
                EnsureFolderStructure();

                ${params.action === 'assemble_prefab' && prefabDef ? 'AssemblePrefabDefinition();' : ''}
                ${params.action === 'compose_scene' || params.action === 'wire_references' ? 'ComposeSceneWorkflow();' : ''}
                ${buildScenes.length > 0 ? 'ConfigureBuildSettings();' : ''}
                ${params.customEditorCode ? `// Custom LLM Editor Injected Code\n                ${params.customEditorCode}` : ''}

                AssetDatabase.SaveAssets();
                AssetDatabase.Refresh();
                Debug.Log("<color=green>[GameplayAssembler] Hoàn thành lắp ráp gameplay thành công!</color>");
            }
            catch (Exception ex)
            {
                Debug.LogError($"[GameplayAssembler] Thất bại trong quá trình lắp ráp: {ex.Message}\\n{ex.StackTrace}");
                throw;
            }
            finally
            {
                AssetDatabase.StopAssetEditing();
            }
        }

        private static void EnsureFolderStructure()
        {
            string[] dirs = { "Assets/Scenes", "Assets/Prefabs", "Assets/Scripts", "Assets/Editor/Generated" };
            foreach (var dir in dirs)
            {
                if (!AssetDatabase.IsValidFolder(dir))
                {
                    string parent = Path.GetDirectoryName(dir).Replace("\\\\", "/");
                    string folderName = Path.GetFileName(dir);
                    if (!string.IsNullOrEmpty(parent) && !string.IsNullOrEmpty(folderName))
                    {
                        AssetDatabase.CreateFolder(parent, folderName);
                    }
                }
            }
        }

        private static void ComposeSceneWorkflow()
        {
            Scene scene;
            if (File.Exists(TargetScenePath))
            {
                scene = EditorSceneManager.OpenScene(TargetScenePath, OpenSceneMode.Single);
            }
            else
            {
                scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            }

            SetupEnvironment(scene);

            // 1. Instantiate Prefabs into Scene
            var instantiatedObjects = new Dictionary<string, GameObject>();
            ${prefabs.map((p, idx) => {
              const pPath = normalizeAssetPath(p.prefabPath, '.prefab');
              const instName = p.instanceName || `Instance_${idx}`;
              const pos = normalizeVector3(p.position);
              const rot = normalizeVector3(p.rotation);
              const scl = normalizeVector3(p.scale, { x: 1, y: 1, z: 1 });
              return `
            {
                GameObject prefabAsset = AssetDatabase.LoadAssetAtPath<GameObject>("${pPath}");
                GameObject instance = null;
                if (prefabAsset != null)
                {
                    instance = (GameObject)PrefabUtility.InstantiatePrefab(prefabAsset, scene);
                }
                else
                {
                    Debug.LogWarning("[GameplayAssembler] Không tìm thấy Prefab '${pPath}'. Tạo GameObject rỗng thay thế.");
                    instance = new GameObject("${instName}");
                    SceneManager.MoveGameObjectToScene(instance, scene);
                }
                instance.name = "${instName}";
                instance.transform.position = new Vector3(${pos.x}f, ${pos.y}f, ${pos.z}f);
                instance.transform.eulerAngles = new Vector3(${rot.x}f, ${rot.y}f, ${rot.z}f);
                instance.transform.localScale = new Vector3(${scl.x}f, ${scl.y}f, ${scl.z}f);

                ${p.parentPath ? `
                GameObject parentObj = GameObject.Find("${p.parentPath}");
                if (parentObj != null) instance.transform.SetParent(parentObj.transform, true);
                ` : ''}

                ${(p.componentsToAdd || []).map((comp) => `
                if (instance.GetComponent("${comp}") == null)
                {
                    var compType = FindComponentType("${comp}");
                    if (compType != null) Undo.AddComponent(instance, compType);
                }`).join('\n')}

                instantiatedObjects["${instName}"] = instance;
                Undo.RegisterCreatedObjectUndo(instance, "Instantiate ${instName}");
            }`;
            }).join('\n')}

            // 2. Wire References using SerializedObject (Safe Undo & Permanent Serialization)
            ${wirings.map((wire) => {
              return `
            {
                GameObject srcObj = GameObject.Find("${wire.sourceObject}");
                if (srcObj != null)
                {
                    Component srcComp = srcObj.GetComponent("${wire.sourceComponent}");
                    if (srcComp != null)
                    {
                        SerializedObject so = new SerializedObject(srcComp);
                        SerializedProperty prop = so.FindProperty("${wire.fieldName}");
                        if (prop != null)
                        {
                            ${wire.targetAssetPath ? `
                            UnityEngine.Object targetAsset = AssetDatabase.LoadAssetAtPath<UnityEngine.Object>("${wire.targetAssetPath}");
                            prop.objectReferenceValue = targetAsset;
                            ` : `
                            GameObject targetGo = GameObject.Find("${wire.targetObject}");
                            if (targetGo != null)
                            {
                                ${wire.targetComponent ? `
                                Component targetComp = targetGo.GetComponent("${wire.targetComponent}");
                                prop.objectReferenceValue = targetComp != null ? (UnityEngine.Object)targetComp : targetGo;
                                ` : `
                                prop.objectReferenceValue = targetGo;
                                `}
                            }`}
                            so.ApplyModifiedProperties();
                            EditorUtility.SetDirty(srcComp);
                            Debug.Log("[GameplayAssembler] Đã gắn reference '${wire.fieldName}' trên ${wire.sourceObject} -> ${wire.targetObject || wire.targetAssetPath}");
                        }
                        else
                        {
                            Debug.LogWarning("[GameplayAssembler] Không tìm thấy SerializedProperty '${wire.fieldName}' trên Component '${wire.sourceComponent}'");
                        }
                    }
                }
            }`;
            }).join('\n')}

            EditorSceneManager.MarkSceneDirty(scene);
            EditorSceneManager.SaveScene(scene, TargetScenePath);
            Debug.Log($"[GameplayAssembler] Đã lưu Scene tại '{TargetScenePath}'.");
        }

        private static void SetupEnvironment(Scene scene)
        {
            // Main Camera
            Camera mainCam = Camera.main;
            if (mainCam == null)
            {
                GameObject camGo = new GameObject("Main Camera");
                SceneManager.MoveGameObjectToScene(camGo, scene);
                camGo.tag = "MainCamera";
                mainCam = camGo.AddComponent<Camera>();
                camGo.AddComponent<AudioListener>();
                ${is2D ? `
                mainCam.orthographic = true;
                mainCam.orthographicSize = 5f;
                camGo.transform.position = new Vector3(0, 0, -10f);
                ` : `
                mainCam.orthographic = false;
                camGo.transform.position = new Vector3(0, 2f, -10f);
                `}
            }

            // Directional Light for 3D
            ${!is2D ? `
            if (GameObject.Find("Directional Light") == null)
            {
                GameObject lightGo = new GameObject("Directional Light");
                SceneManager.MoveGameObjectToScene(lightGo, scene);
                Light l = lightGo.AddComponent<Light>();
                l.type = LightType.Directional;
                lightGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
            }
            ` : ''}

            // UI Canvas & EventSystem
            if (GameObject.FindObjectOfType<EventSystem>() == null)
            {
                GameObject esGo = new GameObject("EventSystem");
                SceneManager.MoveGameObjectToScene(esGo, scene);
                esGo.AddComponent<EventSystem>();
                esGo.AddComponent<StandaloneInputModule>();
            }
        }

        ${prefabDef ? `
        private static void AssemblePrefabDefinition()
        {
            string pPath = "${params.prefabPath ? normalizeAssetPath(params.prefabPath, '.prefab') : 'Assets/Prefabs/NewPrefab.prefab'}";
            GameObject root = new GameObject("${prefabDef.rootName}");
            try
            {
                ${(prefabDef.components || []).map((comp) => `
                {
                    Type t = FindComponentType("${comp.name}");
                    if (t != null) root.AddComponent(t);
                }`).join('\n')}

                ${(prefabDef.childHierarchy || []).map((child) => {
                  const pos = normalizeVector3(child.position);
                  return `
                {
                    GameObject childGo = new GameObject("${child.name}");
                    childGo.transform.SetParent(root.transform);
                    childGo.transform.localPosition = new Vector3(${pos.x}f, ${pos.y}f, ${pos.z}f);
                    ${(child.components || []).map((c) => `
                    {
                        Type ct = FindComponentType("${c.name}");
                        if (ct != null) childGo.AddComponent(ct);
                    }`).join('\n')}
                }`;
                }).join('\n')}

                ${prefabDef.tag ? `root.tag = "${prefabDef.tag}";` : ''}

                PrefabUtility.SaveAsPrefabAsset(root, pPath);
                Debug.Log($"[GameplayAssembler] Đã tạo và lưu Prefab Asset tại '{pPath}'.");
            }
            finally
            {
                GameObject.DestroyImmediate(root);
            }
        }
        ` : ''}

        private static void ConfigureBuildSettings()
        {
            var editorScenes = new List<EditorBuildSettingsScene>();
            ${buildScenes.map((bs) => `
            editorScenes.Add(new EditorBuildSettingsScene("${normalizeAssetPath(bs.path, '.unity')}", ${bs.enabled !== false ? 'true' : 'false'}));
            `).join('\n')}
            EditorBuildSettings.scenes = editorScenes.ToArray();
            Debug.Log($"[GameplayAssembler] Đã cập nhật Build Settings ({editorScenes.Count} scenes).");
        }

        private static Type FindComponentType(string typeName)
        {
            if (string.IsNullOrEmpty(typeName)) return null;
            Type direct = Type.GetType(typeName) ?? Type.GetType($"UnityEngine.{typeName}, UnityEngine");
            if (direct != null) return direct;

            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type t = asm.GetType(typeName) ?? asm.GetType($"UnityEngine.{typeName}");
                if (t != null) return t;
            }
            return null;
        }

        // Static entrypoint for headless batchmode CLI execution:
        // Unity.exe -batchmode -quit -projectPath "." -executeMethod AgentAutomation.GameplayAssembler.RunBatch
        public static void RunBatch()
        {
            RunAssembly();
            EditorApplication.Exit(0);
        }
    }
}
#endif
`;
}

/**
 * Gửi lệnh thực thi tới Unity HTTP Bridge nếu có sẵn
 */
async function sendToUnityBridge(bridgeUrl: string, payload: Record<string, any>, timeoutMs = 2500): Promise<{ success: boolean; data?: any; error?: string }> {
  return new Promise((resolve) => {
    try {
      const url = new URL(bridgeUrl);
      const postData = JSON.stringify(payload);

      const req = http.request(
        {
          hostname: url.hostname,
          port: url.port || 8080,
          path: url.pathname || '/exec',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
          },
          timeout: timeoutMs,
        },
        (res) => {
          let responseBody = '';
          res.on('data', (chunk) => (responseBody += chunk));
          res.on('end', () => {
            try {
              const parsed = JSON.parse(responseBody);
              resolve({ success: true, data: parsed });
            } catch {
              resolve({ success: true, data: responseBody });
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve({ success: false, error: 'TIMEOUT: Unity Bridge response exceeded the time limit.' });
      });

      req.on('error', (err) => {
        resolve({ success: false, error: err.message });
      });

      req.write(postData);
      req.end();
    } catch (err: any) {
      resolve({ success: false, error: err?.message || 'Invalid Bridge URL' });
    }
  });
}

// ============================================================================
// Consolidated Tool Definition: unity_gameplay_studio
// ============================================================================

export const unityGameplayStudioTool: ToolDefinition = {
  name: 'unity_gameplay_studio',
  description:
    'Use the full power of the Unity Editor to create/assemble Scenes, initialize Prefabs, wire Component references (SerializedObject/SerializedProperty), ' +
    'configure Build Settings order, and auto-generate complete gameplay-automation C# Editor scripts.\n\n' +
    '• WHEN TO USE:\n' +
    '  - When developing Unity gameplay that connects Scenes (.unity) and Prefabs (.prefab) together.\n' +
    '  - When wiring references between GameObjects/Components in a Scene (e.g. assigning Player to GameManager, attaching a Cinemachine Target, linking UI Button OnClick, assigning a Prefab to a Spawner).\n' +
    '  - When configuring the Build Settings scene list for level transitions (MainMenu -> Level1 -> GameOver).\n' +
    '  - When creating Unity Editor automation scripts to run via Menu or Unity CLI batchmode.\n\n' +
    '• WHEN NOT TO USE: Not for other game engines (Godot/Phaser) or pure 2D matrix tilemaps (use game_tilemap_studio).\n\n' +
    '• FORMAT OPTIONS: "concise" (default: summarizes prefab count, hierarchy tree, wired references and saved file path to save tokens) ' +
    'or "detailed" (returns the full C# Editor script source, SerializedProperty details and the Unity batchmode command).\n\n' +
    '• RETURNS: Execution status, list of configured objects and references, written C# Editor script path, and instructions for running directly in Unity Editor.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      action: {
        type: Type.STRING,
        enum: [
          'compose_scene',
          'assemble_prefab',
          'wire_references',
          'manage_build_scenes',
          'inspect_and_validate',
          'execute_editor_script',
        ],
        description:
          'Action to perform in Unity Editor: ' +
          '"compose_scene" (assemble a Scene with prefabs & references), ' +
          '"assemble_prefab" (create or edit a Prefab asset), ' +
          '"wire_references" (wire references between Components/GameObjects), ' +
          '"manage_build_scenes" (order the Scene list in Build Settings), ' +
          '"inspect_and_validate" (validate and find missing scripts), ' +
          '"execute_editor_script" (generate an automation C# Editor script).',
      },
      scenePath: {
        type: Type.STRING,
        description: 'Target Unity Scene file path (e.g. "Assets/Scenes/MainLevel.unity"). Auto-appends the .unity extension if missing.',
      },
      prefabPath: {
        type: Type.STRING,
        description: 'Target Prefab file path (e.g. "Assets/Prefabs/Player.prefab"). Auto-appends the .prefab extension if missing.',
      },
      gameplayType: {
        type: Type.STRING,
        enum: ['2d_platformer', '2d_topdown', '3d_action', 'fps', 'rpg', 'custom'],
        description: 'Gameplay genre for auto-setting Camera (Orthographic vs Perspective), Lighting and default Canvas. Default: "custom".',
      },
      prefabsToInstantiate: {
        type: Type.ARRAY,
        description: 'List of Prefabs to place into the Scene, including position, scale, parent object and extra components.',
        items: {
          type: Type.OBJECT,
          properties: {
            prefabPath: { type: Type.STRING, description: 'Prefab asset path (e.g. "Assets/Prefabs/Player.prefab").' },
            instanceName: { type: Type.STRING, description: 'GameObject name placed in the Scene Hierarchy (e.g. "Player").' },
            parentPath: { type: Type.STRING, description: 'Parent GameObject path for nesting into a group (e.g. "Environment/Platforms").' },
            position: {
              type: Type.OBJECT,
              description: 'Placement coordinates in World space (e.g. {"x": 0, "y": 1.5, "z": 0}).',
              properties: {
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
                z: { type: Type.NUMBER },
              },
            },
            rotation: {
              type: Type.OBJECT,
              description: 'Euler rotation angles (e.g. {"x": 0, "y": 0, "z": 0}).',
              properties: {
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
                z: { type: Type.NUMBER },
              },
            },
            scale: {
              type: Type.OBJECT,
              description: 'Scale factor (e.g. {"x": 1, "y": 1, "z": 1}).',
              properties: {
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
                z: { type: Type.NUMBER },
              },
            },
            componentsToAdd: {
              type: Type.ARRAY,
              description: 'List of extra Component names to attach (e.g. ["Rigidbody2D", "PlayerController"]).',
              items: { type: Type.STRING },
            },
            propertyOverrides: {
              type: Type.OBJECT,
              description: 'SerializedProperty values to override specifically for this instance.',
            },
          },
        },
      },
      referenceWirings: {
        type: Type.ARRAY,
        description: 'List of reference links to wire between Components/GameObjects via SerializedObject.',
        items: {
          type: Type.OBJECT,
          properties: {
            sourceObject: { type: Type.STRING, description: 'Name of the GameObject holding the Component with the field to wire (e.g. "GameManager").' },
            sourceComponent: { type: Type.STRING, description: 'Name of the Component holding the field (e.g. "GameManager" or "CinemachineVirtualCamera").' },
            fieldName: { type: Type.STRING, description: 'SerializedField name in the C# script (e.g. "playerTarget", "healthSlider", "enemyPrefab").' },
            targetObject: { type: Type.STRING, description: 'Target GameObject name in the Scene (e.g. "Player").' },
            targetComponent: { type: Type.STRING, description: 'Optional: specific component name on the targetObject (null wires the GameObject/Transform).' },
            targetAssetPath: { type: Type.STRING, description: 'Optional: Prefab or ScriptableObject asset path if the field takes an asset instead of a Scene object.' },
          },
        },
      },
      prefabDefinition: {
        type: Type.OBJECT,
        description: 'Prefab definition config when creating new content with action "assemble_prefab".',
        properties: {
          rootName: { type: Type.STRING, description: 'Root GameObject name of the Prefab.' },
          tag: { type: Type.STRING, description: 'Tag cho root object (vd: "Player", "Enemy").' },
          layer: { type: Type.STRING, description: 'Layer cho root object (vd: "Default", "Character").' },
          components: {
            type: Type.ARRAY,
            description: 'List of components to attach on the root GameObject.',
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING, description: 'Component name (e.g. "Rigidbody2D", "BoxCollider2D").' },
              },
            },
          },
          childHierarchy: {
            type: Type.ARRAY,
            description: 'Child GameObject tree of the Prefab (e.g. MuzzlePoint, GroundCheck, Visual).',
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                position: {
                  type: Type.OBJECT,
                  properties: {
                    x: { type: Type.NUMBER },
                    y: { type: Type.NUMBER },
                    z: { type: Type.NUMBER },
                  },
                },
              },
            },
          },
        },
      },
      buildScenes: {
        type: Type.ARRAY,
        description: 'List of Scenes to include in Unity Build Settings in priority order (Index 0: Splash/MainMenu, Index 1: Level_01, etc.).',
        items: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: 'Scene path (e.g. "Assets/Scenes/MainMenu.unity").' },
            enabled: { type: Type.BOOLEAN, description: 'Enabled state in the build (default: true).' },
          },
        },
      },
      customEditorCode: {
        type: Type.STRING,
        description: 'Custom C# UnityEditor code to inject into the RunAssembly() function.',
      },
      outputEditorScriptPath: {
        type: Type.STRING,
        description: 'Generated C# Editor script file path (default: "Assets/Editor/Generated/GameplayAssembler.cs").',
      },
      bridgeUrl: {
        type: Type.STRING,
        description: 'Unity Editor HTTP Bridge URL when Unity is open with a listening plugin (e.g. "http://127.0.0.1:8080/exec").',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Response detail level: "concise" (saves context tokens) or "detailed" (full code and detailed structure). Default: "concise".',
      },
    },
    required: ['action'],
  },

  async execute(args: Record<string, any>, workspace: Workspace): Promise<Record<string, any>> {
    const action = args.action || 'compose_scene';
    const format = args.format || 'concise';
    const scenePath = args.scenePath ? normalizeAssetPath(args.scenePath, '.unity') : 'Assets/Scenes/MainGameplay.unity';
    const prefabPath = args.prefabPath ? normalizeAssetPath(args.prefabPath, '.prefab') : undefined;
    const prefabs = args.prefabsToInstantiate || [];
    const wirings = args.referenceWirings || [];
    const buildScenes = args.buildScenes || [];
    const outputScriptRel = args.outputEditorScriptPath || 'Assets/Editor/Generated/GameplayAssembler.cs';

    // Tool-Use-Guardian: Pre-call validation
    if (action === 'assemble_prefab' && !prefabPath && !args.prefabDefinition?.rootName) {
      const err = classifyGuardianError('Missing prefabPath or prefabDefinition for action assemble_prefab');
      return {
        success: false,
        error: 'Missing path or Prefab definition info.',
        guardianDiagnosis: err,
      };
    }

    // 1. Tạo mã C# Editor Script hoàn chỉnh
    const generatedScript = generateUnityEditorScript({
      action,
      scenePath,
      prefabPath,
      gameplayType: args.gameplayType,
      setupEnvironment: args.setupEnvironment,
      prefabsToInstantiate: prefabs,
      referenceWirings: wirings,
      prefabDefinition: args.prefabDefinition,
      buildScenes,
      customEditorCode: args.customEditorCode,
    });

    // 2. Lưu file C# Editor script vào workspace của project
    const resolvedScriptPath = path.isAbsolute(outputScriptRel)
      ? outputScriptRel
      : path.join(workspace.rootDir, outputScriptRel);
    const scriptDir = path.dirname(resolvedScriptPath);
    if (!fs.existsSync(scriptDir)) {
      fs.mkdirSync(scriptDir, { recursive: true });
    }
    fs.writeFileSync(resolvedScriptPath, generatedScript, 'utf8');

    // 3. Nếu người dùng chỉ định bridgeUrl, thử gửi lệnh trực tiếp tới Unity HTTP Bridge
    let bridgeResult: { attempted: boolean; success?: boolean; details?: any } = { attempted: false };
    if (args.bridgeUrl) {
      bridgeResult.attempted = true;
      const res = await sendToUnityBridge(args.bridgeUrl, {
        action,
        scenePath,
        prefabPath,
        prefabs,
        wirings,
        buildScenes,
      });
      bridgeResult.success = res.success;
      bridgeResult.details = res.data || res.error;
    }

    // 4. Sinh lệnh chạy Unity batchmode CLI
    const batchCliCommand = `"Unity.exe" -batchmode -quit -projectPath "." -executeMethod AgentAutomation.GameplayAssembler.RunBatch`;

    // 5. Chuẩn bị kết quả theo format (concise vs detailed) theo /tool-design
    const summary = {
      action,
      targetScene: scenePath,
      targetPrefab: prefabPath,
      prefabsInstantiatedCount: prefabs.length,
      referenceWiringsCount: wirings.length,
      buildScenesCount: buildScenes.length,
      editorScriptSavedAt: path.relative(workspace.rootDir, resolvedScriptPath).replace(/\\/g, '/'),
      bridgeResult,
    };

    if (format === 'detailed') {
      return {
        success: true,
        summary,
        fullEditorScript: generatedScript,
        batchmodeCliCommand: batchCliCommand,
        instructions:
          '1. Open Unity Editor -> choose menu "Tools > Agent > Assemble Gameplay" to run the script.\\n' +
          `2. Or run automatically via terminal: ${batchCliCommand}`,
      };
    }

    return {
      success: true,
      summary,
      scriptPreview: generatedScript.slice(0, 450) + '\\n// ... [See the full saved file or choose format: "detailed"]',
      quickInstruction:
        `Saved C# Editor automation at "${summary.editorScriptSavedAt}". ` +
        `In Unity Editor, press "Tools > Agent > Assemble Gameplay" or run batchmode to auto-complete the assembly.`,
    };
  },
};
