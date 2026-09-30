import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchCommand } from '../src/launch.js';
import { resolveClaudeBinary } from '../src/claude-binary.js';

test('an executable is started as it is, on every platform', () => {
  assert.deepEqual(launchCommand('/usr/local/bin/claude', ['-p'], { platform: 'darwin' }), { command: '/usr/local/bin/claude', args: ['-p'] });
  assert.deepEqual(launchCommand('C:\\bin\\claude.exe', ['-p'], { platform: 'win32' }), { command: 'C:\\bin\\claude.exe', args: ['-p'] });
});

test('a JavaScript file is started with node, so no execute bit or shebang is needed', () => {
  assert.deepEqual(launchCommand('/x/agent.js', ['--settings', '{}'], { platform: 'linux', node: '/node' }), { command: '/node', args: ['/x/agent.js', '--settings', '{}'] });
});

test("on Windows, npm's claude.cmd shim is started as node and the script it points at, avoiding cmd.exe quoting", () => {
  const shim = [
    '@ECHO off',
    'GOTO start',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n');
  const result = launchCommand('C:\\npm\\claude.cmd', ['-p', '{"a": 1}'], { platform: 'win32', node: 'C:\\node.exe', readFile: () => shim });
  assert.deepEqual(result, { command: 'C:\\node.exe', args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '-p', '{"a": 1}'] });
  assert.throws(() => launchCommand('C:\\npm\\claude.cmd', [], { platform: 'win32', readFile: () => '@echo off\r\nsomething.exe %*' }), /claude\.exe/);
});

test('on Windows, claude is found through PATHEXT', () => {
  const exists = new Set(['C:\\tools\\claude.CMD']);
  const found = resolveClaudeBinary({ PATH: 'C:\\empty;C:\\tools', PATHEXT: '.COM;.EXE;.CMD' }, { platform: 'win32', isFile: (path) => exists.has(path) });
  assert.equal(found, 'C:\\tools\\claude.CMD');
});
