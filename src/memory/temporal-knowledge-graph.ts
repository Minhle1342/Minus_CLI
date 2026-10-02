import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { writeFileAtomically } from './atomic-write.js';

export type EntityType =
  | 'component'
  | 'technology'
  | 'rule'
  | 'decision'
  | 'bug_pattern'
  | 'file'
  | 'convention';

export type RelationType =
  | 'DEPENDS_ON'
  | 'REPLACED_BY'
  | 'DEPRECATES'
  | 'CONFLICTS_WITH'
  | 'RESOLVES'
  | 'ENFORCES'
  | 'USED_IN'
  | string;

export interface KnowledgeEntity {
  id: string;
  name: string;
  type: EntityType;
  summary: string;
  metadata?: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

export interface BiTemporalRelation {
  id: string;
  sourceEntityId: string;
  targetEntityId: string;
  relation: RelationType;
  /** Thời điểm thực tế quy tắc/quan hệ này bắt đầu có hiệu lực */
  validFrom: string;
  /** Thời điểm thực tế quy tắc/quan hệ này hết hiệu lực (nếu đã bị thay thế) */
  validTo?: string;
  /** Thời điểm hệ thống ghi nhận quan hệ vào cơ sở dữ liệu */
  transactionFrom: string;
  /** Thời điểm hệ thống ghi nhận quan hệ này bị đóng/thu hồi */
  transactionTo?: string;
  confidence: number;
  metadata?: Record<string, any>;
}

export interface BiTemporalSnapshot {
  entities: KnowledgeEntity[];
  relations: BiTemporalRelation[];
  asOf: string;
}

export interface TemporalGraphData {
  version: 1;
  entities: KnowledgeEntity[];
  relations: BiTemporalRelation[];
  lastSavedAt: string;
}

/**
 * BiTemporalKnowledgeGraph (Graphiti / Mem0 Architecture)
 * 
 * Đồ thị tri thức hỗ trợ 2 trục thời gian (Bi-Temporal Model):
 * 1. Valid Time: Thời gian tri thức thực sự đúng trong thế giới thực của repository.
 * 2. Transaction Time: Thời gian hệ thống quan sát và ghi nhận tri thức.
 * 
 * Giải quyết dứt điểm Memory Bloat & Knowledge Drift:
 * - Khi kiến trúc thay đổi (ví dụ đổi framework, đổi schema DB), tri thức cũ không bị xóa mất lịch sử
 *   mà được đóng thời gian hiệu lực (`validTo` và `transactionTo`).
 * - Hỗ trợ Time-Travel Query: Tái hiện lại bức tranh kiến trúc tại bất kỳ thời điểm nào trong quá khứ.
 * - Tự động phát hiện xung đột quy tắc (Conflict Detection).
 */
export class TemporalKnowledgeGraph {
  private filePath: string;
  private entities = new Map<string, KnowledgeEntity>();
  private relations = new Map<string, BiTemporalRelation>();
  private isLoaded = false;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  async init(): Promise<void> {
    if (this.isLoaded) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const raw = await fs.readFile(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as TemporalGraphData;
      if (data.version === 1) {
        this.entities.clear();
        for (const e of data.entities || []) {
          if (e && e.id) this.entities.set(e.id, e);
        }
        this.relations.clear();
        for (const r of data.relations || []) {
          if (r && r.id) this.relations.set(r.id, r);
        }
      }
    } catch {
      // File chưa tồn tại -> Khởi tạo đồ thị trống
      this.entities.clear();
      this.relations.clear();
    }
    this.isLoaded = true;
  }

  /**
   * Thêm hoặc cập nhật một thực thể trong đồ thị tri thức
   */
  upsertEntity(input: Omit<KnowledgeEntity, 'createdAt' | 'updatedAt'>): KnowledgeEntity {
    const now = new Date().toISOString();
    const existing = this.entities.get(input.id);
    const entity: KnowledgeEntity = {
      ...input,
      metadata: { ...(existing?.metadata || {}), ...(input.metadata || {}) },
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.entities.set(entity.id, entity);
    return entity;
  }

  /**
   * Tạo quan hệ hai trục thời gian giữa 2 thực thể
   */
  addRelation(
    sourceEntityId: string,
    targetEntityId: string,
    relation: RelationType,
    options?: {
      validFrom?: string;
      confidence?: number;
      metadata?: Record<string, any>;
    },
  ): BiTemporalRelation {
    const now = new Date().toISOString();
    const validFrom = options?.validFrom || now;
    const id = createHash('sha256')
      .update(`${sourceEntityId}:${relation}:${targetEntityId}:${validFrom}`)
      .digest('hex')
      .slice(0, 16);

    const record: BiTemporalRelation = {
      id,
      sourceEntityId,
      targetEntityId,
      relation,
      validFrom,
      transactionFrom: now,
      confidence: options?.confidence ?? 1.0,
      metadata: options?.metadata,
    };

    this.relations.set(id, record);
    return record;
  }

  /**
   * Đóng hiệu lực của một quan hệ (Invalidation / Superseding)
   */
  invalidateRelation(relationId: string, reason?: string, validTo?: string): boolean {
    const rel = this.relations.get(relationId);
    if (!rel || rel.validTo) return false;

    const now = new Date().toISOString();
    rel.validTo = validTo || now;
    rel.transactionTo = now;
    if (reason) {
      rel.metadata = { ...(rel.metadata || {}), invalidationReason: reason };
    }
    this.relations.set(relationId, rel);
    return true;
  }

  /**
   * Thay thế một quyết định kiến trúc cũ bằng quyết định mới (Atomic Supersession)
   */
  supersedeDecision(
    oldDecisionId: string,
    newDecisionInput: Omit<KnowledgeEntity, 'createdAt' | 'updatedAt'>,
    reason: string,
  ): { newEntity: KnowledgeEntity; relation: BiTemporalRelation } {
    const now = new Date().toISOString();
    const newEntity = this.upsertEntity(newDecisionInput);

    // Đóng toàn bộ các quan hệ xuất phát từ quyết định cũ
    for (const [rId, rel] of this.relations) {
      if ((rel.sourceEntityId === oldDecisionId || rel.targetEntityId === oldDecisionId) && !rel.validTo) {
        this.invalidateRelation(rId, `Superseded by ${newEntity.id}: ${reason}`, now);
      }
    }

    // Thiết lập cạnh REPLACED_BY từ quyết định cũ sang quyết định mới
    const relation = this.addRelation(oldDecisionId, newEntity.id, 'REPLACED_BY', {
      validFrom: now,
      confidence: 1.0,
      metadata: { reason },
    });

    return { newEntity, relation };
  }

  /**
   * Truy vấn ảnh chụp tri thức đang có hiệu lực tại thời điểm T (Point-In-Time / Time-Travel Snapshot)
   * @param asOfValidTime Thời điểm thế giới thực muốn quan sát (mặc định: now)
   * @param asOfTransactionTime Thời điểm hệ thống ghi nhận trong cơ sở dữ liệu (mặc định: now)
   */
  queryActiveAt(asOfValidTime?: string, asOfTransactionTime?: string): BiTemporalSnapshot {
    const validTargetTime = asOfValidTime ? new Date(asOfValidTime).getTime() : Date.now();
    const txTargetTime = asOfTransactionTime ? new Date(asOfTransactionTime).getTime() : Date.now();
    const asOfIso = new Date(validTargetTime).toISOString();

    const activeRelations: BiTemporalRelation[] = [];
    const activeEntityIds = new Set<string>();

    for (const rel of this.relations.values()) {
      const vFrom = Date.parse(rel.validFrom);
      const vTo = rel.validTo ? Date.parse(rel.validTo) : Infinity;
      const tFrom = Date.parse(rel.transactionFrom);
      const tTo = rel.transactionTo ? Date.parse(rel.transactionTo) : Infinity;

      // Điều kiện Bi-Temporal chuẩn:
      // 1. Valid Time: Sự thật diễn ra tại validTargetTime
      // 2. Transaction Time: Đã được ghi nhận vào hệ thống tại txTargetTime
      const isValid = validTargetTime >= vFrom && validTargetTime < vTo;
      const isRecorded = txTargetTime >= tFrom && txTargetTime < tTo;

      if (isValid && (asOfTransactionTime ? isRecorded : true)) {
        activeRelations.push(rel);
        activeEntityIds.add(rel.sourceEntityId);
        activeEntityIds.add(rel.targetEntityId);
      }
    }

    const activeEntities = Array.from(this.entities.values()).filter(
      (e) => activeEntityIds.has(e.id) || Date.parse(e.createdAt) <= validTargetTime,
    );

    return {
      entities: activeEntities,
      relations: activeRelations,
      asOf: asOfIso,
    };
  }

  /**
   * Lấy các láng giềng liên kết của một thực thể tại thời điểm xác định
   */
  getEntityNeighbors(
    entityId: string,
    options?: {
      atTime?: string;
      direction?: 'outgoing' | 'incoming' | 'both';
    },
  ): Array<{ entity: KnowledgeEntity; relation: BiTemporalRelation; direction: 'outgoing' | 'incoming' }> {
    const direction = options?.direction ?? 'both';
    const snapshot = this.queryActiveAt(options?.atTime);
    const results: Array<{ entity: KnowledgeEntity; relation: BiTemporalRelation; direction: 'outgoing' | 'incoming' }> = [];

    for (const rel of snapshot.relations) {
      if ((direction === 'outgoing' || direction === 'both') && rel.sourceEntityId === entityId) {
        const target = this.entities.get(rel.targetEntityId);
        if (target) {
          results.push({ entity: target, relation: rel, direction: 'outgoing' });
        }
      }
      if ((direction === 'incoming' || direction === 'both') && rel.targetEntityId === entityId) {
        const source = this.entities.get(rel.sourceEntityId);
        if (source) {
          results.push({ entity: source, relation: rel, direction: 'incoming' });
        }
      }
    }

    return results;
  }

  /**
   * Phát hiện xung đột quy tắc hoặc ràng buộc kiến trúc
   */
  detectConflicts(entityId: string, atTime?: string): Array<{ relationA: BiTemporalRelation; relationB: BiTemporalRelation; reason: string }> {
    const snapshot = this.queryActiveAt(atTime);
    const conflicts: Array<{ relationA: BiTemporalRelation; relationB: BiTemporalRelation; reason: string }> = [];

    const activeForEntity = snapshot.relations.filter(
      (r) => r.sourceEntityId === entityId || r.targetEntityId === entityId,
    );

    for (let i = 0; i < activeForEntity.length; i++) {
      for (let j = i + 1; j < activeForEntity.length; j++) {
        const relA = activeForEntity[i];
        const relB = activeForEntity[j];

        // 1. Kiểm tra cạnh CONFLICTS_WITH trực tiếp
        if (
          (relA.relation === 'CONFLICTS_WITH' && (relA.targetEntityId === relB.targetEntityId || relA.targetEntityId === relB.sourceEntityId)) ||
          (relB.relation === 'CONFLICTS_WITH' && (relB.targetEntityId === relA.targetEntityId || relB.targetEntityId === relA.sourceEntityId))
        ) {
          conflicts.push({
            relationA: relA,
            relationB: relB,
            reason: `Direct contradiction between ${relA.relation} and ${relB.relation}`,
          });
        }

        // 2. Một thực thể vừa DEPENDS_ON vừa DEPRECATES cùng một mục tiêu
        if (
          relA.sourceEntityId === relB.sourceEntityId &&
          relA.targetEntityId === relB.targetEntityId &&
          ((relA.relation === 'DEPENDS_ON' && relB.relation === 'DEPRECATES') ||
           (relA.relation === 'DEPRECATES' && relB.relation === 'DEPENDS_ON'))
        ) {
          conflicts.push({
            relationA: relA,
            relationB: relB,
            reason: `Entity simultaneously depends on and deprecates target ${relA.targetEntityId}`,
          });
        }
      }
    }

    return conflicts;
  }

  getEntity(id: string): KnowledgeEntity | undefined {
    return this.entities.get(id);
  }

  getAllEntities(): KnowledgeEntity[] {
    return Array.from(this.entities.values());
  }

  getAllRelations(): BiTemporalRelation[] {
    return Array.from(this.relations.values());
  }

  async save(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const payload: TemporalGraphData = {
        version: 1,
        entities: Array.from(this.entities.values()),
        relations: Array.from(this.relations.values()),
        lastSavedAt: new Date().toISOString(),
      };
      await writeFileAtomically(this.filePath, JSON.stringify(payload, null, 2));
    } catch (err: any) {
      console.warn(`[TemporalKnowledgeGraph] Failed to save graph: ${err.message}`);
    }
  }
}
