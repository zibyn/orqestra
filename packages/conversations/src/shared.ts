// what a client bundle may import: nothing here reaches the database

/** The Memory Tools whose calls change a Memory, and can be undone. */
export const MEMORY_CHANGES = [
	"memory_write",
	"memory_edit",
	"memory_delete",
] as const;
export type MemoryChange = (typeof MEMORY_CHANGES)[number];
