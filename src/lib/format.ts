/** "812 B", "48.3 kB", "171 kB", "1.25 MB". Decimal units, matching what browsers and Lighthouse show. */
export function formatBytes(bytes: number): string {
  const size = Math.abs(bytes);
  if (size < 1000) return `${Math.round(bytes)} B`;
  if (size < 1e6) {
    const kB = bytes / 1000;
    return Math.abs(kB) < 100 ? `${kB.toFixed(1)} kB` : `${Math.round(kB)} kB`;
  }
  return `${(bytes / 1e6).toFixed(2)} MB`;
}

/** "120 ms", "2.1 s". */
export function formatMs(ms: number): string {
  return Math.abs(Math.round(ms)) < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** A markdown table. Pipes inside cells are escaped so a selector or file name can't break the layout. */
export function table(headers: string[], rows: string[][]): string {
  const escape = (cell: string) => cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const line = (cells: string[]) => `| ${cells.map(escape).join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

/** The first `max` items, and a "…and N more" line when some were left out. */
export function capped<T>(items: T[], max: number, render: (item: T) => string): string[] {
  const lines = items.slice(0, max).map(render);
  if (items.length > max) lines.push(`…and ${items.length - max} more`);
  return lines;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
