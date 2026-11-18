#!/usr/bin/env node
// Native-only build entry point. Build the frontend separately before packaging.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const android = fileURLToPath(new URL('.', import.meta.url));
const [mode = 'debug', ...flags] = process.argv.slice(2);
const modes = {
  debug: [':app:assembleDebug'],
  preview: [':app:assembleRelease', '-PsignCompatiblePreview=true'],
  test: [':app:testDebugUnitTest', '-x', ':app:syncWebAssets'],
  lint: [':app:lintDebug'],
};
if (!Object.hasOwn(modes, mode) || flags.some((arg) => !['--offline', '--no-daemon', '--stacktrace'].includes(arg))) {
  console.error('Usage: node android/build.mjs [debug|preview|test|lint] [--offline] [--no-daemon] [--stacktrace]');
  process.exit(2);
}
const env = { ...process.env };
// Keep downloaded tools/dependencies inside this checkout, never change machine settings.
env.GRADLE_USER_HOME ||= path.join(android, '.tools', 'gradle-home');
env.ANDROID_USER_HOME ||= path.join(android, '.tools', 'android-user');
if (process.platform === 'win32') {
  if (!env.JAVA_HOME && existsSync('D:/dev/jdk-21/bin/java.exe')) env.JAVA_HOME = 'D:/dev/jdk-21';
  if (!env.ANDROID_HOME && !env.ANDROID_SDK_ROOT && existsSync('D:/dev/android-sdk/platforms')) {
    env.ANDROID_HOME = 'D:/dev/android-sdk';
  }
}
const args = [...modes[mode], '--console=plain', ...flags];
const result = process.platform === 'win32'
  ? spawnSync(env.ComSpec || 'cmd.exe', ['/d', '/c', 'gradlew.bat', ...args], { cwd: android, env, stdio: 'inherit' })
  : spawnSync('./gradlew', args, { cwd: android, env, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
