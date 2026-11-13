export function normalize(text: string): string {
  return text
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/\s+/gu, " ")
    .trim();
}
export function terms(text: string): string[] {
  const found = new Set<string>();
  for (const word of normalize(text).match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word];
      for (let i = 0; i < chars.length; i++) {
        found.add(chars[i]!);
        if (i + 1 < chars.length) found.add(chars[i]! + chars[i + 1]!);
      }
    } else if (word.length <= 100) found.add(word);
  }
  return [...found].sort();
}
