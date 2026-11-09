/**
 * A ustar archive of regular files, for orrery's archive upload. Paths up to 255 bytes, split into
 * the prefix and name fields at a slash; Skill files are capped well below anything that needs more.
 */
export function tar(
	files: { path: string; content: Uint8Array }[],
): Uint8Array<ArrayBuffer> {
	const blocks: Uint8Array[] = [];
	for (const { path, content } of files) {
		const header = Buffer.alloc(512);
		const bytes = Buffer.from(path);
		let name = bytes;
		let prefix = Buffer.alloc(0);
		if (bytes.length > 100) {
			// the first slash that leaves the name at most 100 bytes
			let cut = bytes.indexOf(0x2f);
			while (cut !== -1 && bytes.length - cut - 1 > 100)
				cut = bytes.indexOf(0x2f, cut + 1);
			if (cut < 1 || cut > 155) throw new Error(`Path too long: ${path}`);
			prefix = bytes.subarray(0, cut);
			name = bytes.subarray(cut + 1);
		}
		name.copy(header, 0);
		const octal = (n: number, width: number) =>
			n.toString(8).padStart(width - 1, "0");
		header.write(octal(0o644, 8), 100);
		header.write(octal(0, 8), 108);
		header.write(octal(0, 8), 116);
		header.write(octal(content.length, 12), 124);
		header.write(octal(Math.floor(Date.now() / 1000), 12), 136);
		header.write("        ", 148); // the checksum counts its own field as spaces
		header.write("0", 156);
		header.write("ustar\u000000", 257, "latin1");
		prefix.copy(header, 345);
		const sum = header.reduce((a, b) => a + b, 0);
		header.write(`${octal(sum, 7)}\0`, 148);
		blocks.push(
			header,
			content,
			Buffer.alloc((512 - (content.length % 512)) % 512),
		);
	}
	blocks.push(Buffer.alloc(1024));
	return new Uint8Array(Buffer.concat(blocks));
}
