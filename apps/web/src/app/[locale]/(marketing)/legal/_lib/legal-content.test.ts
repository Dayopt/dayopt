import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { getLegalDocument, readLegalDocumentFile } from './legal-content';

const temporaryDirectories: string[] = [];

function writeTemporaryLegalDocument(source: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dayopt-legal-test-'));
  temporaryDirectories.push(directory);
  const filePath = path.join(directory, 'document.mdx');
  fs.writeFileSync(filePath, source);
  return filePath;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('readLegalDocumentFile', () => {
  it('strict frontmatter と MDX content を返す', () => {
    const filePath = writeTemporaryLegalDocument(`---
title: Privacy
description: Description
lastUpdated: Last Updated
---

<PrivacyDocument data={{}} />
`);

    expect(readLegalDocumentFile(filePath)).toEqual({
      frontMatter: {
        title: 'Privacy',
        description: 'Description',
        lastUpdated: 'Last Updated',
      },
      content: '\n<PrivacyDocument data={{}} />\n',
    });
  });

  it('frontmatter の欠落と余分な field を明示的に失敗させる', () => {
    const missing = writeTemporaryLegalDocument(`---
title: Privacy
description: Description
---

Body
`);
    const extra = writeTemporaryLegalDocument(`---
title: Privacy
description: Description
lastUpdated: Last Updated
draft: false
---

Body
`);

    expect(() => readLegalDocumentFile(missing)).toThrow('lastUpdated');
    expect(() => readLegalDocumentFile(extra)).toThrow('Unrecognized key');
  });

  it('missing file と空 content を silent fallback しない', () => {
    const missing = path.join(os.tmpdir(), 'dayopt-legal-file-does-not-exist.mdx');
    const empty = writeTemporaryLegalDocument(`---
title: Privacy
description: Description
lastUpdated: Last Updated
---
`);

    expect(() => readLegalDocumentFile(missing)).toThrow('[Legal] Missing legal content');
    expect(() => readLegalDocumentFile(empty)).toThrow('[Legal] Empty legal content');
  });
});

describe('getLegalDocument', () => {
  it('指定 locale の文書を読み、別言語へ fallback しない', () => {
    expect(getLegalDocument('en', 'privacy').frontMatter.title).toBe('Privacy Policy');
    expect(getLegalDocument('ja', 'privacy').frontMatter.title).toBe('プライバシーポリシー');
  });

  it('問い合わせ配送providerと保持契約を両localeのprivacy文書へ保持する', () => {
    for (const locale of ['en', 'ja'] as const) {
      const { content } = getLegalDocument(locale, 'privacy');

      expect(content).toContain('contactData:');
      expect(content).toContain('resend:');
      expect(content).toContain('Email Routing');
      expect(content).toContain('google:');
      expect(content).toContain('Gmail');
      expect(content).toContain('billing:');
      expect(content).toContain('HUMAN-05');
      expect(content).not.toContain("github: 'GitHub");
    }
  });
});
