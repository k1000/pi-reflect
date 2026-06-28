export type DistillInput = {
	trigger: string;
	task: string;
	outcome: string;
	context?: string;
	domain?: string;
	targetPath?: string;
};

/**
 * Reflect deliberately does not write Obsidian memory artifacts directly.
 * Durable memory distillation is represented as DistillInput and queued for
 * Archivist/Inquirer via archivist-outbox.jsonl.
 */
