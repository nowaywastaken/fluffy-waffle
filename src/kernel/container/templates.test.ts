import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SANDBOX_TEMPLATES, buildConfig } from './templates.ts';

describe('Sandbox templates', () => {
  it('all four templates exist', () => {
    assert.ok(SANDBOX_TEMPLATES['ai-provider']);
    assert.ok(SANDBOX_TEMPLATES['code-executor']);
    assert.ok(SANDBOX_TEMPLATES['policy-sandbox']);
    assert.ok(SANDBOX_TEMPLATES['integration-test']);
  });

  it('policy-sandbox has 100ms max_duration', () => {
    assert.equal(SANDBOX_TEMPLATES['policy-sandbox']?.max_duration, 100);
  });

  it('code-executor has network_mode none', () => {
    assert.equal(SANDBOX_TEMPLATES['code-executor']?.network_mode, 'none');
  });

  it('ai-provider uses strict seccomp', () => {
    assert.equal(SANDBOX_TEMPLATES['ai-provider']?.seccomp_profile, 'strict');
  });

  it('integration-test uses standard-net seccomp', () => {
    assert.equal(SANDBOX_TEMPLATES['integration-test']?.seccomp_profile, 'standard-net');
  });

  it('buildConfig merges template with overrides', () => {
    const config = buildConfig('code-executor', {
      plugin_name: 'test-plugin',
      container_id: 'fw-sandbox-abc',
      image: 'my-image:latest',
      mounts: [],
      output_volume: 'vol-abc',
    });
    assert.equal(config.network_mode, 'none');
    assert.equal(config.image, 'my-image:latest');
    assert.equal(config.seccomp_profile, 'standard');
  });

  it('buildConfig throws on unknown template', () => {
    assert.throws(
      () => buildConfig('unknown-template', {} as any),
      /Unknown template/,
    );
  });
});
