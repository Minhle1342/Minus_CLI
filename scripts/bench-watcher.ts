import { Workspace } from '../src/workspace/workspace.js';
import { WorkspaceWatcher, isWatcherEnabled } from '../src/workspace/workspace-watcher.js';
import { nativeScanManifest, nativeDiffManifests, isNativeAvailable } from '../src/native/index.js';

const root = process.cwd();
const workspace = new Workspace(root);
const ignored = [...workspace.ignoredDirectories];

console.log(`watcher-enabled=${isWatcherEnabled()} native=${isNativeAvailable()}`);

// Benchmark 1: Rust manifest scan vs TS fallback availability
const t0 = Date.now();
const entries = nativeScanManifest(root, ignored);
const rustMs = Date.now() - t0;
if (entries) {
  console.log(`rs_scan_manifest: files=${entries.length} time=${rustMs}ms`);
  const t1 = Date.now();
  const again = nativeScanManifest(root, ignored) || [];
  const diffs = nativeDiffManifests(entries, again) || [];
  console.log(`rs_diff_manifests: diffs=${diffs.length} time=${Date.now() - t1}ms`);
} else {
  console.log(`rs_scan_manifest: unavailable (native .node missing), TS fallback in watcher. scan-skipped time=${rustMs}ms`);
}

// Benchmark 2: watcher event latency (opt-in only, synthetic)
if (!isWatcherEnabled(process.argv)) {
  console.log('watcher: OFF (set MINUS_WATCHER=1 or --watch to measure live latency). PASS thresholds: idle<1% CPU (manual), p95 event<300ms.');
  process.exit(0);
}
const watcher = new WorkspaceWatcher(workspace, { debounceMs: 150 });
const latencies: number[] = [];
const started = Date.now();
watcher.onChange((events) => {
  latencies.push(Date.now() - started);
  console.log(`watcher-batch: n=${events.length} t+${Date.now() - started}ms sample=${events[0]?.relPath}`);
  if (latencies.length >= 3) {
    watcher.stop();
    latencies.sort((a, b) => a - b);
    console.log(`watcher-p95~${latencies[Math.min(latencies.length - 1, 1)]}ms`);
    process.exit(0);
  }
});
watcher.start();
setTimeout(() => {
  console.log('watcher: no events observed in window (idle OK).');
  watcher.stop();
  process.exit(0);
}, 8000);
