import { CapabilityDescriptor, CapabilityDecision, CapabilityPolicyConfig } from './types.js';

export class CapabilityPolicy {
  private config: CapabilityPolicyConfig;

  constructor(config?: CapabilityPolicyConfig) {
    this.config = config || {};
  }

  updateConfig(config: Partial<CapabilityPolicyConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Đánh giá xem capability có được phép thực thi không
   */
  evaluate(
    descriptor: CapabilityDescriptor | undefined,
    context?: { scope?: string; isReadOnly?: boolean; hasApproval?: boolean }
  ): CapabilityDecision {
    if (!descriptor) {
      return {
        capabilityName: 'unknown',
        allowed: false,
        reason: 'CAPABILITY_UNAVAILABLE: The requested operation is not declared or available in the catalog.',
      };
    }

    const { name, category, sideEffect, requiresApproval, scope } = descriptor;

    // 1. Kiểm tra Deny List theo tên Capability
    if (this.config.denyCapabilities?.includes(name)) {
      return {
        capabilityName: name,
        allowed: false,
        reason: `CAPABILITY_DENIED: Capability '${name}' is explicitly denied by operator policy.`,
      };
    }

    // 2. Kiểm tra Deny List theo Category
    if (this.config.denyCategories?.includes(category)) {
      return {
        capabilityName: name,
        allowed: false,
        reason: `CAPABILITY_CATEGORY_DENIED: Category '${category}' is disabled by policy.`,
      };
    }

    // 3. Kiểm tra Scope
    if (context?.scope && scope && context.scope !== scope) {
      return {
        capabilityName: name,
        allowed: false,
        reason: `CAPABILITY_OUT_OF_SCOPE: Capability '${name}' requires scope '${scope}' but current scope is '${context.scope}'.`,
      };
    }

    // 4. Kiểm tra Read-Only Scope
    if (context?.isReadOnly && sideEffect !== 'none') {
      return {
        capabilityName: name,
        allowed: false,
        reason: `CAPABILITY_READONLY_VIOLATION: Cannot execute mutating capability '${name}' in a read-only tool scope.`,
      };
    }

    // 5. Kiểm tra Approval Required
    const needsApproval =
      requiresApproval ||
      this.config.requireApprovalCapabilities?.includes(name);

    if (needsApproval && !context?.hasApproval) {
      return {
        capabilityName: name,
        allowed: false,
        requiresApproval: true,
        reason: `APPROVAL_REQUIRED: Capability '${name}' requires operator approval before execution.`,
      };
    }

    return {
      capabilityName: name,
      allowed: true,
    };
  }
}
