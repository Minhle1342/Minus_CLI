import { AdaptiveComputeController } from '../control-plane/reasoning/adaptive-compute-controller.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SkillRegistry } from '../skills/skill-registry.js';
import { SkillActivator } from '../skills/skill-activator.js';
import { SuperpowersSource } from '../skills/superpowers-source.js';
import { Session } from '../session/session.js';
import { ToolSynergyAdvisor } from './tool-synergy-advisor.js';
import { DynamicContextArbiter } from './dynamic-context-arbiter.js';
import { AdaptiveReasoningController } from './adaptive-reasoning-controller.js';
import { resolvePhaseDynamicGuidance, CORE_SYSTEM_PROMPT } from '../llm/prompt-sections.js';
import { SuperpowersPlugin } from '../kernel/plugins/superpowers-plugin.js';
import { PromptAssembler } from '../llm/prompt-assembler.js';
import { StepPromptPolicy } from './step-prompt-policy.js';
import { FinalAnswerGuard } from './final-answer-guard.js';
import { ContextGuardian } from '../context/context-guardian.js';

test('inspection Git intent never activates finishing or worktree skills', () => {
  const registry = new SkillRegistry();
  SuperpowersSource.registerSuperpowers(registry);
  const result = new SkillActivator(registry).evaluate({ session: new Session(), userRequest: 'Review git diff' });
  assert.ok(!result.activeSkills.some(s => ['finishing-a-development-branch', 'using-git-worktrees'].includes(s.id)));
});

test('implicit planning selects one planning owner', () => {
  const registry = new SkillRegistry();
  SuperpowersSource.registerSuperpowers(registry);
  const result = new SkillActivator(registry).evaluate({ session: new Session(), userRequest: 'Create a plan for this feature' });
  assert.deepEqual(result.activeSkills.filter(s => ['brainstorming', 'writing-plans', 'planning-with-files', 'concise-planning'].includes(s.id)).map(s => s.id), ['writing-plans']);
});

test('a disabled skill cannot be reactivated as a dependency', () => {
  const registry = new SkillRegistry();
  registry.register({ id: 'child', name: 'child', description: 'child', version: '1', source: 'builtin', path: '', requires: ['parent'], autoActivate: true });
  registry.register({ id: 'parent', name: 'parent', description: 'parent', version: '1', source: 'builtin', path: '' });
  const result = new SkillActivator(registry).evaluate({ session: new Session(), manualOverrides: { disabled: ['parent'] } });
  assert.equal(result.activeSkills.length, 0);
});

test('advisor never declares incomplete, blocked or unrelated commands verified', () => {
  const advisor = new ToolSynergyAdvisor();
  for (const result of [
    { command: 'npm test', status: 'running' },
    { command: 'echo test', exitCode: 0 },
    { command: 'npm test', exitCode: 0, success: false },
    { command: 'npm test', exitCode: 0, processStarted: false },
  ]) assert.doesNotMatch(advisor.advise({ lastToolName: 'run_command', lastToolResult: result }).guidance, /passed successfully|empirical proof of correctness/);
});

test('risk adjusted verification does not demand tests for R1', () => {
  const guidance = resolvePhaseDynamicGuidance('verify', { risk: 'R1' });
  assert.doesNotMatch(guidance, /passing test exit code|Targeted test suite/);
  assert.match(guidance, /diagnostics/);
  assert.doesNotMatch(CORE_SYSTEM_PROMPT, /pushing to main -> L1 & L2 override/);
});

test('reasoning escalation guidance does not claim a provider token grant', () => {
  const controller = new AdaptiveReasoningController();
  controller.escalate('submission missing');
  assert.doesNotMatch(controller.getGuidancePrompt(), /16384 tokens|32768 tokens/);
});

test('active plan survives excessive advisory text', () => {
  const result = new DynamicContextArbiter(200).arbitrate({
    rawPlanContext: '[ACTIVE PLAN] Only modify src/a.ts; acceptance: preserves exports.',
    advicePrompt: Array.from({length: 200}, (_, i) => `Advisory ${i}: inspect everything thoroughly.`).join('\n'),
    cognitiveScaffold: 'Additional guidance\n'.repeat(100),
  });
  assert.match(result.renderedContext, /Only modify src\/a.ts/);
});

test('exact tool authority is never truncated and soft overflow is explicit', () => {
  const authority = '[AUTHORIZED TOOLS]\n' + Array.from({length: 80}, (_, i) => `tool_${i}`).join(', ');
  const result = new DynamicContextArbiter(20).arbitrate({ phaseToolAuthority: authority, advicePrompt: 'Duplicate guidance\n'.repeat(100) });
  assert.ok(result.renderedContext.includes(authority));
  assert.equal(result.budgetExceeded, true);
});

test('submission-only reasoning recovery avoids debugging mandates', () => {
  const controller = new AdaptiveReasoningController();
  controller.escalate('submission missing');
  assert.doesNotMatch(controller.getGuidancePrompt({submissionOnly: true}), /inspect error logs|deep System|16384/);
  assert.match(controller.getGuidancePrompt({submissionOnly: true}), /existing evidence/);
});

test('plugin replaces skills between a planning and an unrelated read-only turn', async () => {
  const plugin = new SuperpowersPlugin();
  const assembler = new PromptAssembler();
  let hook: any;
  const ctx = {
    workspace: {rootDir: process.cwd()},
    tools: {register() {}}, events: {on() {}, off() {}},
    agentHooks: {register(_name: string, hooks: any) { hook = hooks['agent/turn-start']; }},
    systemPrompt: assembler,
  };
  await plugin.apply(ctx as any);
  const session = new Session();
  session.addUserMessage('Create a plan for this feature');
  await hook({session});
  assert.ok(assembler.list().some(id => id.includes('writing-plans')));
  session.addUserMessage('What is the package name?');
  await hook({session});
  assert.ok(!assembler.list().some(id => id.includes('writing-plans')));
  assert.ok(!session.getActiveSkillDecisions().some(d => d.skillId === 'writing-plans'));
});

test('dependency cycles and conflicts fail atomically', () => {
  const registry = new SkillRegistry();
  const base = {version:'1',source:'builtin' as const,path:'',description:'scope'};
  registry.register({...base,id:'a',name:'a',requires:['b'],autoActivate:true});
  registry.register({...base,id:'b',name:'b',requires:['a']});
  assert.equal(new SkillActivator(registry).evaluate({session:new Session()}).activeSkills.length, 0);
});

test('shadow does not inject selected Git prompts and sufficient evidence suppresses hypothesis advisory', () => {
  const context: any = {
    activeStepQuery:'commit changes',userRequest:'commit changes',fingerprint:'x',
    classification:{taskClass:'bugfix',phase:'implement',risk:'R1',requiredCapabilities:['edit'],reversibility:'reversible',confidence:0.95},
    hasPlan:false,planRequired:false,planIncomplete:false,planBlocked:false,readyTaskCount:0,
    visibleToolNames:['run_command'],consecutiveFailures:0,hasValidatedHypothesis:false,
    paretoEvidenceSufficient:true,evidenceScore:1,evidenceThreshold:3,
    hasSubmittedSolution:false,hasVerifiedTests:false,activeAgentCount:0,harnessProfileName:'strict-verification',
    candidates:{legacyPlanContext:'legacy',stepPlanContext:'plan',advicePrompt:'advice',harnessGuidance:'harness',scaffoldPrompt:'scaffold'},
  };
  const result = new StepPromptPolicy().decide(context, 'shadow');
  assert.equal(result.gitPlaybookPrompt, '');
  assert.doesNotMatch(result.strongAdvisoryPrompt, /UNVERIFIED_MUTATION_ADVISORY/);
});

test('dependencies obey capabilities and symmetric conflicts without partial activation', () => {
  const base = {version:'1',source:'builtin' as const,path:'',description:'scope'};
  const registry = new SkillRegistry();
  registry.register({...base,id:'owner',name:'owner',requires:['missing-cap'],autoActivate:true});
  registry.register({...base,id:'missing-cap',name:'missing-cap',requiredCapabilities:['filesystem.edit']});
  assert.equal(new SkillActivator(registry).evaluate({session:new Session(),availableCapabilities:['filesystem.read']}).activeSkills.length, 0);
  const conflicting = new SkillRegistry();
  conflicting.register({...base,id:'first',name:'first',priority:1,conflicts:['second'],autoActivate:true});
  conflicting.register({...base,id:'second',name:'second',priority:2,autoActivate:true});
  assert.deepEqual(new SkillActivator(conflicting).evaluate({session:new Session()}).activeSkills.map(s=>s.id), ['first']);
});

test('recovery briefing stays historical and does not fabricate verification or permissions', () => {
  const guardian = new ContextGuardian();
  const data = guardian.extractCriticalContext(new Session());
  const briefing = guardian.generateTransitionBriefing(data);
  assert.doesNotMatch(briefing, /IMMUTABLE|Never Revert|100% REGRESSION PASS|Railway|NO AUTOMATED BROWSER TESTING/);
  assert.match(briefing, /Historical evidence only/);
  assert.match(briefing, /does not authorize/);
});

test('successful verification advice preserves remaining workflow and read-only submission carries no test claim', () => {
  const advisor = new ToolSynergyAdvisor();
  const checked = advisor.advise({lastToolName:'run_command',lastToolResult:{command:'npm test',exitCode:0,success:true}});
  assert.match(checked.guidance, /active task acceptance criteria/);
  assert.doesNotMatch(checked.guidance, /submit_solution.*immediately|empirical proof of correctness/);
  const submitted = advisor.advise({hasSubmittedSolution:true,lastToolResult:{submitted:true,resolutionType:'investigation_only'}});
  assert.doesNotMatch(submitted.guidance, /verified with empirical evidence/);
});


test('guardian requires paired completed outcomes rather than attempts or success prose', () => {
  const session = new Session();
  session.addModelMessage({functionCalls:[{id:'attempt',name:'write_file',args:{path:'attempt.ts'}}]});
  const observe = (id: string, name: string, args: any, result: any) => {
    session.append('tool/call', {toolCallId:id,toolName:name,args});
    session.addToolResultWithId(name,result,id);
  };
  observe('failed','write_file',{path:'failed.ts'},{success:false,error:'denied'});
  observe('good','write_file',{path:'good.ts'},{success:true});
  observe('background','run_command',{command:'npm test'},{success:true,status:'running',exitCode:0});
  observe('blocked','run_command',{command:'npm run build'},{success:true,exitCode:0,processStarted:false});
  observe('dry','run_command',{command:'npm run lint'},{success:true,exitCode:0,dryRun:true});
  observe('async','run_command',{command:'npm run async'},{success:true,exitCode:0,background:true});
  observe('noop','write_file',{path:'noop.ts'},{success:true,noChanges:true});
  observe('passed','run_command',{command:'tsc --noEmit'},{success:true,exitCode:0});
  session.addModelMessage({text:'Fixed: Root Cause was wrong parameters.'});
  const data = new ContextGuardian().extractCriticalContext(session,{workingCommands:['unobserved command']});
  assert.deepEqual(data.p0.codeMutations.map(item=>item.path),['good.ts']);
  assert.deepEqual(data.p0.workingCommands,['tsc --noEmit']);
  assert.deepEqual(data.p0.appliedFixes,[]);
  assert.ok(data.p2.attemptHistory.some(item=>item.includes('Fixed: Root Cause')));
});

test('guardian rejects mismatched and cross-turn observations', () => {
  const session = new Session();
  session.append('tool/call',{toolCallId:'mismatch',toolName:'write_file',args:{path:'wrong.ts'}});
  session.addToolResultWithId('read_file',{success:true},'mismatch');
  session.append('tool/call',{toolCallId:'stale',toolName:'run_command',args:{command:'npm test'}});
  session.append('turn/start',{turn:2});
  session.addToolResultWithId('run_command',{success:true,exitCode:0},'stale');
  const data = new ContextGuardian().extractCriticalContext(session);
  assert.deepEqual(data.p0.codeMutations,[]);
  assert.deepEqual(data.p0.workingCommands,[]);
});

test('plugin dispose removes owned skills while preserving unrelated prompt sections', async () => {
  const plugin = new SuperpowersPlugin();
  const assembler = new PromptAssembler();
  assembler.register({id:'unrelated',content:'Preserve this section',priority:1});
  let hook: any;
  const ctx = {workspace:{rootDir:process.cwd()},tools:{register(){}},events:{on(){},off(){}},
    agentHooks:{register(_name:string,hooks:any){hook=hooks['agent/turn-start'];},unregister(){}},systemPrompt:assembler};
  await plugin.apply(ctx as any);
  const session = new Session();
  session.addUserMessage('Create a plan for this feature');
  await hook({session});
  assert.ok(assembler.list().some(id=>id.includes('writing-plans')));
  plugin.dispose(ctx as any);
  assert.deepEqual(assembler.list(),['unrelated']);
});

test('Git capability recovery uses the available shell without expanding authorization', () => {
  const result = new FinalAnswerGuard().evaluate('I cannot access git tools to commit changes.',
    {userRequest:'Commit these changes',availableToolNames:['run_command']});
  assert.equal(result.reason,'unverified-capability-denial');
  assert.match(result.continuationPrompt || '',/run_command/);
  assert.match(result.continuationPrompt || '',/user-authorized/);
  assert.doesNotMatch(result.continuationPrompt || '',/call the dedicated Git tools/);
});


test('latent adaptive compute reports observed pressure and deduplicates reevaluation', () => {
  const controller = new AdaptiveComputeController();
  assert.equal(controller.getState().pressure.taskRisk,0);
  const pressure = {taskRisk:.8,uncertainty:.2,blastRadius:.1,failureCount:0,stagnationScore:0,hypothesisEntropy:0,verificationFailures:0};
  assert.equal(controller.evaluatePressure(pressure).action,'ESCALATE');
  assert.equal(controller.evaluatePressure({...pressure}).action,'MAINTAIN');
  assert.deepEqual(controller.getState().pressure,pressure);
  assert.equal(controller.evaluatePressure(pressure,{observationId:'new-risk-observation'}).action,'ESCALATE');
  assert.equal(controller.evaluatePressure(pressure,{observationId:'new-risk-observation'}).action,'MAINTAIN');
  const low = {...pressure,taskRisk:0};
  assert.equal(controller.evaluatePressure(low).action,'MAINTAIN');
  assert.equal(controller.evaluatePressure(low,{observationId:'verified-1',verificationSucceeded:true}).action,'DEESCALATE');
  assert.equal(controller.evaluatePressure(low,{observationId:'verified-1',verificationSucceeded:true}).action,'MAINTAIN');
  const observed = controller.getState();observed.pressure.taskRisk=1;
  assert.equal(controller.getState().pressure.taskRisk,0);
  controller.reset();
  assert.equal(controller.getCurrentTier(),1);
  assert.deepEqual(controller.getState().transitions,[]);
  assert.equal(controller.getState().pressure.uncertainty,0);
});
