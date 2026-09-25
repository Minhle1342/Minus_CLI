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

  /**
   * Lấy danh sách các categories duy nhất hiện có trong Catalog
   */
  getCategories(): CapabilityCategory[] {
    const categories = new Set<CapabilityCategory>();
    for (const desc of this.capabilities.values()) {
      categories.add(desc.category);
    }
    return Array.from(categories);
  }

  /**
   * Lấy danh sách toàn bộ tên các Capability
   */
  getCapabilityNames(): string[] {
    return Array.from(this.capabilities.keys());
  }

  /**
   * Cung cấp chuỗi usage hướng dẫn tham số phía sau của slash command /capabilities
   */
  getSlashUsage(): string {
    const categories = this.getCategories();
    const catPreview = categories.length > 0 ? categories.slice(0, 3).join('|') + '|...' : 'category';
    return `/capabilities [${catPreview}|name|inspect]`;
  }

  /**
   * Lấy toàn bộ các giá trị/tham số khả dụng phía sau slash command (/capabilities <value>)
   */
  getAvailableValues(): {
    categories: CapabilityCategory[];
    capabilities: string[];
    tools: string[];
    subCommands: string[];
  } {
    const categories = this.getCategories();
    const capabilities = this.getCapabilityNames();
    const tools = Array.from(
      new Set(
        Array.from(this.capabilities.values())
          .map((c) => c.toolName)
          .filter((t): t is string => Boolean(t))
      )
    );
    const subCommands = ['inspect', 'categories', 'tools'];
    return {
      categories,
      capabilities,
      tools,
      subCommands,
    };
  }

  /**
   * Gợi ý các giá trị tham số phía sau /capabilities khi người dùng gõ
   */
  getSuggestions(query = ''): string[] {
    const normalized = query.trim().toLowerCase();
    const { categories, capabilities, subCommands } = this.getAvailableValues();
    const allValues = [...subCommands, ...categories, ...capabilities];
    if (!normalized) {
      return allValues;
    }
    return allValues.filter((val) => val.toLowerCase().includes(normalized));
  }

  /**
   * Tìm kiếm capabilities theo từ khoá (name, category, toolName, description)
   */
  search(query: string): CapabilityDescriptor[] {
    if (!query) return this.list();
    const lower = query.trim().toLowerCase();
    return this.list().filter(
      (c) =>
        c.name.toLowerCase().includes(lower) ||
        c.category.toLowerCase().includes(lower) ||
        (c.toolName && c.toolName.toLowerCase().includes(lower)) ||
        c.description.toLowerCase().includes(lower)
    );
  }

  /**
   * Tra cứu chi tiết một capability hoặc danh sách capabilities thuộc category
   */
  inspect(nameOrCategory: string): { type: 'capability'; data: CapabilityDescriptor } | { type: 'category'; data: CapabilityDescriptor[] } | undefined {
    const cap = this.get(nameOrCategory);
    if (cap) {
      return { type: 'capability', data: cap };
    }
    const catList = this.getByCategory(nameOrCategory as CapabilityCategory);
    if (catList.length > 0) {
      return { type: 'category', data: catList };
    }
    return undefined;
  }

  clear(): void {
    this.capabilities.clear();
  }
}