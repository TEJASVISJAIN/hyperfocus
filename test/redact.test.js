import assert from 'node:assert/strict';
import { test } from 'node:test';
import { redactSecrets } from '../src/redact.js';

test('well-known token formats are redacted', () => {
  const samples = [
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123',
    'sk-proj-abcdefghijklmnopqrstuvwxyz0123',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-1234567890-abcdefghijkl',
    'npm_abcdefghijklmnopqrstuvwxyz0123456789',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ];
  for (const secret of samples) assert.equal(redactSecrets(`token: ${secret} end`).includes(secret), false, secret);
});

test('values assigned to secret-sounding names are redacted, the names kept', () => {
  assert.equal(redactSecrets('DB_PASSWORD=correcthorsebattery'), 'DB_PASSWORD=[redacted]');
  assert.equal(redactSecrets('  "apiKey": "abc123def456",'), '  "apiKey": "[redacted]",');
  assert.equal(redactSecrets("client_secret: 'zzz999yyy888'"), "client_secret: '[redacted]'");
});

test('private key blocks are redacted whole', () => {
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(redactSecrets(`before\n${key}\nafter`), 'before\n[redacted]\nafter');
});

test('ordinary code is left alone', () => {
  const code = 'const tokenCount = tokens.length;\nif (password.length < 8) throw new Error("password too short");\nconst key = cache.get(id);';
  assert.equal(redactSecrets(code), code);
});

test('names that only start like a secret are left alone', () => {
  for (const code of ['"author": "tejasvi"', 'authDomain: "myapp.firebaseapp.com"', 'tokenizer: "whitespace-v2"', 'const tokenCount = "abcdefgh";']) {
    assert.equal(redactSecrets(code), code);
  }
});

test('bearer tokens, password flags and values with spaces are redacted', () => {
  assert.equal(redactSecrets('curl -H "Authorization: Bearer abcdef1234567890xyz"'), 'curl -H "Authorization: Bearer [redacted]"');
  assert.equal(redactSecrets('psql --password=hunter2222 db'), 'psql --password=[redacted] db');
  assert.equal(redactSecrets('mysql -u root -p"hunter2222"'), 'mysql -u root -p"[redacted]"');
  assert.equal(redactSecrets('"password": "correct horse battery"'), '"password": "[redacted]"');
  assert.equal(redactSecrets('clientSecret = "abc123def456"'), 'clientSecret = "[redacted]"');
  assert.equal(redactSecrets('export GITHUB_TOKEN=abcdef123456'), 'export GITHUB_TOKEN=[redacted]');
});
