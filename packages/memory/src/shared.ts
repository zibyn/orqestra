// No Node imports: browser code can use this module (as @orqestra/memory/shared)

/** The Memory Tools whose calls change a Memory, and can be undone. */
export const MEMORY_CHANGES = [
	"memory_write",
	"memory_edit",
	"memory_delete",
] as const;
export type MemoryChange = (typeof MEMORY_CHANGES)[number];
