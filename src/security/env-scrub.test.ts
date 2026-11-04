import assert from 'node:assert/strict';
import test from 'node:test';
import { collectSecretsFromEnv, redactSecretsFromText } from './env-scrub.js';

test('every secret-named value is redacted, not just the 20 longest', () => {
  const values = Array.from({ length: 25 }, (_, i) => `key${i}-` + 'x'.repeat(20 + i));
  const env: Record<string, string> = {};
  values.forEach((value, i) => { env[`MY_SERVICE_${i}_API_KEY`] = value; });

  const secrets = collectSecretsFromEnv(env);

  for (const value of values) {
    assert.ok(secrets.includes(value), `missing secret #${values.indexOf(value)}`);
    assert.ok(!redactSecretsFromText(`token=${value}`, secrets).includes(value));
  }
});
