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
      recoveryHint: 'File Scene không tồn tại trên đĩa hoặc đường dẫn chưa chính xác.',
      suggestedFix: 'Hãy đặt action: "compose_scene" để tự động tạo mới scene tại đường dẫn chỉ định (vd: "Assets/Scenes/Main.unity").',
    };
  }
  if (lower.includes('prefab') && (lower.includes('not found') || lower.includes('missing'))) {
    return {
      failureType: 'PREFAB_NOT_FOUND',
      recoveryHint: 'Asset Prefab được chỉ định chưa được tạo hoặc sai đường dẫn.',
      suggestedFix: 'Dùng action: "assemble_prefab" để khởi tạo prefab asset trước khi gắn vào Scene, hoặc kiểm tra lại đường dẫn trong Assets/Prefabs/.',
    };
  }
  if (lower.includes('component') || lower.includes('type')) {
    return {
      failureType: 'UNKNOWN_COMPONENT_TYPE',
      recoveryHint: 'Tên component có thể bị viết sai chính tả hoặc thiếu namespace.',
      suggestedFix: 'Kiểm tra tên Component chuẩn của Unity (vd: "Rigidbody2D", "BoxCollider2D", "SpriteRenderer") hoặc đảm bảo script C# đã tồn tại trong Assets/Scripts/.',
    };
  }
  if (lower.includes('bridge') || lower.includes('econnrefused') || lower.includes('timeout')) {
    return {
      failureType: 'UNITY_BRIDGE_OFFLINE',
      recoveryHint: 'Unity Editor HTTP Bridge chưa được khởi động hoặc đang ở chế độ background.',
      suggestedFix: 'Tool đã tự động tạo script C# Editor (Assets/Editor/Generated/GameplayAssembler.cs). Bạn có thể mở Unity Editor và chọn Tools > Agent > Assemble Gameplay để áp dụng trực tiếp.',
    };
  }
  return {
    failureType: 'GENERAL_EXECUTION_ERROR',
    recoveryHint: errorMsg,
    suggestedFix: 'Kiểm tra lại cấu trúc tham số đầu vào và đường dẫn tài nguyên.',
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
        resolve({ success: false, error: 'TIMEOUT: Unity Bridge phản hồi quá thời gian quy định.' });
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
    'Sử dụng sức mạnh toàn diện của Unity Editor để tạo/lắp ráp Scene, khởi tạo Prefab, gắn kết tham chiếu Component (SerializedObject/SerializedProperty), ' +
    'cấu hình thứ tự Build Settings và tự động sinh C# Editor script tự động hóa gameplay hoàn chỉnh.\n\n' +
    '• KHI NÀO NÊN DÙNG:\n' +
    '  - Khi phát triển gameplay trong Unity cần kết nối các Scene (.unity) và Prefab (.prefab) lại với nhau.\n' +
    '  - Khi cần gán tham chiếu (wiring references) giữa các GameObjects/Components trong Scene (vd: gán Player vào GameManager, gắn Cinemachine Target, liên kết UI Button OnClick, gán Prefab cho Spawner).\n' +
    '  - Khi cấu hình Build Settings Scene list để chuyển màn (MainMenu -> Level1 -> GameOver).\n' +
    '  - Khi tạo kịch bản tự động hóa Unity Editor để thực thi qua Menu hoặc Unity CLI batchmode.\n\n' +
    '• KHI NÀO KHÔNG DÙNG: Không dùng cho các game engine khác (Godot/Phaser) hoặc tạo tilemap ma trận 2D thuần túy (dùng game_tilemap_studio).\n\n' +
    '• FORMAT LỰA CHỌN: "concise" (mặc định: tóm tắt số lượng prefab, hierarchy tree, các reference đã gắn và đường dẫn file đã lưu để tiết kiệm token) ' +
    'hoặc "detailed" (trả về toàn bộ mã nguồn C# Editor script, chi tiết SerializedProperty và lệnh chạy Unity batchmode).\n\n' +
    '• KẾT QUẢ TRẢ VỀ: Trạng thái thực thi, danh sách các đối tượng và tham chiếu đã thiết lập, đường dẫn file C# Editor script đã ghi, và hướng dẫn chạy trực tiếp trong Unity Editor.',
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
          'Hành động cần thực hiện trên Unity Editor: ' +
          '"compose_scene" (lắp ráp Scene với prefabs & references), ' +
          '"assemble_prefab" (tạo hoặc chỉnh sửa Prefab asset), ' +
          '"wire_references" (gắn kết tham chiếu giữa các Component/GameObject), ' +
          '"manage_build_scenes" (sắp xếp danh sách Scene trong Build Settings), ' +
          '"inspect_and_validate" (kiểm tra tính hợp lệ và tìm các script bị thiếu), ' +
          '"execute_editor_script" (sinh script C# Editor tự động hóa).',
      },
      scenePath: {
        type: Type.STRING,
        description: 'Đường dẫn file Scene mục tiêu trong Unity (vd: "Assets/Scenes/MainLevel.unity"). Tự động thêm đuôi .unity nếu thiếu.',
      },
      prefabPath: {
        type: Type.STRING,
        description: 'Đường dẫn file Prefab mục tiêu (vd: "Assets/Prefabs/Player.prefab"). Tự động thêm đuôi .prefab nếu thiếu.',
      },
      gameplayType: {
        type: Type.STRING,
        enum: ['2d_platformer', '2d_topdown', '3d_action', 'fps', 'rpg', 'custom'],
        description: 'Thể loại gameplay để tự động thiết lập Camera (Orthographic vs Perspective), Lighting và Canvas chuẩn. Mặc định: "custom".',
      },
      prefabsToInstantiate: {
        type: Type.ARRAY,
        description: 'Danh sách các Prefab cần đưa vào Scene, bao gồm tọa độ, scale, đối tượng cha và component bổ sung.',
        items: {
          type: Type.OBJECT,
          properties: {
            prefabPath: { type: Type.STRING, description: 'Đường dẫn asset Prefab (vd: "Assets/Prefabs/Player.prefab").' },
            instanceName: { type: Type.STRING, description: 'Tên GameObject đặt trong Scene Hierarchy (vd: "Player").' },
            parentPath: { type: Type.STRING, description: 'Đường dẫn GameObject cha nếu muốn lồng vào nhóm (vd: "Environment/Platforms").' },
            position: {
              type: Type.OBJECT,
              description: 'Tọa độ đặt trong không gian World (vd: {"x": 0, "y": 1.5, "z": 0}).',
              properties: {
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
                z: { type: Type.NUMBER },
              },
            },
            rotation: {
              type: Type.OBJECT,
              description: 'Góc xoay Euler (vd: {"x": 0, "y": 0, "z": 0}).',
              properties: {
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
                z: { type: Type.NUMBER },
              },
            },
            scale: {
              type: Type.OBJECT,
              description: 'Tỉ lệ phóng to/thu nhỏ (vd: {"x": 1, "y": 1, "z": 1}).',
              properties: {
                x: { type: Type.NUMBER },
                y: { type: Type.NUMBER },
                z: { type: Type.NUMBER },
              },
            },
            componentsToAdd: {
              type: Type.ARRAY,
              description: 'Danh sách tên các Component cần gắn thêm (vd: ["Rigidbody2D", "PlayerController"]).',
              items: { type: Type.STRING },
            },
            propertyOverrides: {
              type: Type.OBJECT,
              description: 'Các giá trị SerializedProperty muốn ghi đè riêng cho instance này.',
            },
          },
        },
      },
      referenceWirings: {
        type: Type.ARRAY,
        description: 'Danh sách các liên kết tham chiếu cần gán giữa các Component/GameObject thông qua SerializedObject.',
        items: {
          type: Type.OBJECT,
          properties: {
            sourceObject: { type: Type.STRING, description: 'Tên GameObject chứa Component có field cần gán (vd: "GameManager").' },
            sourceComponent: { type: Type.STRING, description: 'Tên Component chứa field (vd: "GameManager" hoặc "CinemachineVirtualCamera").' },
            fieldName: { type: Type.STRING, description: 'Tên SerializedField trong C# script (vd: "playerTarget", "healthSlider", "enemyPrefab").' },
            targetObject: { type: Type.STRING, description: 'Tên GameObject mục tiêu trong Scene (vd: "Player").' },
            targetComponent: { type: Type.STRING, description: 'Tùy chọn: Tên component cụ thể trên targetObject (nếu null sẽ gán GameObject/Transform).' },
            targetAssetPath: { type: Type.STRING, description: 'Tùy chọn: Đường dẫn Prefab hoặc ScriptableObject Asset nếu field nhận Asset thay vì Scene object.' },
          },
        },
      },
      prefabDefinition: {
        type: Type.OBJECT,
        description: 'Cấu hình định nghĩa Prefab khi tạo mới với action "assemble_prefab".',
        properties: {
          rootName: { type: Type.STRING, description: 'Tên root GameObject của Prefab.' },
          tag: { type: Type.STRING, description: 'Tag cho root object (vd: "Player", "Enemy").' },
          layer: { type: Type.STRING, description: 'Layer cho root object (vd: "Default", "Character").' },
          components: {
            type: Type.ARRAY,
            description: 'Danh sách component cần gắn trên root GameObject.',
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING, description: 'Tên component (vd: "Rigidbody2D", "BoxCollider2D").' },
              },
            },
          },
          childHierarchy: {
            type: Type.ARRAY,
            description: 'Cây GameObject con của Prefab (vd: MuzzlePoint, GroundCheck, Visual).',
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
        description: 'Danh sách Scene cần đưa vào Unity Build Settings theo thứ tự ưu tiên (Index 0: Splash/MainMenu, Index 1: Level_01, v.v.).',
        items: {
          type: Type.OBJECT,
          properties: {
            path: { type: Type.STRING, description: 'Đường dẫn Scene (vd: "Assets/Scenes/MainMenu.unity").' },
            enabled: { type: Type.BOOLEAN, description: 'Trạng thái kích hoạt trong build (mặc định: true).' },
          },
        },
      },
      customEditorCode: {
        type: Type.STRING,
        description: 'Mã C# UnityEditor tùy biến muốn chèn thêm vào hàm RunAssembly().',
      },
      outputEditorScriptPath: {
        type: Type.STRING,
        description: 'Đường dẫn file C# Editor Script sinh ra (mặc định: "Assets/Editor/Generated/GameplayAssembler.cs").',
      },
      bridgeUrl: {
        type: Type.STRING,
        description: 'URL của Unity Editor HTTP Bridge nếu Unity đang mở và có plugin lắng nghe (vd: "http://127.0.0.1:8080/exec").',
      },
      format: {
        type: Type.STRING,
        enum: ['concise', 'detailed'],
        description: 'Mức độ chi tiết phản hồi: "concise" (tiết kiệm token context) hoặc "detailed" (toàn bộ code và cấu trúc chi tiết). Mặc định: "concise".',
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
        error: 'Thiếu đường dẫn hoặc thông tin định nghĩa Prefab.',
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
          '1. Mở Unity Editor -> Chọn menu "Tools > Agent > Assemble Gameplay" để chạy script.\\n' +
          `2. Hoặc chạy tự động qua terminal: ${batchCliCommand}`,
      };
    }

    return {
      success: true,
      summary,
      scriptPreview: generatedScript.slice(0, 450) + '\\n// ... [Xem đầy đủ trong file đã lưu hoặc chọn format: "detailed"]',
      quickInstruction:
        `Đã lưu C# Editor automation tại "${summary.editorScriptSavedAt}". ` +
        `Trong Unity Editor, nhấn "Tools > Agent > Assemble Gameplay" hoặc chạy batchmode để tự động lắp ráp hoàn tất.`,
    };
  },
};
