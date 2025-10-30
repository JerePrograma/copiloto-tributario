const BLOCKLIST = [
  /ignore\s+all\s+previous/i,
  /reset\s+the\s+rules/i,
  /you\s+are\s+now/i,
  /system\s*:/i,
  /assistant\s*:/i,
];

export function sanitizeContext(text: string): string {
  const withoutCode = text.replace(/```[\s\S]*?```/g, " ");
  return withoutCode
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !BLOCKLIST.some((pattern) => pattern.test(line)))
    .join("\n");
}
