import type { ToolDefinition } from '../tools/types.js';
import type { Capability, ControlRisk, TaskPhase } from './classification-types.js';

export interface ToolDescriptor {
  name: string;
  capabilities: Capability[];
  phases: TaskPhase[];
  minimumRisk: ControlRisk;
  mutates: boolean;
  reversible: boolean;
  requiresApproval: boolean;
  deferLoading: boolean;
  schemaCost: number;
}

const ALL_PHASES: TaskPhase[] = ['explore', 'plan', 'implement', 'verify', 'release'];
const READ = new Set(['read_file', 'list_files', 'search_text', 'search_codebase_fast', 'inspect_symbol', 'find_references', 'get_diagnostics', 'lsp_query', 'analyze_impact', 'query_call_graph', 'get_route_map', 'get_symbol_context_360', 'get_architecture_topology', 'read_compressed_code', 'pack_codebase', 'inspect_image', 'get_workspace_diff']);
const EDIT = new Set(['apply_patch', 'replace_text', 'write_file', 'create_file', 'delete_file', 'move_file']);

export class ToolDescriptorRegistry {
  private readonly overrides = new Map<string, Partial<ToolDescriptor>>();

  register(name: string, descriptor: Partial<ToolDescriptor>): void {
    this.overrides.set(name, { ...(this.overrides.get(name) || {}), ...descriptor });
  }

  describe(tool: ToolDefinition): ToolDescriptor {
    const name = tool.name;
    let descriptor: ToolDescriptor;
    if (READ.has(name)) {
      descriptor = { name, capabilities: name === 'get_diagnostics' ? ['inspect', 'verify'] : ['inspect', 'search'], phases: ALL_PHASES, minimumRisk: 'R0', mutates: false, reversible: true, requiresApproval: false, deferLoading: false, schemaCost: this.cost(tool) };
    } else if (EDIT.has(name)) {
      descriptor = { name, capabilities: ['edit'], phases: ['implement'], minimumRisk: 'R1', mutates: true, reversible: true, requiresApproval: true, deferLoading: false, schemaCost: this.cost(tool) };
    } else if (name === 'run_command') {
      descriptor = { name, capabilities: ['execute', 'verify'], phases: ['explore', 'implement', 'verify', 'release'], minimumRisk: 'R1', mutates: true, reversible: false, requiresApproval: true, deferLoading: false, schemaCost: this.cost(tool) };
    } else if (name === 'submit_solution') {
      descriptor = { name, capabilities: ['complete'], phases: ['verify', 'release'], minimumRisk: 'R0', mutates: false, reversible: true, requiresApproval: false, deferLoading: false, schemaCost: this.cost(tool) };
    } else if (name === 'discover_tools') {
      descriptor = { name, capabilities: ['inspect', 'search'], phases: ALL_PHASES, minimumRisk: 'R0', mutates: false, reversible: true, requiresApproval: false, deferLoading: false, schemaCost: this.cost(tool) };
    } else if (name === 'manage_task' || name === 'schedule') {
      descriptor = { name, capabilities: ['execute'], phases: ['implement', 'verify'], minimumRisk: 'R1', mutates: true, reversible: name === 'schedule', requiresApproval: true, deferLoading: true, schemaCost: this.cost(tool) };
    } else if (name === 'read_shared_context') {
      descriptor = { name, capabilities: ['inspect', 'delegate'], phases: ALL_PHASES, minimumRisk: 'R0', mutates: false, reversible: true, requiresApproval: false, deferLoading: true, schemaCost: this.cost(tool) };
    } else if (name === 'write_shared_context' || name === 'publish_agent_event') {
      descriptor = { name, capabilities: ['delegate'], phases: ALL_PHASES, minimumRisk: 'R1', mutates: true, reversible: true, requiresApproval: false, deferLoading: true, schemaCost: this.cost(tool) };
    } else if (name.startsWith('git_')) {
      const readOnly = /(?:status|diff|log|show)/.test(name);
      descriptor = { name, capabilities: [readOnly ? 'git-read' : 'git-write'], phases: readOnly ? ALL_PHASES : ['implement', 'release'], minimumRisk: readOnly ? 'R0' : 'R2', mutates: !readOnly, reversible: name !== 'git_push', requiresApproval: !readOnly, deferLoading: true, schemaCost: this.cost(tool) };
    } else if (/web|url/.test(name)) {
      descriptor = { name, capabilities: ['network', 'inspect'], phases: ['explore', 'plan', 'verify'], minimumRisk: 'R1', mutates: false, reversible: true, requiresApproval: false, deferLoading: true, schemaCost: this.cost(tool) };
    } else if (/plan|task/.test(name)) {
      descriptor = { name, capabilities: ['plan'], phases: ALL_PHASES, minimumRisk: 'R0', mutates: false, reversible: true, requiresApproval: false, deferLoading: true, schemaCost: this.cost(tool) };
    } else if (/memory/.test(name)) {
      const savesMemory = name.startsWith('save_');
      descriptor = { name, capabilities: ['memory'], phases: savesMemory ? ['implement', 'verify'] : ALL_PHASES, minimumRisk: savesMemory ? 'R1' : 'R0', mutates: savesMemory, reversible: true, requiresApproval: false, deferLoading: true, schemaCost: this.cost(tool) };
    } else if (/agent|shared_context/.test(name)) {
      descriptor = { name, capabilities: ['delegate'], phases: ALL_PHASES, minimumRisk: 'R1', mutates: true, reversible: false, requiresApproval: false, deferLoading: true, schemaCost: this.cost(tool) };
    } else if (name.startsWith('game_') || name.startsWith('unity_')) {
      const mutates = /write|create|scaffold|compose|assemble|wire|execute/.test(name);
      descriptor = { name, capabilities: mutates ? ['edit', 'execute'] : ['inspect', 'plan'], phases: ['explore', 'plan', 'implement', 'verify'], minimumRisk: mutates ? 'R1' : 'R0', mutates, reversible: true, requiresApproval: false, deferLoading: true, schemaCost: this.cost(tool) };
    } else {
      descriptor = { name, capabilities: ['execute'], phases: ['implement', 'verify'], minimumRisk: 'R2', mutates: true, reversible: false, requiresApproval: true, deferLoading: true, schemaCost: this.cost(tool) };
    }
    return { ...descriptor, ...this.overrides.get(name), name };
  }

  private cost(tool: ToolDefinition): number {
    return Math.max(1, Math.ceil((tool.name.length + tool.description.length + JSON.stringify(tool.parameters || {}).length) / 4));
  }
}
