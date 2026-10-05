import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const versions = JSON.parse(readFileSync('versions.lock', 'utf8')) as { zcashDevtool: { revision: string; binary: string } };
for (const [name, command, args] of [
  ['Node', 'node', ['--version']], ['pnpm', 'pnpm', ['--version']],
  ['Rust', 'rustc', ['--version']], ['Cargo', 'cargo', ['--version']],
  ['SQLite', 'sqlite3', ['--version']], ['Protobuf', 'protoc', ['--version']],
] as const) {
  const result = spawnSync(command, [...args], { encoding: 'utf8' });
  console.log(`${name}: ${result.status === 0 ? result.stdout.trim() : 'missing'}`);
  if (result.status !== 0) process.exitCode = 1;
}
console.log(`zcash-devtool source pin: ${versions.zcashDevtool.revision}`);
console.log(`zcash-devtool binary: ${existsSync(versions.zcashDevtool.binary) ? 'installed (run help to verify interfaces)' : 'not installed'}`);
if (!existsSync(versions.zcashDevtool.binary)) process.exitCode = 1;
console.log('No wallet keys, seed phrases, or account data were inspected.');
