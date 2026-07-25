import packageJson from '../package.json' with { type: 'json' };
import { assertSemVer } from '../src/semver.ts';

assertSemVer(packageJson.version, 'package.json version');
const tag = process.env.GITHUB_REF_NAME || process.argv[2];
if (!tag) throw new Error('Provide a release tag or set GITHUB_REF_NAME.');
if (tag !== `v${packageJson.version}`) {
  throw new Error(`Release tag ${tag} does not match package.json version v${packageJson.version}.`);
}
console.log(`Release version ${packageJson.version} is valid.`);
