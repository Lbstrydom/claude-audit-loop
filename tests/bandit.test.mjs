import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { PromptBandit, computeReward } from '../scripts/bandit.mjs';

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bandit-test-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── PromptBandit ────────────────────────────────────────────────────────────

describe('PromptBandit', () => {
  it('registers and selects arms', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('backend', 'v1');
    bandit.addArm('backend', 'v2');
    const selected = bandit.select('backend');
    assert.ok(selected);
    assert.equal(selected.passName, 'backend');
  });

  it('returns null for unknown pass', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    assert.equal(bandit.select('nonexistent'), null);
  });

  it('returns single arm when only one exists', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('structure', 'default');
    const arm = bandit.select('structure');
    assert.equal(arm.variantId, 'default');
  });

  it('updates arm with proper Beta posterior', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'v1');
    // Initial: alpha=1, beta=1
    bandit.update('test', 'v1', 0.8);
    const arm = bandit.arms['test:v1'];
    // alpha should increase by 0.8, beta by 0.2
    assert.ok(Math.abs(arm.alpha - 1.8) < 0.001, `alpha should be 1.8, got ${arm.alpha}`);
    assert.ok(Math.abs(arm.beta - 1.2) < 0.001, `beta should be 1.2, got ${arm.beta}`);
    assert.equal(arm.pulls, 1);
  });

  it('clamps reward to [0,1]', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'v1');
    bandit.update('test', 'v1', 1.5); // Should clamp to 1.0
    const arm = bandit.arms['test:v1'];
    assert.ok(Math.abs(arm.alpha - 2.0) < 0.001); // 1 + 1.0
    assert.ok(Math.abs(arm.beta - 1.0) < 0.001);  // 1 + 0.0
  });

  it('update with reward=0 increments only beta', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'v1');
    bandit.update('test', 'v1', 0);
    const arm = bandit.arms['test:v1'];
    assert.ok(Math.abs(arm.alpha - 1.0) < 0.001);
    assert.ok(Math.abs(arm.beta - 2.0) < 0.001);
  });

  it('does not duplicate arms on re-add', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('pass', 'v1');
    bandit.addArm('pass', 'v1');
    assert.equal(Object.keys(bandit.arms).length, 1);
  });

  it('flush writes state to disk', () => {
    const statePath = path.join(tmpDir, 'state.json');
    const b1 = new PromptBandit(statePath);
    b1.addArm('test', 'v1');
    b1.update('test', 'v1', 0.7);
    b1.flush();

    const b2 = new PromptBandit(statePath);
    const arm = b2.arms['test:v1'];
    assert.ok(arm);
    assert.equal(arm.pulls, 1);
    assert.ok(Math.abs(arm.alpha - 1.7) < 0.001);
  });

  it('getStats returns sorted by estimated rate', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'good');
    bandit.addArm('test', 'bad');
    // Give 'good' better stats
    for (let i = 0; i < 5; i++) bandit.update('test', 'good', 0.9);
    for (let i = 0; i < 5; i++) bandit.update('test', 'bad', 0.1);
    bandit.flush();
    const stats = bandit.getStats();
    assert.equal(stats[0].variant, 'good');
  });

  it('hasConverged returns false with too few pulls', () => {
    const bandit = new PromptBandit(path.join(tmpDir, 'state.json'));
    bandit.addArm('test', 'v1');
    bandit.addArm('test', 'v2');
    assert.equal(bandit.hasConverged('test'), false);
  });
});

// ── computeReward ───────────────────────────────────────────────────────────

describe('computeReward', () => {
  it('returns high reward for accepted + sustained HIGH finding', () => {
    const reward = computeReward({
      claude_position: 'accept',
      gpt_ruling: 'sustain',
      final_severity: 'HIGH'
    });
    assert.ok(reward > 0.8, `Expected > 0.8, got ${reward}`);
  });

  it('returns zero for challenged + overruled', () => {
    const reward = computeReward({
      claude_position: 'challenge',
      gpt_ruling: 'overrule',
      final_severity: 'HIGH'
    });
    assert.equal(reward, 0);
  });

  it('returns moderate reward for compromise', () => {
    const reward = computeReward({
      claude_position: 'partial_accept',
      gpt_ruling: 'compromise',
      final_severity: 'MEDIUM'
    });
    assert.ok(reward > 0 && reward < 0.8);
  });

  it('LOW severity reduces reward', () => {
    const high = computeReward({ claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'HIGH' });
    const low = computeReward({ claude_position: 'accept', gpt_ruling: 'sustain', final_severity: 'LOW' });
    assert.ok(low < high);
  });
});
