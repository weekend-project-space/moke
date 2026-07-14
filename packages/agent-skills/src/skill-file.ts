import { parseDocument, stringify } from 'yaml';

export type ParsedSkillFile = {
  name: string;
  description: string;
  content: string;
  metadata: Record<string, unknown>;
};

export function parseSkillFile(raw: string, fallbackName = ''): ParsedSkillFile {
  const normalized = raw.replace(/^\uFEFF/, '');
  const frontmatter = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!frontmatter) {
    const content = normalized.trim();
    return {
      name: fallbackName,
      description: firstParagraph(content),
      content,
      metadata: {},
    };
  }

  const document = parseDocument(frontmatter[1], { uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(document.errors.map((error) => error.message).join('; '));
  }

  const value = document.toJS();
  const metadata = isRecord(value) ? value : {};
  const content = frontmatter[2].trim();
  return {
    name: stringValue(metadata.name) || fallbackName,
    description: stringValue(metadata.description) || firstParagraph(content),
    content,
    metadata,
  };
}

export function serializeSkillFile(input: ParsedSkillFile) {
  const metadata = {
    ...input.metadata,
    name: input.name.trim(),
    description: input.description.trim(),
  };
  return `---\n${stringify(metadata).trimEnd()}\n---\n\n${input.content.trim()}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function firstParagraph(content: string) {
  return content
    .replace(/^# .+$/m, '')
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find(Boolean) || '';
}
