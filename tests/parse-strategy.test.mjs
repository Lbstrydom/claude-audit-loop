import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSecurityStrategy } from '../scripts/security-memory/parse-strategy.mjs';

describe('parseSecurityStrategy — basics', () => {
  it('empty input → empty everything', () => {
    const r = parseSecurityStrategy('');
    assert.deepEqual(r, { incidents: [], threatModel: null, warnings: [] });
  });

  it('null/undefined input → empty everything', () => {
    assert.deepEqual(parseSecurityStrategy(null),      { incidents: [], threatModel: null, warnings: [] });
    assert.deepEqual(parseSecurityStrategy(undefined), { incidents: [], threatModel: null, warnings: [] });
  });

  it('extracts threat model section', () => {
    const md = `# Sec\n\n## Threat model\nPCI scope, retail attackers.\n\n## Incidents\n`;
    const r = parseSecurityStrategy(md);
    assert.match(r.threatModel || '', /PCI scope/);
  });

  it('R-Gemini-G5 — extracts threat model when it is the LAST section (no trailing ## heading)', () => {
    // Without the JS end-of-string fix, the lookahead would only
    // terminate on another `## ` heading; if threat model is the final
    // section, extraction silently failed (the literal 'Z' bug).
    const md = `# Sec\n\n## Threat model\nPCI scope, no Z anywhere here.`;
    const r = parseSecurityStrategy(md);
    assert.match(r.threatModel || '', /PCI scope, no Z anywhere here/);
  });

  it('parses single well-formed incident', () => {
    const md = `## Incidents\n<!-- incident:start id="INC-001" -->
**Description**: Debug log leaked credit-card numbers.
**Affected paths**: \`src/billing/**\`, \`src/checkout/stripe.js\`
**Mitigation**: \`semgrep:no-payment-logs\`
**Lessons learned**: Always redact payment payloads before logging.
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 1);
    const i = r.incidents[0];
    assert.equal(i.incident_id, 'INC-001');
    assert.match(i.description, /Debug log/);
    assert.deepEqual(i.affected_paths, ['src/billing/**', 'src/checkout/stripe.js']);
    assert.equal(i.mitigation_ref, 'semgrep:no-payment-logs');
    assert.equal(i.mitigation_kind, 'semgrep');
    assert.match(i.lessons_learned, /redact payment/);
    assert.match(i.source_fingerprint, /^[a-f0-9]{16}$/);
  });
});

describe('parseSecurityStrategy — field handling (R1-H4)', () => {
  it('missing description → entry SKIPPED with warning, not crashed', () => {
    const md = `<!-- incident:start id="INC-002" -->
**Mitigation**: manual
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 0);
    assert.ok(r.warnings.some(w => w.kind === 'missing-description'));
  });

  it('missing id → entry SKIPPED', () => {
    const md = `<!-- incident:start id="" -->
**Description**: oops
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 0);
    assert.ok(r.warnings.some(w => w.kind === 'missing-id'));
  });

  it('description present, optional fields missing → entry persists', () => {
    const md = `<!-- incident:start id="INC-003" -->
**Description**: Just a description, nothing else.
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 1);
    assert.deepEqual(r.incidents[0].affected_paths, []);
    assert.equal(r.incidents[0].mitigation_ref, null);
    assert.equal(r.incidents[0].mitigation_kind, 'manual');
    assert.equal(r.incidents[0].lessons_learned, null);
  });
});

describe('parseSecurityStrategy — mitigation_kind derivation (R2-M2)', () => {
  function inc(mitigation) {
    const md = `<!-- incident:start id="INC-X" -->
**Description**: x
**Mitigation**: ${mitigation}
<!-- incident:end -->`;
    return parseSecurityStrategy(md).incidents[0];
  }

  it('semgrep with simple id → semgrep', () => {
    assert.equal(inc('semgrep:my-rule').mitigation_kind, 'semgrep');
  });

  it('semgrep with slashes/dots/namespace (Gemini-r2-G3) → semgrep', () => {
    assert.equal(inc('semgrep:p/owasp-top-ten').mitigation_kind, 'semgrep');
    assert.equal(inc('semgrep:python.lang.security.audit.dangerous-system-call').mitigation_kind, 'semgrep');
    assert.equal(inc('semgrep:r/typescript.express').mitigation_kind, 'semgrep');
  });

  it('file path → file-ref', () => {
    assert.equal(inc('scripts/lib/redact.mjs').mitigation_kind, 'file-ref');
  });

  it('"manual" → manual', () => {
    assert.equal(inc('manual').mitigation_kind, 'manual');
  });

  it('"MANUAL" case-insensitive → manual', () => {
    assert.equal(inc('MANUAL').mitigation_kind, 'manual');
  });
});

describe('parseSecurityStrategy — fingerprint stability', () => {
  it('identical content → identical fingerprint', () => {
    const md = `<!-- incident:start id="INC-A" -->
**Description**: same
<!-- incident:end -->`;
    const a = parseSecurityStrategy(md).incidents[0];
    const b = parseSecurityStrategy(md).incidents[0];
    assert.equal(a.source_fingerprint, b.source_fingerprint);
  });

  it('changed description → different fingerprint', () => {
    const a = parseSecurityStrategy(`<!-- incident:start id="INC-A" -->
**Description**: original
<!-- incident:end -->`).incidents[0];
    const b = parseSecurityStrategy(`<!-- incident:start id="INC-A" -->
**Description**: edited
<!-- incident:end -->`).incidents[0];
    assert.notEqual(a.source_fingerprint, b.source_fingerprint);
  });

  it('CRLF normalised — same fingerprint as LF', () => {
    const lf = `<!-- incident:start id="INC-A" -->\n**Description**: x\n<!-- incident:end -->`;
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = parseSecurityStrategy(lf).incidents[0];
    const b = parseSecurityStrategy(crlf).incidents[0];
    assert.equal(a.source_fingerprint, b.source_fingerprint);
  });
});

describe('parseSecurityStrategy — duplicate IDs (R-Gemini-G2)', () => {
  it('keeps first occurrence, warns on duplicate', () => {
    const md = `<!-- incident:start id="INC-DUP" -->
**Description**: first
<!-- incident:end -->
<!-- incident:start id="INC-DUP" -->
**Description**: second (should be skipped)
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 1);
    assert.equal(r.incidents[0].description, 'first');
    assert.ok(r.warnings.some(w => w.kind === 'duplicate-id'));
  });
});

describe('parseSecurityStrategy — Gemini final-review fixes', () => {
  it('R-Gemini-G3 — newline-separated path list parses (was: silently mangled)', () => {
    const md = `<!-- incident:start id="INC-N1" -->
**Description**: paths on multiple lines
**Affected paths**:
\`src/billing/foo.js\`
\`src/checkout/bar.js\`
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 1);
    assert.deepEqual(r.incidents[0].affected_paths, ['src/billing/foo.js', 'src/checkout/bar.js']);
  });

  it('R-Gemini-G4 — **Bold**: inside description does NOT eat trailing content', () => {
    const md = `<!-- incident:start id="INC-N2" -->
**Description**: Logged credit cards. **Warning**: never log raw payloads even at debug level.
**Mitigation**: \`semgrep:no-payment-logs\`
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 1);
    // The bold-inside-description must not split the description into a
    // truncated description + a "Warning" pseudo-field; full text survives.
    assert.match(r.incidents[0].description, /never log raw payloads/);
    assert.equal(r.incidents[0].mitigation_ref, 'semgrep:no-payment-logs');
  });

  it('R-Gemini-G7 — line-starting **Note**: inside lessons body does NOT split the field', () => {
    // Earlier R-Gemini-G4 fix only handled the inline case; a paragraph
    // break followed by an unrecognised bold label would still terminate
    // the field. With label-whitelisting, only Description/Affected/
    // Mitigation/Lessons act as boundaries — anything else is body text.
    const md = `<!-- incident:start id="INC-N3" -->
**Description**: tiny intro
**Lessons learned**: First paragraph of lesson.

**Note**: this is still part of the lesson, not a new field.
**Important**: also still part of the lesson body.
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 1);
    assert.match(r.incidents[0].lessons_learned || '', /still part of the lesson, not a new field/);
    assert.match(r.incidents[0].lessons_learned || '', /also still part of the lesson body/);
  });
});

describe('parseSecurityStrategy — robustness', () => {
  it('multiple well-formed entries → all parsed', () => {
    const md = `
<!-- incident:start id="INC-1" -->
**Description**: one
<!-- incident:end -->
<!-- incident:start id="INC-2" -->
**Description**: two
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 2);
    assert.deepEqual(r.incidents.map(i => i.incident_id).sort(), ['INC-1', 'INC-2']);
  });

  it('one malformed entry doesn\'t kill siblings', () => {
    const md = `
<!-- incident:start id="INC-GOOD" -->
**Description**: good entry
<!-- incident:end -->
<!-- incident:start id="INC-BAD" -->
**Mitigation**: missing description!
<!-- incident:end -->
<!-- incident:start id="INC-GOOD2" -->
**Description**: another good
<!-- incident:end -->`;
    const r = parseSecurityStrategy(md);
    assert.equal(r.incidents.length, 2, 'two good incidents survive');
    assert.equal(r.warnings.filter(w => w.kind === 'missing-description').length, 1);
  });
});
