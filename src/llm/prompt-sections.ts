/**
 * Prompt section facade.
 *
 * Content lives in ./sections/* (core, tools, phases, domains) so each prompt
 * block can be maintained and tested in isolation. This module keeps the
 * historical import path stable for every consumer.
 */
export * from './sections/shared.js';
export * from './sections/core.js';
export * from './sections/tools.js';
export * from './sections/phases.js';
export * from './sections/domains.js';
