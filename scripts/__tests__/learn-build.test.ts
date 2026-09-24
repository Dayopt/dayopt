import { describe, expect, it } from 'vitest';

import { FAILURE_TAGS, JOURNEY_GROUPS, REPO_BLOB_URL, type LearnData } from '../lib/learn/data.ts';
import { buildLearnHtml } from '../tasks/learn.ts';

const data: LearnData = {
  repo: REPO_BLOB_URL,
  tags: FAILURE_TAGS,
  groups: JOURNEY_GROUPS,
  services: {},
  outages: { title: 't', intro: 'i', features: [], items: [] },
  screens: { title: 't', intro: 'i', columns: [], nodes: [], edges: [] },
  scenarios: [],
};

describe('buildLearnHtml', () => {
  it('prettier が別の行へ折った placeholder も data で置き換える', () => {
    const template =
      '<script type="application/json" id="learn-data">\n  __LEARN_DATA__\n</script>';
    const html = buildLearnHtml(template, data);
    expect(html).not.toContain('__LEARN_DATA__');
    expect(html).toContain('"repo":"https://github.com/Dayopt/dayopt/blob/main/"');
  });

  it('data 中の </script> で script 要素を閉じさせない', () => {
    const template = '<script type="application/json" id="learn-data">__LEARN_DATA__</script>';
    const html = buildLearnHtml(template, {
      ...data,
      outages: { ...data.outages, intro: '</script><b>' },
    });
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain('\\u003c/script>');
  });

  it('placeholder が無い template は throw する', () => {
    expect(() => buildLearnHtml('<html></html>', data)).toThrow('placeholder');
  });
});
