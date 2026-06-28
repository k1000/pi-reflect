#!/usr/bin/env bun
/**
 * @sherpa-purpose Maintain project-local pi-reflect memory: normalize, forget stale low-value rows, and refresh generated discovery files
 * @sherpa-timeout 120000
 * @sherpa-side-effects files
 * @sherpa-safe true
 */

import { ReflectionStore } from "../store.ts";

const cwd = process.env.REFLECT_MAINTAIN_CWD || process.env.REFLECT_CHECK_CWD || process.cwd();
const days = Number(process.env.REFLECT_FORGET_DAYS || 90);
const apply = process.env.REFLECT_FORGET_APPLY !== "false";

const store = new ReflectionStore(cwd);
const normalized = store.normalizeStore();
const forgotten = store.forget(days, apply);
store.refreshDiscoveryFile();
const report = store.doctor();

console.log(JSON.stringify({ cwd, days, apply, normalized, forgotten, report }, null, 2));

if (report.duplicateIds.length > 0) throw new Error(`Duplicate reflection IDs: ${report.duplicateIds.join(", ")}`);
if (report.missingBody > 0) throw new Error(`Reflection rows missing body+summary: ${report.missingBody}`);
if (report.highValueNotQueued > 0) throw new Error(`High-value reflections not queued to Archivist: ${report.highValueNotQueued}`);
