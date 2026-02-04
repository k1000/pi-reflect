/**
 * Interactive Reflection Review Component
 *
 * Surfaces auto-captured reflections via a widget notification above the editor,
 * with a Ctrl+Shift+R shortcut to open a full interactive review panel.
 *
 * Flow:
 * 1. Auto-capture detects a reflection
 * 2. Widget appears: "💡 New reflection: <title>  [Ctrl+Shift+R to review]"
 * 3. User presses Ctrl+Shift+R
 * 4. Full interactive panel opens via ctx.ui.custom()
 * 5. User can Accept, Reject, or Skip each pending reflection
 */

import type { ReflectionEntry } from "./store.ts";

// ─── Review Queue ────────────────────────────────────────────────────

/** In-memory queue of reflections awaiting user review */
export class ReviewQueue {
	private queue: ReflectionEntry[] = [];
	private onChangeCallbacks: Array<() => void> = [];

	add(entry: ReflectionEntry): void {
		// Deduplicate by ID
		if (this.queue.some((e) => e.id === entry.id)) return;
		this.queue.push(entry);
		this.notifyChange();
	}

	next(): ReflectionEntry | undefined {
		return this.queue[0];
	}

	all(): ReflectionEntry[] {
		return [...this.queue];
	}

	remove(id: string): void {
		this.queue = this.queue.filter((e) => e.id !== id);
		this.notifyChange();
	}

	clear(): void {
		this.queue = [];
		this.notifyChange();
	}

	get length(): number {
		return this.queue.length;
	}

	onChange(callback: () => void): void {
		this.onChangeCallbacks.push(callback);
	}

	private notifyChange(): void {
		for (const cb of this.onChangeCallbacks) {
			try {
				cb();
			} catch {
				// Silent
			}
		}
	}
}

// ─── Review Actions ──────────────────────────────────────────────────

export type ReviewAction = "accept" | "accept_and_apply" | "reject" | "skip";

export interface ReviewResult {
	action: ReviewAction;
	entryId: string;
}
