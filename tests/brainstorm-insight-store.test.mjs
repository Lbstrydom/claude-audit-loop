/**
 * Tests for scripts/lib/brainstorm/insight-store.mjs
 * Plan ACs: AC31, AC32, §11.H slug split, §12.G slug discovery, §14.B null-safe, §14.D yaml escape, §16.B sid validation.
 * Audit-code R1 fixes: H3 sid validation, H10 scoped queries, H15 lock, M14 error handling, L2 per-entry try/catch.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'yaml';
import {
  slugifyTopic,
  resolveUniqueSlug,
  findExistingSlugForTopic,
  parseFrontmatter,
  saveInsight,
  listInsightsByTopic,
  listAllInsights,
} from '../scripts/lib/brainstorm/insight-store.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brainstorm-insight-'));
}

describe('slugifyTopic — pure deterministic', () => {
  it('"How to do X?" → "how-to-do-x"', () => {
    assert.equal(slugifyTopic('How to do X?'), 'how-to-do-x');
  });

  it('repeatable (same input → same output)', () => {
    assert.equal(slugifyTopic('Foo Bar Baz'), slugifyTopic('Foo Bar Baz'));
  });

  it('handles empty / weird input → "untitled"', () => {
    assert.equal(slugifyTopic(''), 'untitled');
    assert.equal(slugifyTopic('!!!'), 'untitled');
  });

  it('truncates to MAX_SLUG_LEN (60)', () => {
    const long = 'a'.repeat(200);
    assert.equal(slugifyTopic(long).length, 60);
  });
});

describe('resolveUniqueSlug — collision-aware', () => {
  it('returns base when no collision', () => {
    const root = mkTmp();
    assert.equal(resolveUniqueSlug('foo', root), 'foo');
  });

  it('appends -2 on collision', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'foo'));
    assert.equal(resolveUniqueSlug('foo', root), 'foo-2');
  });

  it('appends -3 when -2 also exists', () => {
    const root = mkTmp();
    fs.mkdirSync(path.join(root, 'foo'));
    fs.mkdirSync(path.join(root, 'foo-2'));
    assert.equal(resolveUniqueSlug('foo', root), 'foo-3');
  });
});

describe('findExistingSlugForTopic — slug rediscovery (§12.G)', () => {
  it('returns null when no insight directories exist', () => {
    const root = mkTmp();
    assert.equal(findExistingSlugForTopic('any topic', root), null);
  });

  it('finds previously-allocated collision slug for same exact topic', async () => {
    const root = mkTmp();
    await saveInsight({ sid: 's1', round: 0, topic: 'How to do X?', insightText: 'first', root });
    await saveInsight({ sid: 's2', round: 0, topic: 'how-to-do-X (different)', insightText: 'second', root });
    const slug = findExistingSlugForTopic('How to do X?', root);
    assert.equal(slug, 'how-to-do-x', 'must find original slug, not allocate new one');
  });

  it('§14.B null-safe — directory with only non-.md files (.DS_Store) does not crash', () => {
    const root = mkTmp();
    const slug = slugifyTopic('foo');
    const dir = path.join(root, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.DS_Store'), '');
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    const result = findExistingSlugForTopic('foo', root);
    assert.equal(result, null);
  });
});

describe('saveInsight — happy path + idempotency', () => {
  it('writes a markdown file with valid YAML frontmatter', async () => {
    const root = mkTmp();
    const r = await saveInsight({ sid: 's1', round: 0, topic: 'My topic', insightText: 'My insight body', root });
    assert.ok(fs.existsSync(r.path));
    assert.equal(r.created, true);
    const content = fs.readFileSync(r.path, 'utf-8');
    const fm = parseFrontmatter(content);
    assert.equal(fm.sid, 's1');
    assert.equal(fm.round, 0);
    assert.equal(fm.topic, 'My topic');
    assert.equal(fm.body.trim(), 'My insight body');
  });

  it('AC32 idempotency — same content twice → 1 file', async () => {
    const root = mkTmp();
    const r1 = await saveInsight({ sid: 's1', round: 0, topic: 'T', insightText: 'I', root });
    const r2 = await saveInsight({ sid: 's1', round: 0, topic: 'T', insightText: 'I', root });
    assert.equal(r1.path, r2.path);
    assert.equal(r2.created, false);
    const dir = path.dirname(r1.path);
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
    assert.equal(files.length, 1);
  });

  it('different content → new file (different content hash)', async () => {
    const root = mkTmp();
    const r1 = await saveInsight({ sid: 's1', round: 0, topic: 'T', insightText: 'first', root });
    const r2 = await saveInsight({ sid: 's1', round: 0, topic: 'T', insightText: 'second', root });
    assert.notEqual(r1.path, r2.path);
    assert.equal(r2.created, true);
  });
});

describe('saveInsight — validation', () => {
  it('rejects empty topic', async () => {
    const root = mkTmp();
    await assert.rejects(saveInsight({ sid: 's', round: 0, topic: '', insightText: 'x', root }), /topic must be 1\.\./);
  });

  it('rejects body too long', async () => {
    const root = mkTmp();
    await assert.rejects(saveInsight({ sid: 's', round: 0, topic: 't', insightText: 'x'.repeat(3000), root }), /insightText must be 1\.\./);
  });

  it('rejects negative round', async () => {
    const root = mkTmp();
    await assert.rejects(saveInsight({ sid: 's', round: -1, topic: 't', insightText: 'x', root }), /round must be non-negative integer/);
  });

  it('R1-H3 — rejects sid containing path-traversal segments', async () => {
    const root = mkTmp();
    await assert.rejects(saveInsight({ sid: '../etc/passwd', round: 0, topic: 't', insightText: 'x', root }), /must match/);
  });

  it('R1-H3 — rejects sid containing slashes', async () => {
    const root = mkTmp();
    await assert.rejects(saveInsight({ sid: 'a/b', round: 0, topic: 't', insightText: 'x', root }), /must match/);
  });
});

describe('AC62 §14.D — YAML safety with shell-special characters in topic', () => {
  it('topic containing colon, quote, newline serialises and round-trips', async () => {
    const root = mkTmp();
    const tricky = 'Topic: with "quotes"\nand newline';
    const r = await saveInsight({ sid: 's', round: 0, topic: tricky, insightText: 'body', root });
    const content = fs.readFileSync(r.path, 'utf-8');
    const m = content.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(m, 'frontmatter block must be present');
    const fm = yaml.parse(m[1]);
    assert.equal(fm.topic, tricky, 'topic must round-trip identical despite special chars');
  });
});

describe('R1-H10/M10 — scoped vs all-discovery semantics', () => {
  it('listInsightsByTopic returns [] for unknown topic (does not fall back to all-scan)', async () => {
    const root = mkTmp();
    await saveInsight({ sid: 's1', round: 0, topic: 'topicA', insightText: 'a', root });
    await saveInsight({ sid: 's1', round: 0, topic: 'topicB', insightText: 'b', root });
    const result = listInsightsByTopic('nonexistent topic', { root });
    assert.equal(result.length, 0, 'unknown topic must yield empty result, not all topics');
  });

  it('listAllInsights returns insights from all topics', async () => {
    const root = mkTmp();
    await saveInsight({ sid: 's1', round: 0, topic: 'topicA', insightText: 'a', root });
    await saveInsight({ sid: 's1', round: 0, topic: 'topicB', insightText: 'b', root });
    const all = listAllInsights({ root });
    assert.equal(all.length, 2);
  });

  it('listInsightsByTopic returns matching topic only', async () => {
    const root = mkTmp();
    await saveInsight({ sid: 's1', round: 0, topic: 'topicA', insightText: 'a', root });
    await saveInsight({ sid: 's1', round: 0, topic: 'topicB', insightText: 'b', root });
    const result = listInsightsByTopic('topicA', { root });
    assert.equal(result.length, 1);
    assert.equal(result[0].frontmatter.topic, 'topicA');
  });

  it('listInsightsByTopic throws on missing topic argument', () => {
    assert.throws(() => listInsightsByTopic(), /topic required/);
    assert.throws(() => listInsightsByTopic(null), /topic required/);
  });
});
