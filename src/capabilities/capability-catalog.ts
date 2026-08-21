import { CapabilityDescriptor, CapabilityCategory } from './types.js';

export class CapabilityCatalog {
  private capabilities: Map<string, CapabilityDescriptor> = new Map();

  /**
   * Đăng ký một Capability Descriptor vào Catalog
   */
  register(descriptor: CapabilityDescriptor): boolean {
    if (!descriptor.name || typeof descriptor.name !== 'string') {
      return false;
    }
    if (!descriptor.category || !descriptor.description) {
      return false;
    }
    if (this.capabilities.has(descriptor.name)) {
      return false;
    }
    this.capabilities.set(descriptor.name, { ...descriptor });
    return true;
  }

  /**
   * Hủy đăng ký một Capability
   */
  unregister(name: string): boolean {
    return this.capabilities.delete(name);
  }

  /**
   * Lấy Descriptor theo tên
   */
  get(name: string): CapabilityDescriptor | undefined {
    const desc = this.capabilities.get(name);
    return desc ? { ...desc } : undefined;
  }

  /**
   * Kiểm tra xem capability có tồn tại hay không
   */
  hasCapability(name: string): boolean {
    return this.capabilities.has(name);
  }

  /**
   * Liệt kê tất cả các Capabilities
   */
  list(): CapabilityDescriptor[] {
    return Array.from(this.capabilities.values()).map((d) => ({ ...d }));
  }

  /**
   * Tìm Capability tương ứng với tool name
   */
  findForTool(toolName: string): CapabilityDescriptor | undefined {
    for (const desc of this.capabilities.values()) {
      if (desc.toolName === toolName) {
        return { ...desc };
      }
    }
    return undefined;
  }

  /**
   * Lọc theo Category
   */
  getByCategory(category: CapabilityCategory): CapabilityDescriptor[] {
    return this.list().filter((d) => d.category === category);
  }

  clear(): void {
    this.capabilities.clear();
  }
}
