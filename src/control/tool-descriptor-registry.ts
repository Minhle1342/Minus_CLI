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

export const READ_TOOL_NAMES = new Set([
  'read_file',
  'list_files',
  'search_text',
  'search_codebase_fast',
  'inspect_symbol',
  'find_references',
  'get_diagnostics',
  'lsp_query',
  'analyze_impact',
  'query_call_graph',
  'get_route_map',
  'get_symbol_context_360',
  'get_architecture_topology',
  'codegraph_explore',
  'codegraph_node',
  'codegraph_search',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_status',
]);

export const EDIT_TOOL_NAMES = new Set([
  'replace_text',
  'write_file',
  'create_file',
  'delete_file',
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
]);

export const TOOL_SETS = { READ: READ_TOOL_NAMES, EDIT: EDIT_TOOL_NAMES };
const READ = READ_TOOL_NAMES;
const EDIT = EDIT_TOOL_NAMES;

export class ToolDescriptorRegistry {
  private readonly overrides = new Map<string, Partial<ToolDescriptor>>();

  register(name: string, descriptor: Partial<ToolDescriptor>): void {
    this.overrides.set(name, { ...(this.overrides.get(name) || {}), ...descriptor });
  }

  describe(tool: ToolDefinition): ToolDescriptor {
    const name = tool.name;
    let descriptor: ToolDescriptor;

    if (READ.has(name)) {
      descriptor = {
        name,
        capabilities: ['inspect', 'search'],
        phases: ALL_PHASES,
        minimumRisk: 'R0',
        mutates: false,
        reversible: true,
        requiresApproval: false,
        deferLoading: false,
        schemaCost: this.cost(tool),
      };
    } else if (EDIT.has(name)) {
      descriptor = {
        name,
        capabilities: ['edit', 'inspect'],
        phases: ['implement', 'verify', 'release'],
        minimumRisk: 'R1',
        mutates: true,
        reversible: true,
        requiresApproval: true,
        deferLoading: false,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'run_command') {
      descriptor = {
        name,
        capabilities: ['inspect', 'search', 'execute', 'verify', 'git-read', 'git-write'],
        phases: ALL_PHASES,
        minimumRisk: 'R0',
        mutates: false,
        reversible: false,
        requiresApproval: true,
        deferLoading: false,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'submit_solution') {
      descriptor = {
        name,
        capabilities: ['complete', 'inspect'],
        phases: ALL_PHASES,
        minimumRisk: 'R0',
        mutates: false,
        reversible: true,
        requiresApproval: false,
        deferLoading: false,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'request_phase_transition') {
      descriptor = {
        name,
        capabilities: ['plan', 'inspect'],
        phases: ['explore', 'plan'],
        minimumRisk: 'R0',
        mutates: false,
        reversible: true,
        requiresApproval: false,
        deferLoading: false,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'formulate_and_verify_hypothesis') {
      descriptor = {
        name,
        capabilities: ['inspect', 'verify', 'plan'],
        phases: ['explore', 'plan', 'implement', 'verify'],
        minimumRisk: 'R0',
        mutates: false,
        reversible: true,
        requiresApproval: false,
        deferLoading: false,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'computer') {
      descriptor = {
        name,
        capabilities: ['execute', 'inspect'],
        phases: ['explore', 'implement', 'verify', 'release'],
        minimumRisk: 'R1',
        mutates: true,
        reversible: false,
        requiresApproval: true,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'manage_task') {
      descriptor = {
        name,
        capabilities: ['execute', 'inspect'],
        phases: ALL_PHASES,
        minimumRisk: 'R1',
        mutates: true,
        reversible: false,
        requiresApproval: false,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'brainstorm_design') {
      descriptor = {
        name,
        capabilities: ['plan', 'inspect', 'delegate'],
        phases: ['explore', 'plan'],
        minimumRisk: 'R0',
        mutates: false,
        reversible: true,
        requiresApproval: false,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'verify_subagent_quality') {
      descriptor = {
        name,
        capabilities: ['verify', 'delegate', 'inspect'],
        phases: ['implement', 'verify', 'release'],
        minimumRisk: 'R0',
        mutates: false,
        reversible: true,
        requiresApproval: false,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'schedule_dag_parallel' || name === 'allocate_agent_task') {
      descriptor = {
        name,
        capabilities: ['delegate', 'plan', 'execute'],
        phases: ['plan', 'implement', 'verify'],
        minimumRisk: 'R1',
        mutates: true,
        reversible: false,
        requiresApproval: false,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'spawn_agent' || name === 'wait_agent' || name === 'get_agent_result' || name === 'stop_agent' || name === 'resume_agent') {
      const isReadOnly = name === 'wait_agent' || name === 'get_agent_result';
      descriptor = {
        name,
        capabilities: isReadOnly ? ['delegate', 'inspect', 'execute'] : ['delegate', 'execute'],
        phases: ALL_PHASES,
        minimumRisk: isReadOnly ? 'R0' : 'R1',
        mutates: !isReadOnly,
        reversible: isReadOnly,
        requiresApproval: false,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    } else if (name === 'ask_user') {
      descriptor = {
        name,
        capabilities: ['plan', 'inspect'],
        phases: ALL_PHASES,
        minimumRisk: 'R0',
        mutates: false,
        reversible: true,
        requiresApproval: false,
        deferLoading: false,
        schemaCost: this.cost(tool),
      };
    } else if (/web|url/.test(name)) {
      descriptor = {
        name,
        capabilities: ['network', 'inspect', 'search'],
        phases: ALL_PHASES,
        minimumRisk: 'R1',
        mutates: false,
        reversible: true,
        requiresApproval: false,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    } else if (/agent/.test(name)) {
      descriptor = {
        name,
        capabilities: ['delegate', 'execute'],
        phases: ALL_PHASES,
        minimumRisk: 'R1',
        mutates: true,
        reversible: false,
        requiresApproval: false,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    } else if (name.startsWith('browser_')) {
      const mutates = !['browser_snapshot', 'browser_take_screenshot', 'browser_screenshot', 'browser_console_messages', 'browser_network_requests', 'browser_tabs', 'browser_navigate', 'browser_wait_for', 'browser_wait'].includes(name);
      descriptor = {
        name,
        capabilities: ['inspect', 'execute', 'network'],
        phases: ALL_PHASES,
        minimumRisk: 'R0',
        mutates,
        reversible: true,
        requiresApproval: true,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    } else {
      descriptor = {
        name,
        capabilities: ['execute', 'inspect'],
        phases: ALL_PHASES,
        minimumRisk: 'R1',
        mutates: true,
        reversible: false,
        requiresApproval: true,
        deferLoading: true,
        schemaCost: this.cost(tool),
      };
    }

    return { ...descriptor, ...this.overrides.get(name), name };
  }

  private cost(tool: ToolDefinition): number {
    const description = tool.description || '';
    const params = JSON.stringify(tool.parameters || {}) || '';
    return Math.max(1, Math.ceil((tool.name.length + description.length + params.length) / 4));
  }
}
