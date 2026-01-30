export type Section = {
  title: string;
  start: number; // char index in full text
  end: number; // char index in full text
};

function isMostlyUppercase(s: string): boolean {
  const letters = s.replace(/[^A-Za-z]/g, "");
  if (letters.length < 4) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length > 0.8;
}

function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Non-fiction oriented section detection.
// Targets headings like:
//   1. Introduction
//   2 Methods
//   3) Results
//   10.3 Subsection (optional)
// Also supports some common variants like PART I, APPENDIX.
export function detectSections(text: string): Section[] {
  const lines = text.split(/\r?\n/);

  const candidates: Array<{ title: string; start: number }> = [];

  // Track running char offset of each line start
  let offset = 0;
  const lineStarts: number[] = [];
  for (const line of lines) {
    lineStarts.push(offset);
    offset += line.length + 1; // assume \n
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const line = raw.trim();
    if (!line) continue;

    // Filter obviously-long sentences.
    if (line.length > 90) continue;

    const prevBlank = i === 0 ? true : (lines[i - 1]?.trim().length ?? 0) === 0;
    const nextBlank = i + 1 >= lines.length ? true : (lines[i + 1]?.trim().length ?? 0) === 0;

    // Require some separation to reduce false positives.
    if (!(prevBlank || nextBlank)) continue;

    // 1. Title / 1) Title / 1 Title
    const m1 = line.match(/^(\d{1,3})(?:\.(\d{1,3}))?(?:\.(\d{1,3}))?[).\s]+(.+)$/);
    if (m1) {
      const titlePart = normalizeTitle(m1[4] ?? "");
      if (titlePart.length >= 3) {
        candidates.push({ title: normalizeTitle(line), start: lineStarts[i] });
        continue;
      }
    }

    // PART / APPENDIX / INTRODUCTION style (all caps headings)
    if (isMostlyUppercase(line) && line.length >= 5 && line.length <= 60) {
      if (/^(PART|APPENDIX|PREFACE|INTRODUCTION|CONCLUSION)\b/i.test(line)) {
        candidates.push({ title: normalizeTitle(line), start: lineStarts[i] });
        continue;
      }
    }
  }

  // De-dupe by start and enforce increasing order
  candidates.sort((a, b) => a.start - b.start);
  const uniq: typeof candidates = [];
  for (const c of candidates) {
    if (uniq.length === 0 || uniq[uniq.length - 1]!.start !== c.start) uniq.push(c);
  }

  // If no candidates found, return a single section.
  if (uniq.length === 0) return [{ title: "Full text", start: 0, end: text.length }];

  // Build sections with end boundaries.
  const sections: Section[] = [];
  for (let i = 0; i < uniq.length; i++) {
    const start = uniq[i]!.start;
    const end = i + 1 < uniq.length ? uniq[i + 1]!.start : text.length;
    if (end - start < 50) continue; // ignore tiny sections
    sections.push({ title: uniq[i]!.title, start, end });
  }

  // Ensure we cover leading text before first heading.
  if (sections.length && sections[0]!.start > 0) {
    sections.unshift({ title: "Start", start: 0, end: sections[0]!.start });
  }

  return sections;
}
