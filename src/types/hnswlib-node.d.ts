// Ambient declaration for the optional native dependency 'hnswlib-node'.
// The package lives in optionalDependencies and may be absent; runtime code
// loads it via dynamic import() with try/catch and falls back to exact
// vector search. This declaration only unblocks `tsc` when it is missing.
declare module 'hnswlib-node';
